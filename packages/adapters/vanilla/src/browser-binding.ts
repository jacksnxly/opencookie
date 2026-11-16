import type {
  AccessPolicyResource,
  ConsentRuntimeTransitionEffect,
  EffectiveAccessPlan,
  OpenCookie,
  OpenCookieIdKind,
  OpenCookiePortContext,
} from "@opencookie-dev/core";
import {
  expandCategorySelection,
  resolvePolicyText,
  resolvePurposeDependencies,
  resolvePurposeSelection,
} from "@opencookie-dev/core/domain";
import {
  createAccessEnforcementReconciler,
  projectAccessEnforcementDecisions,
} from "@opencookie-dev/core/infrastructure";

import {
  canonicalDeclarativeIdentifier,
  createVanillaBrowserRuntime,
  VANILLA_DECLARATIVE_RESOURCE_SELECTOR,
  type VanillaBrowserRuntime,
  type VanillaDeclarativeResource,
} from "./browser-runtime.js";
import {
  assertBannerLinks,
  launcherReplacement,
  type MountedOpenCookie,
  type VanillaOpenCookieCopy,
  type VanillaOpenCookieLink,
} from "./mount.js";
import {
  composeVanillaProduct,
  createBrowserIdFallbackSequence,
  createVanillaBrowserClock,
  defaultBrowserIdGenerator,
  defaultBrowserStorage,
} from "./product-composition.js";
import { projectPolicyPresentation } from "./policy-presentation.js";
import { resolveDocument } from "./runtime-guards.js";

const NOT_MOUNTED_MESSAGE = "OpenCookie browser binding is not mounted.";
const ALREADY_MOUNTED_MESSAGE =
  "OpenCookie browser binding already has an active mount.";
const MOUNT_LOST_MESSAGE =
  "OpenCookie browser mount lost resource enforcement ownership.";
const AUTHORITY_LOST_MESSAGE =
  "OpenCookie browser resource start lost current consent authority.";
const DENIAL_PERSISTENCE_FAILED_MESSAGE =
  "OpenCookie could not persist fail-closed authority after its browser mount was lost.";

/** Deferred access reconciliation installed by a browser mount. @public */
export type OpenCookieBrowserReconcile = (
  effect: ConsentRuntimeTransitionEffect,
  context?: OpenCookiePortContext,
) => Promise<void>;

/** Browser storage methods deferred until a browser mount exists. @public */
export type OpenCookieBrowserStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

/**
 * Browser-owned ports used to construct one SSR-safe client.
 *
 * `storage` is for the client's decision store. When another tab changes a key
 * read or written through it, the mounted page adopts that decision in place.
 * It reloads only when the decision blocks or revokes something that may
 * already have run, when the stored record cannot be verified, or when this
 * page has a decision of its own in flight.
 *
 * @public
 */
export interface OpenCookieBrowserClientPorts {
  readonly idGenerator: (kind: OpenCookieIdKind) => string;
  readonly now: () => number;
  readonly reconcile: OpenCookieBrowserReconcile;
  readonly storage: OpenCookieBrowserStorage;
}

/** Construction options for a deferred browser binding. @public */
export interface CreateOpenCookieBrowserBindingOptions {
  readonly createClient: (ports: OpenCookieBrowserClientPorts) => OpenCookie;
  readonly now?: () => number;
}

/** Presentation and lifecycle options supplied only when a browser mounts. @public */
export interface OpenCookieBrowserMountOptions {
  readonly copy?: Partial<VanillaOpenCookieCopy>;
  readonly document?: Document;
  /**
   * `false` leaves out the floating launcher while the page carries its own
   * `data-oc-open-preferences` entry point. See the mount option.
   */
  readonly launcher?: boolean;
  /** Links shown in the banner, in the given order. */
  readonly links?: readonly VanillaOpenCookieLink[];
  readonly nonce?: string;
  readonly onError?: (error: unknown) => void;
}

/** One stable client with a single deferred browser lifecycle owner. @public */
export interface OpenCookieBrowserBinding {
  readonly client: OpenCookie;
  readonly mount: (
    options?: OpenCookieBrowserMountOptions,
  ) => MountedOpenCookie;
}

interface ActiveBrowserMount {
  accessAuthority?: BrowserAccessAuthority;
  readonly clock: (minimum?: number) => number;
  readonly generation: number;
  readonly idGenerator: (kind: OpenCookieIdKind) => string;
  readonly storage: OpenCookieBrowserStorage;
  enforceAccess?: (plan: EffectiveAccessPlan) => Promise<void>;
  reconcile?: OpenCookieBrowserReconcile;
  runtime?: VanillaBrowserRuntime;
}

