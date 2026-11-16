import { createBlockedIframeController } from "./iframe-blocking.js";
import {
  mountOpenCookieHost,
  type VanillaCategoryDependencyResolver,
  type MountedOpenCookie,
  type VanillaCategorySelectionResolver,
  type VanillaOpenCookieCopy,
  type VanillaOpenCookieMountOptions,
  type VanillaPolicyPresentationResolver,
  type VanillaOwnEntryPoint,
  type VanillaPolicyTextResolver,
  type VanillaPurposeDependencyResolver,
} from "./mount.js";
import { createBlockedScriptController } from "./script-blocking.js";
import { enforcementResult, requiredIdentifier } from "./runtime-guards.js";
import { deleteDeclaredStorage } from "./storage-cleanup.js";

/** Selector shared with strict static browser bindings. @internal */
export const VANILLA_DECLARATIVE_RESOURCE_SELECTOR =
  "script[data-oc-resource],iframe[data-oc-resource],template[data-oc-iframe][data-oc-resource]";
const MAX_BROWSER_TIMER_DELAY_MS = 2_147_483_647;

type BrowserClient = VanillaOpenCookieMountOptions["client"];
type BrowserEnforcementResult = Awaited<
  ReturnType<ReturnType<typeof createBlockedScriptController>["block"]>
>;

type RefreshObservation = readonly [
  deadline: number | undefined,
  explicitRetry: boolean,
  generation: number,
  key: string | undefined,
  observedAt: number | undefined,
];

/** One canonical declarative browser resource. @internal */
export interface VanillaDeclarativeResource {
  readonly controllerCategory?: string;
  readonly purposeIds: readonly string[];
  /** Present when the markup lists several purposes and matches any. */
  readonly purposeMatch?: "any";
  readonly resourceId: string;
  readonly serviceId: string;
}

/** One combined script and iframe browser controller. @internal */
export type VanillaResourceController = ReturnType<
  typeof createBlockedScriptController
>;

/** Destruction-aware operations made available to product composition. @internal */
export interface VanillaBrowserProductContext {
  readonly controllers: Readonly<Record<string, VanillaResourceController>>;
  readonly runWhileActive: (operation: () => Promise<void>) => Promise<void>;
}

/** Product-owned observation used by the shared browser lifecycle. @internal */
export interface VanillaBrowserRefreshLifecycle {
  readonly now: () => number;
  readonly refresh: () => Promise<void>;
  readonly refreshAt: () => number | undefined;
}

/** Product callbacks consumed by the shared browser lifecycle. @internal */
export type VanillaBrowserProduct = readonly [
  client: BrowserClient,
  reconcileCurrent: () => Promise<void>,
  refreshLifecycle: VanillaBrowserRefreshLifecycle,
];

/** Product preparation completed after browser controllers exist. @internal */
export type VanillaBrowserProductPreparation = (
  context: VanillaBrowserProductContext,
) => VanillaBrowserProduct;

/** Core-agnostic inputs for the shared browser lifecycle. @internal */
export interface VanillaBrowserRuntimeOptions {
  readonly categoryDependencyResolver: VanillaCategoryDependencyResolver;
  readonly assertResourceStartAllowed?:
    ((resourceId: string) => void) | undefined;
  readonly beforeResourceReconciliation?: (() => Promise<void>) | undefined;
  readonly copy?: Partial<VanillaOpenCookieCopy> | undefined;
  readonly links?: VanillaOpenCookieMountOptions["links"] | undefined;
  readonly declarativeResources?:
    readonly VanillaDeclarativeResource[] | undefined;
  readonly document: Document;
  readonly categoryResolver: VanillaCategorySelectionResolver;
  readonly knownPurposeIds: ReadonlySet<string>;
  readonly nonce?: string | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  /**
   * Settles when presentation may begin. Without it the host mounts at once;
   * with it the denied-state kernel exists now and the host mounts after it.
   */
  readonly presentationTurn?: Promise<unknown> | undefined;
  readonly purposeResolver: VanillaPurposeDependencyResolver;
  /**
   * Reads the stored decision, to notice another tab changing it. Two reads of
   * an unchanged decision must give the same string.
   */
  readonly readStoredDecision?: (() => Promise<string | undefined>) | undefined;
  /** Reloads the page; defaults to `location.reload()`. */
  readonly reload?: (() => void) | undefined;
  readonly sectionResolver: VanillaPolicyPresentationResolver;
  /** The policy's text in the copy's language; the drop-in has one language. */
  readonly textResolver?: VanillaPolicyTextResolver | undefined;
  /** The page's own entry point, where it replaces the launcher. */
  readonly ownEntryPoint?: VanillaOwnEntryPoint | undefined;
  readonly prepareProduct: (
    resources: readonly VanillaDeclarativeResource[],
  ) => VanillaBrowserProductPreparation;
  readonly validateDeclarativeResources?: (() => void) | undefined;
}