interface BrowserAccessAuthority {
  readonly effect: ConsentRuntimeTransitionEffect;
  readonly revision: number;
}

function invalidPhysicalResource(resourceId: string, detail: string): never {
  throw new TypeError(`Declarative resource ${resourceId} ${detail}.`);
}

function validateDocumentResources(
  document: Document,
  resources: ReadonlyMap<string, AccessPolicyResource>,
): void {
  for (const source of document.querySelectorAll<HTMLElement>(
    VANILLA_DECLARATIVE_RESOURCE_SELECTOR,
  )) {
    const resourceId = canonicalDeclarativeIdentifier(
      source.dataset["ocResource"] ?? "",
      "Declarative resource identifier",
    );
    const categories = (source.dataset["ocCategory"] ?? "")
      .trim()
      .split(/\s+/u)
      .map((category) =>
        canonicalDeclarativeIdentifier(
          category,
          `Declarative resource ${resourceId} category`,
        ),
      );
    const resource = resources.get(resourceId);
    if (resource === undefined) {
      invalidPhysicalResource(
        resourceId,
        "is not present in the static resource policy",
      );
    }
    if (resource.access !== "optional") {
      invalidPhysicalResource(resourceId, "is not an optional resource");
    }
    for (const category of categories) {
      if (!resource.purposeIds.includes(category)) {
        invalidPhysicalResource(
          resourceId,
          `does not allow category ${category}`,
        );
      }
    }
  }
}

/**
 * Creates one browser-independent client and defers all DOM, storage, and
 * identifier access until `mount` installs the shared vanilla lifecycle.
 *
 * @public
 */
export function createOpenCookieBrowserBinding(
  options: CreateOpenCookieBrowserBindingOptions,
): OpenCookieBrowserBinding {
  const wallNow = options.now ?? Date.now;
  let activeMount: ActiveBrowserMount | undefined;
  const nextFallbackIdSequence = createBrowserIdFallbackSequence();
  let recoveryIdGenerator: ActiveBrowserMount["idGenerator"] | undefined;
  let recoveryStorage: OpenCookieBrowserStorage | undefined;
  let mountGeneration = 0;
  let authorityRevision = 0;
  let previousRuntimeCleanup = Promise.resolve();
  // The keys the client's store uses, so a mount can notice another tab
  // changing them.
  const decisionKeys = new Set<string>();
  const availableStorage = (): OpenCookieBrowserStorage | undefined =>
    activeMount?.storage ?? recoveryStorage;
  const requireAvailableStorage = (): OpenCookieBrowserStorage => {
    const storage = availableStorage();
    if (storage === undefined) throw new Error(NOT_MOUNTED_MESSAGE);
    return storage;
  };
  const requiresPhysicalGrant = (plan: EffectiveAccessPlan): boolean =>
    plan.resources.some(
      (resource) =>
        resource.access === "allowed" && resource.basis === "explicit-consent",
    );
  const authoritativeAccess = (
    effect: ConsentRuntimeTransitionEffect,
  ): {
    readonly plan: EffectiveAccessPlan;
    readonly snapshot: ReturnType<OpenCookie["getSnapshot"]>;
  } => {
    const snapshot = client.getSnapshot();
    return {
      plan:
        snapshot.pendingGrant?.transitionId === effect.transitionId
          ? effect.runtime.effectiveAccess
          : snapshot.runtime.effectiveAccess,
      snapshot,
    };
  };
  const reconcileAuthoritativeAccess = async (
    mount: ActiveBrowserMount,
    effect: ConsentRuntimeTransitionEffect,
    revision: number,
  ): Promise<void> => {
    const enforceAccess = mount.enforceAccess;
    if (enforceAccess === undefined) throw new Error(NOT_MOUNTED_MESSAGE);
    for (;;) {
      const authority = authoritativeAccess(effect);
      if (
        mount.accessAuthority === undefined ||
        mount.accessAuthority.revision <= revision
      ) {
        mount.accessAuthority = { effect, revision };
      }
      await enforceAccess(authority.plan);
      if (activeMount?.generation !== mount.generation) return;
      if (mount.accessAuthority.revision > revision) return;
      if (client.getSnapshot() === authority.snapshot) return;
    }
  };
  const reconcileAfterOwnerLoss = async (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
    revision = ++authorityRevision,
  ): Promise<void> => {
    for (;;) {
      const current = activeMount;
      if (current !== undefined) {
        await reconcileAuthoritativeAccess(current, effect, revision);
        if (activeMount?.generation === current.generation) return;
        continue;
      }
      if (recoveryIdGenerator === undefined) {
        throw new Error(NOT_MOUNTED_MESSAGE);
      }
      if (
        context === undefined &&
        requiresPhysicalGrant(effect.runtime.effectiveAccess)
      ) {
        throw new Error(NOT_MOUNTED_MESSAGE);
      }
      if (!requiresPhysicalGrant(authoritativeAccess(effect).plan)) return;
      if (context === undefined) throw new Error(NOT_MOUNTED_MESSAGE);
      const correction = await context.rejectAll();
      if (
        !("transition" in correction) ||
        correction.transition.persistenceStatus !== "confirmed"
      ) {
        throw new Error(DENIAL_PERSISTENCE_FAILED_MESSAGE);
      }
      if (requiresPhysicalGrant(client.getSnapshot().runtime.effectiveAccess)) {
        throw new Error(
          "OpenCookie could not establish fail-closed authority after its browser mount was lost.",
        );
      }
      return;
    }
  };
  const ports: OpenCookieBrowserClientPorts = Object.freeze({
    idGenerator: (kind: OpenCookieIdKind) => {
      const idGenerator = activeMount?.idGenerator ?? recoveryIdGenerator;
      if (idGenerator === undefined) throw new Error(NOT_MOUNTED_MESSAGE);
      return idGenerator(kind);
    },
    now: () => activeMount?.clock() ?? Reflect.apply(wallNow, undefined, []),
    reconcile: async (
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ) => {
      const revision = ++authorityRevision;
      const owner = activeMount;
      if (owner !== undefined) {
        owner.accessAuthority = {
          effect,
          revision,
        };
      }
      const reconcile = owner?.reconcile;
      if (owner === undefined || reconcile === undefined) {
        await reconcileAfterOwnerLoss(effect, context, revision);
        return;
      }
      try {
        await reconcile(effect, context);
      } catch (error) {
        if (activeMount?.generation === owner.generation) throw error;
        await reconcileAfterOwnerLoss(effect, context, revision);
        return;
      }
      if (activeMount?.generation === owner.generation) return;
      await reconcileAfterOwnerLoss(effect, context, revision);
    },
    storage: Object.freeze({
      getItem: (key: string) => {
        decisionKeys.add(key);
        return availableStorage()?.getItem(key) ?? null;
      },
      removeItem(key: string): void {
        decisionKeys.add(key);
        requireAvailableStorage().removeItem(key);
      },
      setItem(key: string, value: string): void {
        decisionKeys.add(key);
        requireAvailableStorage().setItem(key, value);
      },
    }),
  });
  const client = options.createClient(ports);
  const accessPolicy = client.getServerSnapshot().runtime.accessPolicy;
  if (!accessPolicy.valid) {
    throw new TypeError(
      "OpenCookie browser binding requires a valid static resource policy.",
    );
  }
  const resources = new Map(
    accessPolicy.resources.map((resource) => [resource.id, resource] as const),
  );
  const declarativeResources: readonly VanillaDeclarativeResource[] =
    accessPolicy.resources
      .filter((resource) => resource.access === "optional")
      .map((resource) => ({
        purposeIds: resource.purposeIds,
        resourceId: resource.id,
        serviceId: resource.serviceId,
      }));
  const optionalResourceIds = new Set(
    declarativeResources.map((resource) => resource.resourceId),
  );
  const knownPurposeIds = new Set(
    accessPolicy.purposes.map((purpose) => purpose.id),
  );

  const binding: OpenCookieBrowserBinding = {
    client,
    mount(mountOptions = {}): MountedOpenCookie {
      assertBannerLinks(mountOptions.links);
      const ownEntryPoint = launcherReplacement(mountOptions.launcher);
      if (activeMount !== undefined) throw new Error(ALREADY_MOUNTED_MESSAGE);
      const document = resolveDocument(
        mountOptions.document,
        "OpenCookie browser binding requires a browser document with a body.",
      );
      if (document.querySelector("body") === null) {
        throw new Error(
          "OpenCookie browser binding requires a browser document with a body.",
        );
      }
      const clock = createVanillaBrowserClock(document, wallNow);
      const storage = defaultBrowserStorage(document);
      const mount: ActiveBrowserMount = {
        clock,
        generation: ++mountGeneration,
        idGenerator: defaultBrowserIdGenerator(
          document,
          () => clock(),
          nextFallbackIdSequence,
        ),
        storage,
      };
      activeMount = mount;
      const readStoredDecision = (): Promise<string> =>
        Promise.resolve().then(() =>
          JSON.stringify(
            [...decisionKeys].map((key) => [key, storage.peek(key)]),
          ),
        );
      const precedingRuntimeCleanup = previousRuntimeCleanup;
      let runtime: VanillaBrowserRuntime;
      try {
        runtime = createVanillaBrowserRuntime({
          categoryDependencyResolver: resolvePurposeSelection,
          categoryResolver: expandCategorySelection,
          assertResourceStartAllowed: (resourceId) => {
            if (activeMount?.generation !== mount.generation) {
              throw new Error(MOUNT_LOST_MESSAGE);
            }
            const plan = mount.accessAuthority
              ? authoritativeAccess(mount.accessAuthority.effect).plan
              : client.getSnapshot().runtime.effectiveAccess;
            const currentAccess = plan.resources.find(
              (resource) => resource.resourceId === resourceId,
            );
            if (currentAccess?.access !== "allowed") {
              throw new Error(AUTHORITY_LOST_MESSAGE);
            }
          },
          ...(mountOptions.copy === undefined
            ? {}
            : { copy: mountOptions.copy }),
          ...(mountOptions.links === undefined
            ? {}
            : { links: mountOptions.links }),
          declarativeResources,
          document,
          knownPurposeIds,
          ...(mountOptions.nonce === undefined
            ? {}
            : { nonce: mountOptions.nonce }),
          ...(mountOptions.onError === undefined
            ? {}
            : { onError: mountOptions.onError }),
          ...(ownEntryPoint === undefined ? {} : { ownEntryPoint }),
          beforeResourceReconciliation: () => precedingRuntimeCleanup,
          prepareProduct:
            () =>
            ({ controllers, runWhileActive }) => {
              const accessReconciler = createAccessEnforcementReconciler({
                resources: controllers,
              });
              const failClosedDecisions = declarativeResources.map(
                ({ resourceId }) => ({
                  access: "blocked" as const,
                  resourceId,
                }),
              );
              const validationFailure = async (
                error: unknown,
              ): Promise<never> => {
                const result =
                  await accessReconciler.reconcile(failClosedDecisions);
                if (result.failures.length > 0) {
                  throw new Error(
                    `OpenCookie found invalid declarative resource markup and could not block ${String(result.failures.length)} known resource operation(s).`,
                    { cause: error },
                  );
                }
                throw error;
              };
              const enforce = (plan: EffectiveAccessPlan): Promise<void> =>
                runWhileActive(async () => {
                  try {
                    validateDocumentResources(document, resources);
                  } catch (error) {
                    await validationFailure(error);
                  }
                  const result = await accessReconciler.reconcile(
                    projectAccessEnforcementDecisions(plan).filter(
                      ({ resourceId }) => optionalResourceIds.has(resourceId),
                    ),
                  );
                  if (result.failures.length > 0) {
                    throw new Error(
                      `OpenCookie could not enforce ${String(result.failures.length)} declarative resource operation(s).`,
                    );
                  }
                });
              mount.reconcile = (effect) =>
                enforce(effect.runtime.effectiveAccess);
              mount.enforceAccess = enforce;
              return composeVanillaProduct({
                client,
                enforceCurrentAccess: () =>
                  enforce(client.getSnapshot().runtime.effectiveAccess),
                now: clock,
              });
            },
          purposeResolver: (policy, purposeId) =>
            resolvePurposeDependencies(policy, { [purposeId]: "granted" }),
          readStoredDecision,
          sectionResolver: projectPolicyPresentation,
          textResolver: resolvePolicyText,
          validateDeclarativeResources: () => {
            validateDocumentResources(document, resources);
          },
        });
        mount.runtime = runtime;
      } catch (error) {
        if (activeMount === mount) activeMount = undefined;
        throw error;
      }

      let destroyed = false;
      const ready = runtime.ready.then(() => {
        if (activeMount?.generation !== mount.generation) return;
        recoveryIdGenerator = mount.idGenerator;
        recoveryStorage = mount.storage;
      });
      return Object.freeze({
        destroy(): void {
          if (destroyed) return;
          destroyed = true;
          if (activeMount === mount) activeMount = undefined;
          runtime.destroy();
          previousRuntimeCleanup = runtime.destroyAndWait();
        },
        ready,
      });
    },
  };
  return Object.freeze(binding);
}