/** The mounted product exposed by the shared browser lifecycle. @internal */
export interface VanillaBrowserRuntime extends MountedOpenCookie {
  readonly client: BrowserClient;
  readonly destroyAndWait: () => Promise<void>;
}

/** Validates one declarative identifier without normalizing authored markup. @internal */
export function canonicalDeclarativeIdentifier(
  value: string,
  label: string,
): string {
  const trimmed = requiredIdentifier(value, label);
  const normalized = trimmed.normalize("NFKC").toLowerCase();
  if (normalized !== trimmed) {
    throw new TypeError(`${label} must already be lowercase and normalized.`);
  }
  return normalized;
}

function discoverDeclarativeResources(
  document: Document,
  knownPurposeIds: ReadonlySet<string>,
  report: (error: unknown) => void,
): readonly VanillaDeclarativeResource[] {
  // A bad declaration is refused and reported, and the rest still mount. Its
  // identifier is refused outright, because a controller starts every element
  // that carries it, including one declared under another purpose.
  const resources = new Map<string, VanillaDeclarativeResource>();
  const refused = new Set<string>();
  const sources = document.querySelectorAll<HTMLElement>(
    VANILLA_DECLARATIVE_RESOURCE_SELECTOR,
  );
  for (const source of sources) {
    let resourceId: string | undefined;
    try {
      resourceId = canonicalDeclarativeIdentifier(
        source.dataset["ocResource"] ?? "",
        "Declarative resource identifier",
      );
      // A container serving several purposes lists them and matches any; its
      // controller starts only elements that declare it the same way.
      const declaration = (source.dataset["ocCategory"] ?? "").trim();
      const categoryLabel = `Declarative resource ${resourceId} category`;
      const purposeIds = declaration
        .split(/\s+/u)
        .map((purposeId) =>
          canonicalDeclarativeIdentifier(purposeId, categoryLabel),
        );
      for (const purposeId of purposeIds) {
        if (!knownPurposeIds.has(purposeId)) {
          throw new TypeError(
            `Declarative resource ${resourceId} references unknown purpose ${purposeId}.`,
          );
        }
      }
      const match = source.dataset["ocMatch"];
      if (
        (match !== undefined && match !== "any") ||
        (purposeIds.length > 1 && match !== "any")
      ) {
        throw new TypeError(
          `Declarative resource ${resourceId} lists several purposes only with data-oc-match="any".`,
        );
      }
      const existing = resources.get(resourceId);
      if (
        existing !== undefined &&
        existing.controllerCategory !== declaration
      ) {
        throw new TypeError(
          `Declarative resource ${resourceId} must be declared the same way on every element.`,
        );
      }
      if (refused.has(resourceId)) continue;
      resources.set(resourceId, {
        controllerCategory: declaration,
        purposeIds,
        ...(purposeIds.length > 1 ? { purposeMatch: "any" as const } : {}),
        resourceId,
        serviceId: `${resourceId}-service`,
      });
    } catch (error) {
      if (resourceId !== undefined) {
        refused.add(resourceId);
        resources.delete(resourceId);
      }
      report(error);
    }
  }
  return [...resources.values()].sort((left, right) =>
    left.resourceId < right.resourceId
      ? -1
      : left.resourceId > right.resourceId
        ? 1
        : 0,
  );
}

function combinedResult(
  results: readonly BrowserEnforcementResult[],
): BrowserEnforcementResult {
  return enforcementResult(
    ...results.flatMap((result) => result.irreversibleEffects),
  );
}

function combineControllers(
  controllers: readonly VanillaResourceController[],
  resourceId: string,
  assertStartAllowed?: (resourceId: string) => void,
  onScriptStarted?: (resourceId: string) => void,
): VanillaResourceController {
  return Object.freeze({
    async block() {
      return combinedResult(
        await Promise.all(controllers.map((controller) => controller.block())),
      );
    },
    async cleanup() {
      return combinedResult(
        await Promise.all(
          controllers.map((controller) => controller.cleanup()),
        ),
      );
    },
    async discover() {
      const states = (
        await Promise.all(
          controllers.map((controller) => controller.discover()),
        )
      ).filter((state) => state !== "dormant");
      if (states.length === 0) return "dormant" as const;
      if (states.every((state) => state === "active")) {
        return "active" as const;
      }
      if (states.every((state) => state === "blocked")) {
        return "blocked" as const;
      }
      return "partial" as const;
    },
    async start() {
      const result = combinedResult(
        await Promise.all(
          controllers.map((controller) => {
            assertStartAllowed?.(resourceId);
            return controller.start();
          }),
        ),
      );
      if (result.irreversibleEffects.includes("script-effects-may-persist")) {
        onScriptStarted?.(resourceId);
      }
      return result;
    },
    async stop() {
      await Promise.all(controllers.map((controller) => controller.stop()));
    },
  });
}

function containsObservedResource(
  node: Node,
  knownResourceIds: ReadonlySet<string>,
  observeEveryDeclaration: boolean,
): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  const candidates = [
    ...(element.matches(VANILLA_DECLARATIVE_RESOURCE_SELECTOR)
      ? [element]
      : []),
    ...element.querySelectorAll(VANILLA_DECLARATIVE_RESOURCE_SELECTOR),
  ];
  if (observeEveryDeclaration && candidates.length > 0) return true;
  return candidates.some((candidate) => {
    const resourceId = (candidate as HTMLElement).dataset["ocResource"];
    return resourceId !== undefined && knownResourceIds.has(resourceId);
  });
}

/** Owns the browser lifecycle shared by generic and auto bootstrap. @internal */
export function createVanillaBrowserRuntime(
  options: VanillaBrowserRuntimeOptions,
): VanillaBrowserRuntime {
  const { document, nonce, onError, validateDeclarativeResources } = options;
  validateDeclarativeResources?.();
  const declarativeResources =
    options.declarativeResources ??
    discoverDeclarativeResources(
      document,
      options.knownPurposeIds,
      (error: unknown) => {
        try {
          (
            onError ??
            ((refusal: unknown) => {
              console.error(
                "OpenCookie refused a resource declaration.",
                refusal,
              );
            })
          )(error);
        } catch {
          // A caller-provided error sink cannot safely report its own failure.
        }
      },
    );
  const finishProduct = options.prepareProduct(declarativeResources);
  const AbortControllerConstructor =
    document.defaultView?.AbortController ?? AbortController;
  const resourceLifecycle = new AbortControllerConstructor();
  // Scripts this page ran. Stopping one cannot unload what it already did.
  const startedScripts = new Set<string>();
  const controllers = Object.fromEntries(
    declarativeResources.map((resource) => {
      const categoryOption =
        resource.controllerCategory === undefined
          ? {}
          : { category: resource.controllerCategory };
      return [
        resource.resourceId,
        combineControllers(
          [
            createBlockedScriptController({
              ...categoryOption,
              document,
              ...(nonce === undefined ? {} : { nonce }),
              resourceId: resource.resourceId,
            }),
            createBlockedIframeController({
              ...categoryOption,
              document,
              resourceId: resource.resourceId,
              signal: resourceLifecycle.signal,
            }),
          ],
          resource.resourceId,
          options.assertResourceStartAllowed,
          (resourceId) => startedScripts.add(resourceId),
        ),
      ];
    }),
  );
  let destroyed = false;
  const cleanupResources = (): Promise<void> =>
    Promise.all(
      Object.values(controllers).map((controller) => controller.cleanup()),
    ).then(() => undefined);
  const activeOperations = new Set<Promise<void>>();
  const executeWhileActive = async (
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (destroyed) {
      await cleanupResources();
      return;
    }
    let operationFailed = false;
    let operationError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    } finally {
      // The public destroy callback can change this state while an operation awaits.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (destroyed) {
        try {
          await cleanupResources();
        } catch (error) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
    }
    if (operationFailed) throw operationError;
    if (cleanupFailed) throw cleanupError;
  };
  const runWhileActive = (operation: () => Promise<void>): Promise<void> => {
    const activeOperation = executeWhileActive(operation);
    activeOperations.add(activeOperation);
    void activeOperation
      .finally(() => activeOperations.delete(activeOperation))
      .catch(() => undefined);
    return activeOperation;
  };
  const [client, reconcileCurrent, refreshLifecycle] = finishProduct({
    controllers,
    runWhileActive,
  });
  const { presentationTurn } = options;
  let mounted: MountedOpenCookie | undefined;
  const mount = (): MountedOpenCookie => {
    mounted = mountOpenCookieHost(
      {
        client,
        ...(options.copy === undefined ? {} : { copy: options.copy }),
        document,
        ...(options.links === undefined ? {} : { links: options.links }),
        ...(nonce === undefined ? {} : { nonce }),
        ...(onError === undefined ? {} : { onError }),
      },
      options.purposeResolver,
      options.categoryDependencyResolver,
      options.categoryResolver,
      options.sectionResolver,
      options.readStoredDecision === undefined
        ? undefined
        : () => {
            // The channel announces only a confirmed write, so compare now.
            // Storage, visibility, and bfcache keep the settle delay.
            void compareStoredDecision();
          },
      // A decision stored in this tab that turns off a script this page ran
      // reloads it, since the script cannot be unloaded (Pass B's M-C). So
      // does one that revokes a purpose of a script that stays allowed for
      // another, as a container that matches any does: the tags it started
      // for that purpose cannot be unloaded either.
      (revokedPurposeIds) => {
        if (destroyed) return;
        // What a resource declares for a purpose turned off is deleted now,
        // though the resource stays allowed for another.
        if (revokedPurposeIds.length > 0) {
          const sources = document.querySelectorAll<HTMLElement>(
            VANILLA_DECLARATIVE_RESOURCE_SELECTOR,
          );
          for (const { resourceId } of declarativeResources) {
            try {
              deleteDeclaredStorage(
                document,
                [...sources].filter(
                  (source) => source.dataset["ocResource"] === resourceId,
                ),
                resourceId,
                revokedPurposeIds,
              );
            } catch (error) {
              reportError(error);
            }
          }
        }
        if (
          client
            .getSnapshot()
            .runtime.effectiveAccess.resources.some(
              (resource) =>
                startedScripts.has(resource.resourceId) &&
                (resource.access === "blocked" ||
                  declarativeResources.some(
                    ({ purposeIds, resourceId }) =>
                      resourceId === resource.resourceId &&
                      purposeIds.some((purposeId) =>
                        revokedPurposeIds.includes(purposeId),
                      ),
                  )),
            )
        ) {
          reload();
        }
      },
      options.textResolver,
      options.ownEntryPoint,
    );
    return mounted;
  };
  if (presentationTurn === undefined) mount();

  const knownResourceIds = new Set(
    declarativeResources.map((resource) => resource.resourceId),
  );
  let observer: MutationObserver | undefined;
  let reconciliationQueued = false;
  const errorReporter =
    onError ??
    ((error: unknown) => {
      console.error("OpenCookie resource reconciliation failed.", error);
    });
  const reportError = (error: unknown): void => {
    try {
      errorReporter(error);
    } catch {
      // A caller-provided error sink cannot safely report its own failure.
    }
  };
  const browserWindow = document.defaultView;
  let refreshTimer: number | undefined;
  let refreshTimerGeneration: number | undefined;
  let refreshInFlight = false;
  let refreshObservationGeneration = 0;
  let latestRefreshObservation: RefreshObservation | undefined;
  let lastAttemptedRefreshKey: string | undefined;
  let pendingRefreshObservation: RefreshObservation | undefined;
  let unsubscribeRefresh: (() => void) | undefined;
  const clearRefreshTimer = (): void => {
    if (refreshTimer === undefined) return;
    if (browserWindow !== null) browserWindow.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    refreshTimerGeneration = undefined;
  };
  const observationTime = (value: number, label: string): number => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative safe integer.`);
    }
    return value;
  };
  const ownsRefreshObservation = (observation: RefreshObservation): boolean =>
    observation[2] === refreshObservationGeneration;
  const captureRefreshObservation = (
    explicitRetry: boolean,
  ): RefreshObservation | boolean | undefined => {
    if (destroyed || browserWindow === null) {
      return undefined;
    }
    const previousGeneration = refreshObservationGeneration;
    const generation = ++refreshObservationGeneration;
    try {
      const refreshAt = refreshLifecycle.refreshAt();
      let observation: RefreshObservation;
      if (refreshAt === undefined) {
        observation = [
          undefined,
          explicitRetry,
          generation,
          undefined,
          undefined,
        ];
      } else {
        const deadline = observationTime(refreshAt, "Refresh deadline");
        observation = [
          deadline,
          explicitRetry,
          generation,
          `deadline:${String(deadline)}`,
          observationTime(refreshLifecycle.now(), "Refresh time"),
        ];
      }
      if (ownsRefreshObservation(observation)) {
        latestRefreshObservation = observation;
      }
      return observation;
    } catch (error) {
      reportError(error);
      const owned = refreshObservationGeneration === generation;
      if (owned) {
        refreshObservationGeneration = previousGeneration;
      }
      return owned;
    }
  };

  const retainRefreshObservation = (observation: RefreshObservation): void => {
    if (!ownsRefreshObservation(observation)) return;
    const [deadline, explicitRetry, generation, key, observedAt] = observation;
    const sameMaterialObservation =
      key !== undefined && key === pendingRefreshObservation?.[3];
    const retainedExplicitRetry =
      explicitRetry ||
      (sameMaterialObservation && pendingRefreshObservation?.[1] === true);
    pendingRefreshObservation = [
      deadline,
      retainedExplicitRetry,
      generation,
      key,
      observedAt,
    ];
  };

  const currentRefreshTime = (): number | undefined => {
    if (destroyed || browserWindow === null) {
      return undefined;
    }
    try {
      return observationTime(refreshLifecycle.now(), "Refresh time");
    } catch (error) {
      reportError(error);
      return undefined;
    }
  };

  const settleRefresh = (failed: boolean, error?: unknown): void => {
    if (destroyed) {
      pendingRefreshObservation = undefined;
      refreshInFlight = false;
      return;
    }
    if (failed) reportError(error);
    const retainedObservation = pendingRefreshObservation;
    pendingRefreshObservation = undefined;
    refreshInFlight = false;
    // The error callback can destroy the runtime before retained work resumes.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (destroyed) return;
    if (retainedObservation !== undefined) {
      processRefreshObservation(retainedObservation, false, true);
      return;
    }
    const capture = captureRefreshObservation(false);
    if (typeof capture === "object") {
      processRefreshObservation(capture, false, false);
    }
  };

  const startRefresh = (observation: RefreshObservation): void => {
    const key = observation[3];
    if (
      destroyed ||
      key === undefined ||
      !ownsRefreshObservation(observation)
    ) {
      return;
    }
    lastAttemptedRefreshKey = key;
    refreshInFlight = true;
    pendingRefreshObservation = undefined;
    void Promise.resolve()
      .then(() => {
        if (destroyed) return undefined;
        return refreshLifecycle.refresh();
      })
      .then(
        () => {
          settleRefresh(false);
        },
        (error: unknown) => {
          settleRefresh(true, error);
        },
      );
  };

  const armRefreshTimer = (
    observation: RefreshObservation,
    now: number,
  ): void => {
    const [deadline, explicitRetry, generation] = observation;
    if (
      destroyed ||
      browserWindow === null ||
      deadline === undefined ||
      !ownsRefreshObservation(observation)
    ) {
      return;
    }
    const delay = Math.min(
      Math.max(deadline - now, 0),
      MAX_BROWSER_TIMER_DELAY_MS,
    );
    const scheduledGeneration = generation;
    refreshTimerGeneration = scheduledGeneration;
    refreshTimer = browserWindow.setTimeout(() => {
      if (destroyed || refreshTimerGeneration !== scheduledGeneration) {
        return;
      }
      refreshTimer = undefined;
      refreshTimerGeneration = undefined;
      observeRefresh(explicitRetry, observation);
    }, delay);
  };

  function processRefreshObservation(
    observation: RefreshObservation,
    deferDue: boolean,
    refreshClock: boolean,
  ): void {
    const [deadline, explicitRetry, , key, observedAt] = observation;
    if (destroyed || !ownsRefreshObservation(observation)) {
      return;
    }
    if (
      deadline === undefined ||
      key === undefined ||
      observedAt === undefined
    ) {
      clearRefreshTimer();
      return;
    }
    const now = refreshClock ? currentRefreshTime() : observedAt;
    if (now === undefined) {
      if (refreshClock && ownsRefreshObservation(observation)) {
        clearRefreshTimer();
        startRefresh(observation);
      }
      return;
    }
    if (!ownsRefreshObservation(observation)) return;
    clearRefreshTimer();
    if (now < deadline) {
      if (key === lastAttemptedRefreshKey) {
        lastAttemptedRefreshKey = undefined;
      }
      armRefreshTimer(observation, now);
      return;
    }
    if (!explicitRetry && key === lastAttemptedRefreshKey) {
      return;
    }
    if (deferDue) {
      armRefreshTimer(observation, now);
      return;
    }
    startRefresh(observation);
  }

  const scheduleRefresh = (): void => {
    const capture = captureRefreshObservation(false);
    if (typeof capture !== "object") return;
    const observation = capture;
    if (refreshInFlight) {
      retainRefreshObservation(observation);
      return;
    }
    processRefreshObservation(observation, true, false);
  };
  const observeRefresh = (
    explicitRetry: boolean,
    failedCaptureFallback?: RefreshObservation,
  ): void => {
    const capture = captureRefreshObservation(explicitRetry);
    if (capture === undefined) return;
    if (typeof capture !== "object") {
      if (!capture) return;
      const fallback = failedCaptureFallback ?? latestRefreshObservation;
      if (
        destroyed ||
        fallback === undefined ||
        !ownsRefreshObservation(fallback) ||
        (!explicitRetry && failedCaptureFallback === undefined)
      ) {
        return;
      }
      const failClosedObservation: RefreshObservation = [
        fallback[0],
        true,
        fallback[2],
        fallback[3],
        fallback[4],
      ];
      if (refreshInFlight) {
        retainRefreshObservation(failClosedObservation);
        return;
      }
      clearRefreshTimer();
      startRefresh(failClosedObservation);
      return;
    }
    const observation = capture;
    if (refreshInFlight) {
      retainRefreshObservation(observation);
      return;
    }
    processRefreshObservation(observation, false, false);
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    observeRefresh(true);
    // Only a page restored from the back-forward cache can hold a stale
    // stored decision; a first load has just read it.
    if (event.persisted) checkStoredDecision();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") observeRefresh(true);
  };
  // The mount hears a decision another open tab of this origin makes. A tab
  // restored from the back-forward cache, one on another subdomain sharing the
  // cookie, or one without BroadcastChannel sees it only in storage. When the
  // stored decision no longer matches what this tab last read, the tab adopts
  // it in place. It reloads at once when adoption is missing, rejects, or
  // cannot take the record. A later comparison skips that reload
  // only while storage still holds the same value, so a new withdrawal can
  // reload again. A decision that blocks a script this page ran still reloads
  // from the mount. The storage event never reaches the tab that
  // wrote. A tab that merely loads restages its stored grant in a burst of
  // writes that ends unchanged, so the storage, visibility, and bfcache
  // comparisons wait for storage to settle. A comparison that overlaps this
  // tab's own change is dropped.
  const { readStoredDecision } = options;
  const reload = options.reload ?? (() => browserWindow?.location.reload());
  // The stored value that already asked for a reload. A repeat of that value
  // does nothing; a different one, such as a later withdrawal, compares again.
  // Absent until the first reload, so a missing read is not itself a repeat.
  let reloadedFor: { readonly stored: string | undefined } | undefined;
  const requestReload = (stored: string | undefined): void => {
    if (reloadedFor !== undefined && reloadedFor.stored === stored) return;
    reloadedFor = { stored };
    reload();
  };
  const readDecision = async (): Promise<string | undefined> => {
    try {
      return await readStoredDecision?.();
    } catch {
      return undefined;
    }
  };
  let knownDecision: Promise<string | undefined> | undefined;
  let { lastPersistenceStatus: knownStatus, record: knownRecord } =
    client.getSnapshot();
  let unsubscribeDecision: (() => void) | undefined;
  let decisionTimer: number | undefined;
  const compareStoredDecision = async (): Promise<void> => {
    const baseline = knownDecision;
    if (baseline === undefined) return;
    const [known, stored] = await Promise.all([baseline, readDecision()]);
    // A comparison that started earlier can reload while this read is in flight.
    if (
      (reloadedFor !== undefined && stored === reloadedFor.stored) ||
      destroyed ||
      baseline !== knownDecision ||
      stored === known
    ) {
      return;
    }
    const adopt = client.adoptStoredDecision;
    if (adopt === undefined) {
      requestReload(stored);
      return;
    }
    try {
      const result = await adopt();
      // A comparison that finished first remembers this stored value.
      if (reloadedFor !== undefined && stored === reloadedFor.stored) return;
      // The public destroy callback can change this state while adoption awaits.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (destroyed) return;
      if (result === "unavailable") {
        requestReload(stored);
        return;
      }
      knownDecision = Promise.resolve(stored);
    } catch {
      // The public destroy callback can change this state while adoption awaits.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!destroyed) requestReload(stored);
    }
  };
  const checkStoredDecision = (): void => {
    if (browserWindow === null) return;
    browserWindow.clearTimeout(decisionTimer);
    decisionTimer = browserWindow.setTimeout(() => {
      void compareStoredDecision();
    }, 500);
  };
  const checkVisibleDecision = (): void => {
    if (document.visibilityState === "visible") checkStoredDecision();
  };
  const startDecisionWatch = (): void => {
    if (readStoredDecision === undefined || browserWindow === null) return;
    knownDecision = readDecision();
    // A denial publishes its record before the write lands, so the baseline
    // is read again once persistence settles, not only when the record moves.
    unsubscribeDecision = client.subscribe(() => {
      const { lastPersistenceStatus, record } = client.getSnapshot();
      if (record === knownRecord && lastPersistenceStatus === knownStatus) {
        return;
      }
      knownRecord = record;
      knownStatus = lastPersistenceStatus;
      knownDecision = readDecision();
    });
    browserWindow.addEventListener("storage", checkStoredDecision);
    document.addEventListener("visibilitychange", checkVisibleDecision);
  };
  const startRefreshLifecycle = (): void => {
    if (browserWindow === null) return;
    browserWindow.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    unsubscribeRefresh = client.subscribe(scheduleRefresh);
    scheduleRefresh();
    startDecisionWatch();
  };
  const stopRefreshLifecycle = (): void => {
    clearRefreshTimer();
    unsubscribeRefresh?.();
    unsubscribeRefresh = undefined;
    unsubscribeDecision?.();
    unsubscribeDecision = undefined;
    browserWindow?.clearTimeout(decisionTimer);
    if (browserWindow === null) return;
    browserWindow.removeEventListener("pageshow", onPageShow);
    browserWindow.removeEventListener("storage", checkStoredDecision);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("visibilitychange", checkVisibleDecision);
  };
  let precedingResourceCleanup: Promise<void> | undefined;
  const waitForPrecedingResourceCleanup = (): Promise<void> => {
    precedingResourceCleanup ??= Promise.resolve().then(() =>
      options.beforeResourceReconciliation?.(),
    );
    return precedingResourceCleanup;
  };
  let destroyTask: Promise<void> | undefined;
  const destroyAndWait = (): Promise<void> => {
    if (destroyTask !== undefined) return destroyTask;
    destroyed = true;
    observer?.disconnect();
    stopRefreshLifecycle();
    resourceLifecycle.abort();
    const immediateCleanup = cleanupResources();
    if (mounted !== undefined) mounted.destroy();
    destroyTask = (async () => {
      const [precedingCleanup, initialCleanup] = await Promise.allSettled([
        waitForPrecedingResourceCleanup(),
        immediateCleanup,
      ]);
      while (activeOperations.size > 0) {
        await Promise.allSettled([...activeOperations]);
      }
      const [finalCleanup] = await Promise.allSettled([cleanupResources()]);
      if (finalCleanup.status === "rejected") throw finalCleanup.reason;
      if (initialCleanup.status === "rejected") throw initialCleanup.reason;
      if (precedingCleanup.status === "rejected") {
        throw precedingCleanup.reason;
      }
    })();
    return destroyTask;
  };
  const scheduleReconciliation = (): void => {
    if (destroyed || reconciliationQueued) return;
    reconciliationQueued = true;
    queueMicrotask(() => {
      reconciliationQueued = false;
      if (!destroyed) void reconcileCurrent().catch(reportError);
    });
  };
  const startObservation = (): void => {
    startRefreshLifecycle();
    // Refresh setup can synchronously report an error that destroys the runtime.
    if (destroyed) return;
    const MutationObserverConstructor = document.defaultView?.MutationObserver;
    if (
      MutationObserverConstructor === undefined ||
      (knownResourceIds.size === 0 &&
        validateDeclarativeResources === undefined)
    ) {
      return;
    }
    observer = new MutationObserverConstructor((mutations) => {
      if (
        mutations.some((mutation) =>
          [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
            containsObservedResource(
              node,
              knownResourceIds,
              validateDeclarativeResources !== undefined,
            ),
          ),
        )
      ) {
        scheduleReconciliation();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };
  const ready = (async () => {
    try {
      // A runtime destroyed while presentation waits never mounts; the
      // destroyed check below then cleans up.
      await (mounted?.ready ??
        presentationTurn?.then(() => (destroyed ? undefined : mount().ready)));
      await waitForPrecedingResourceCleanup();
      // The public destroy callback can change this state while initialization awaits.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (destroyed) {
        await cleanupResources();
        return;
      }
      await reconcileCurrent();
      // The public destroy callback can change this state while reconciliation awaits.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (destroyed) {
        await cleanupResources();
        return;
      }
    } catch (error) {
      // A failed asynchronous startup can race with the public destroy callback.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!destroyed) {
        try {
          startObservation();
        } catch (observationError) {
          reportError(observationError);
        }
      }
      throw error;
    }
    startObservation();
  })();

  return Object.freeze({
    client,
    destroy(): void {
      void destroyAndWait().catch(reportError);
    },
    destroyAndWait,
    ready,
  });
}
