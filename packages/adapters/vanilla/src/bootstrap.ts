import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type ConsentReceipt,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type EffectiveAccessPlan,
  type OpenCookie,
  type OpenCookieIdKind,
  type OpenCookiePortContext,
  type PolicyDefinition,
  type PolicySnapshot,
  type ProcessingRestrictionSet,
  type StorageLike,
} from "@opencookie-dev/core";
import {
  expandCategorySelection,
  normalizePolicyIdentifier,
  resolveGpcRestrictions,
  resolveGpcSignal,
  resolvePolicyText,
  resolvePurposeDependencies,
  resolvePurposeSelection,
} from "@opencookie-dev/core/domain";
import {
  createAccessEnforcementReconciler,
  createGoogleConsentModeBroadcaster,
  projectAccessEnforcementDecisions,
  projectGoogleConsentModePurposeState,
  projectGoogleConsentModeState,
  type GoogleConsentModeBroadcaster,
  type GoogleConsentModeBroadcasterOptions,
  type GoogleConsentModePurposeMapping,
  type GoogleConsentModeResourceMapping,
  type GoogleConsentModeState,
} from "@opencookie-dev/core/infrastructure";

import {
  createVanillaBrowserRuntime,
  type VanillaBrowserRuntimeOptions,
} from "./browser-runtime.js";
import {
  assertBannerLinks,
  launcherReplacement,
  resolveCopy,
  type MountedOpenCookie,
  type VanillaOpenCookieCopy,
  type VanillaOpenCookieLink,
} from "./mount.js";
import {
  composeVanillaProduct,
  createVanillaBrowserClock,
  DEFAULT_CONSENT_DURATION_MS,
  defaultBrowserIdGenerator,
  defaultBrowserStorage,
} from "./product-composition.js";
import { projectPolicyPresentation } from "./policy-presentation.js";
import { requiredIdentifier, resolveDocument } from "./runtime-guards.js";

export { DEFAULT_CONSENT_DURATION_MS } from "./product-composition.js";

const GOOGLE_MAPPING_KEYS = [
  "adPersonalizationResourceIds",
  "adStorageResourceIds",
  "adUserDataResourceIds",
  "analyticsStorageResourceIds",
] as const;

const GOOGLE_PURPOSE_MAPPING_KEYS = [
  "adPersonalizationPurposeIds",
  "adStoragePurposeIds",
  "adUserDataPurposeIds",
  "analyticsStoragePurposeIds",
] as const;

type Fail = () => never;

function invalidConsentDuration(): never {
  throw new TypeError("Consent duration must be a positive safe integer.");
}

function assertGlobalPrivacyControlOption(
  options: BootstrapOpenCookieOptions,
): void {
  const configured = options.globalPrivacyControl;
  if (configured === undefined) return;
  if (options.privacyRestrictions !== undefined) {
    throw new TypeError(
      "globalPrivacyControl and privacyRestrictions cannot be used together.",
    );
  }
  const purposeIds = configured.purposeIds;
  if (!Array.isArray(purposeIds) || purposeIds.length === 0) {
    throw new TypeError(
      "globalPrivacyControl.purposeIds must list at least one purpose.",
    );
  }
  for (const purposeId of purposeIds) {
    if (typeof purposeId !== "string" || purposeId.trim() === "") {
      throw new TypeError(
        "globalPrivacyControl.purposeIds must contain non-blank purpose ids.",
      );
    }
  }
}

function assertBootstrapOptions(options: BootstrapOpenCookieOptions): void {
  assertBannerLinks(options.links);
  assertGlobalPrivacyControlOption(options);
}

/** One browser observation, resolved by the domain. Absent signal: no restriction. */
function gpcPrivacyRestrictions(
  document: Document,
  purposeIds: readonly string[],
  now: () => number,
): ProcessingRestrictionSet | undefined {
  const signal = (
    document.defaultView?.navigator as
      { readonly globalPrivacyControl?: unknown } | undefined
  )?.globalPrivacyControl;
  if (signal !== true) return undefined;
  const navigationId = document.defaultView?.location.href ?? "document";
  return resolveGpcRestrictions({
    resolution: resolveGpcSignal({
      navigationId,
      observations: [
        {
          navigationId,
          observedAtMs: now(),
          source: "browser",
          value: "enabled",
        },
      ],
    }),
    whenEnabled: { purposeIds },
  });
}

function invalidGoogleMapping(): never {
  throw new TypeError(
    "The OpenCookie Google Consent Mode resource mapping is invalid.",
  );
}

function ownDataValue(source: object, field: PropertyKey, fail: Fail): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor === undefined) {
      if (Reflect.has(source, field)) fail();
      return;
    }
    if ("value" in descriptor) return descriptor.value;
  } catch {
    // Invalid proxies and inherited or accessor-backed values are rejected.
  }
  fail();
}

function configuredConsentDuration(
  options: BootstrapOpenCookieOptions,
): number {
  const configured = ownDataValue(
    options,
    "consentDurationMs",
    invalidConsentDuration,
  );
  const consentDurationMs =
    configured === undefined ? DEFAULT_CONSENT_DURATION_MS : configured;
  if (
    typeof consentDurationMs !== "number" ||
    !Number.isSafeInteger(consentDurationMs) ||
    consentDurationMs < 1
  ) {
    invalidConsentDuration();
  }
  return consentDurationMs;
}

function captureGoogleMapping<Field extends string>(
  candidate: Partial<Record<Field, readonly string[]>>,
  fields: readonly Field[],
): Partial<Record<Field, readonly string[]>> {
  const captured: Partial<Record<Field, readonly string[]>> = {};
  let remaining = 10_000;
  for (const field of fields) {
    let resourceIds: unknown;
    try {
      resourceIds = candidate[field];
    } catch {
      invalidGoogleMapping();
    }
    if (resourceIds === undefined) continue;
    try {
      if (!Array.isArray(resourceIds)) {
        invalidGoogleMapping();
      }
    } catch {
      invalidGoogleMapping();
    }
    const length = ownDataValue(resourceIds, "length", invalidGoogleMapping);
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > remaining
    ) {
      invalidGoogleMapping();
    }
    remaining -= length;
    const identifiers: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const identifier = normalizePolicyIdentifier(
        ownDataValue(resourceIds, index, invalidGoogleMapping),
      );
      if (!identifier) invalidGoogleMapping();
      identifiers.push(identifier);
    }
    captured[field] = Object.freeze(identifiers);
  }
  return Object.freeze(captured);
}

/** Builds the complete single-purpose starter catalogue. @internal */
export function singlePurposePolicy(
  id: string,
  label: string,
  disclosure: string,
  consentDurationMs: number,
): PolicyDefinition {
  const retentionId = `duration-${String(consentDurationMs)}-ms`;
  return {
    categories: [{ id: "optional", purposeIds: [id] }],
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "aggregate-measurement" }],
    presentationRootCategoryIds: ["optional"],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure,
        id,
        label,
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: [retentionId],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: retentionId }],
  };
}

/**
 * Google Consent Mode for the bootstrap. Give exactly one mapping: `mapping`
 * grants a signal while every resource mapped to it is allowed on consent;
 * `purposeMapping`, for tags inside a container that serves several purposes,
 * while every purpose mapped to it is permitted.
 *
 * @public
 */
export interface VanillaGoogleConsentModeOptions extends GoogleConsentModeBroadcasterOptions {
  readonly mapping?: GoogleConsentModeResourceMapping;
  readonly purposeMapping?: GoogleConsentModePurposeMapping;
}

/** A captured mapping of the Consent Mode signals, by resource or purpose. */
type GoogleSignalMapping =
  | { readonly purposes: GoogleConsentModePurposeMapping }
  | { readonly resources: GoogleConsentModeResourceMapping };

function captureGoogleSignals(
  configured: VanillaGoogleConsentModeOptions,
): GoogleSignalMapping {
  const { mapping, purposeMapping } = configured;
  if ((mapping === undefined) === (purposeMapping === undefined)) {
    throw new TypeError(
      "Google Consent Mode needs exactly one of mapping and purposeMapping.",
    );
  }
  return mapping === undefined
    ? {
        purposes: captureGoogleMapping(
          purposeMapping ?? {},
          GOOGLE_PURPOSE_MAPPING_KEYS,
        ),
      }
    : { resources: captureGoogleMapping(mapping, GOOGLE_MAPPING_KEYS) };
}

/**
 * A resource that runs whatever the visitor chooses, such as a session cookie,
 * disclosed with the reason it is not controlled by the choices.
 *
 * @public
 */
export interface BootstrapDeclaredException {
  readonly exceptionReason: string;
  readonly id: string;
  /** The name listed in place of the id, such as "Session cookie". */
  readonly label?: string;
}

/**
 * A published policy as `opencookie policy install --out <file>.json` writes
 * it, with the identity it was published under.
 *
 * `policy` is typed loosely so an imported JSON file can be passed as it is.
 * The bootstrap validates it and refuses it unless it derives the recorded
 * digests. Other fields the file carries, such as `publicationId`, are ignored.
 *
 * @public
 */
export interface InstalledOpenCookiePolicy {
  readonly catalogueDigest: string;
  readonly catalogueRevision: string;
  readonly decisionSurfaceDigest: string;
  readonly policy: unknown;
  readonly policyVersion: string;
}

/** Options for the complete no-framework OpenCookie bootstrap. @public */
export interface BootstrapOpenCookieOptions {
  readonly broadcast?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly catalogueRevision?: string;
  readonly consentDurationMs?: number;
  readonly copy?: Partial<VanillaOpenCookieCopy>;
  /** Resources the choices do not control, listed in the settings. */
  readonly declaredExceptions?: readonly BootstrapDeclaredException[];
  readonly document?: Document;
  readonly googleConsentMode?: VanillaGoogleConsentModeOptions;
  /**
   * Purposes the browser's Global Privacy Control signal restricts. Read once
   * from `navigator.globalPrivacyControl`. Exactly `true` restricts
   * `purposeIds`; `false` or a missing signal restricts nothing. The signal
   * does not record a decision. Cannot be combined with `privacyRestrictions`.
   */
  readonly globalPrivacyControl?: {
    readonly purposeIds: readonly string[];
  };
  readonly idGenerator?: (kind: OpenCookieIdKind) => string;
  /**
   * The installed policy to enforce, in place of `policyDefinition`,
   * `policyVersion` and `catalogueRevision`. The bootstrap throws before
   * mounting when the policy does not derive the digests recorded with it.
   */
  readonly installedPolicy?: InstalledOpenCookiePolicy;
  /**
   * `false` leaves out the floating launcher while the page carries its own
   * `data-oc-open-preferences` entry point. See the mount option.
   */
  readonly launcher?: boolean;
  /** Links shown in the banner, in the given order. */
  readonly links?: readonly VanillaOpenCookieLink[];
  readonly nonce?: string;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  /** Complete policy input for a custom decision surface. */
  readonly policyDefinition?: PolicyDefinition;
  readonly policyHistory?: readonly PolicySnapshot[];
  readonly policyVersion?: string;
  readonly privacyRestrictions?: ProcessingRestrictionSet;
  /**
   * Receives each consent receipt the runtime projects. OpenCookie does not
   * queue or send it; this function is where a site keeps that evidence.
   */
  readonly receipt?: (
    receipt: ConsentReceipt,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly store?: DecisionStore;
  readonly storage?: StorageLike;
  readonly storageKey?: string;
}

/** A mounted no-framework interface and its headless client. @public */
export interface BootstrappedOpenCookie extends MountedOpenCookie {
  readonly client: OpenCookie;
}

/** A Consent Mode broadcaster whose denied default is already sent. */
interface EstablishedGoogleConsentMode {
  readonly broadcaster: GoogleConsentModeBroadcaster;
  readonly signals: GoogleSignalMapping;
}

function establishGoogleConsentMode(
  configured: VanillaGoogleConsentModeOptions,
): GoogleConsentModeBroadcaster {
  const broadcaster = createGoogleConsentModeBroadcaster(configured);
  const defaults = broadcaster.establishDeniedDefaults();
  if (defaults.status !== "sent") {
    throw new Error(
      `Google Consent Mode defaults failed with status ${defaults.status}.`,
    );
  }
  return broadcaster;
}

function requireGoogleBroadcast(
  broadcaster: GoogleConsentModeBroadcaster,
  state: GoogleConsentModeState,
): void {
  const result = broadcaster.update(state);
  if (result.status !== "sent") {
    throw new Error(
      `Google Consent Mode update failed with status ${result.status}.`,
    );
  }
}

/** The snapshot of a policy passed as a definition, or of the starter one. */
function configuredPolicySnapshot(
  options: BootstrapOpenCookieOptions,
  consentDurationMs: number,
): PolicySnapshot {
  const policyResult = definePolicy(
    options.policyDefinition ??
      singlePurposePolicy(
        "analytics",
        "Analytics",
        "Understand aggregate site usage.",
        consentDurationMs,
      ),
  );
  if (!policyResult.ok) {
    throw new TypeError(
      "The OpenCookie bootstrap purpose catalogue is invalid.",
    );
  }
  return createPolicySnapshot({
    catalogueRevision: requiredIdentifier(
      options.catalogueRevision ?? "catalogue-1",
      "Catalogue revision",
    ),
    policy: policyResult.policy,
    policyVersion: requiredIdentifier(
      options.policyVersion ?? "policy-1",
      "Policy version",
    ),
  });
}

function invalidInstalledPolicy(): never {
  throw new TypeError("The installed OpenCookie policy is invalid.");
}

/**
 * The snapshot an installed policy was published as.
 *
 * Its digests are derived again from the policy and must equal the recorded
 * ones, so a policy edited or replaced after install never runs under the
 * published identity. The version and revision are used exactly as recorded.
 */
function installedPolicySnapshot(
  installed: InstalledOpenCookiePolicy,
): PolicySnapshot {
  const recorded = (field: keyof InstalledOpenCookiePolicy): unknown =>
    ownDataValue(installed, field, invalidInstalledPolicy);
  const catalogueRevision = recorded("catalogueRevision");
  const policyVersion = recorded("policyVersion");
  requiredIdentifier(catalogueRevision, "Catalogue revision");
  requiredIdentifier(policyVersion, "Policy version");
  const defined = definePolicy(recorded("policy") as PolicyDefinition);
  if (!defined.ok) invalidInstalledPolicy();
  const snapshot = createPolicySnapshot({
    catalogueRevision: catalogueRevision as string,
    policy: defined.policy,
    policyVersion: policyVersion as string,
  });
  for (const digest of ["catalogueDigest", "decisionSurfaceDigest"] as const) {
    if (snapshot[digest] !== recorded(digest)) {
      throw new TypeError(
        `The installed OpenCookie policy does not derive its recorded ${digest}.`,
      );
    }
  }
  return snapshot;
}

/** Prepares generic core composition for the shared browser owner. @internal */
export function prepareVanillaBrowserRuntime(
  options: BootstrapOpenCookieOptions = {},
  establishedGoogleConsentMode?: EstablishedGoogleConsentMode,
): VanillaBrowserRuntimeOptions {
  assertBootstrapOptions(options);
  const consentDurationMs = configuredConsentDuration(options);
  const document = resolveDocument(
    options.document,
    "bootstrapOpenCookie requires a browser document with a body.",
  );
  if (document.querySelector("body") === null) {
    throw new Error(
      "bootstrapOpenCookie requires a browser document with a body.",
    );
  }

  const installedPolicy = options.installedPolicy;
  if (
    installedPolicy !== undefined &&
    (options.policyDefinition !== undefined ||
      options.policyVersion !== undefined ||
      options.catalogueRevision !== undefined)
  ) {
    throw new TypeError(
      "Bootstrap installedPolicy cannot be combined with policyDefinition, policyVersion or catalogueRevision.",
    );
  }
  const policySnapshot =
    installedPolicy === undefined
      ? configuredPolicySnapshot(options, consentDurationMs)
      : installedPolicySnapshot(installedPolicy);
  const { policy } = policySnapshot;
  const knownPurposeIds = new Set(policy.purposes.map((purpose) => purpose.id));
  // A mistyped id would restrict nothing while the site believes the signal
  // is honoured. Refuse it before the host is mounted, signal or not.
  if (options.globalPrivacyControl !== undefined) {
    for (const purposeId of options.globalPrivacyControl.purposeIds) {
      if (!knownPurposeIds.has(purposeId)) {
        throw new TypeError(
          "globalPrivacyControl.purposeIds must name purposes of the policy.",
        );
      }
    }
  }

  // Another tab's decision is noticed by reading the store. The default store
  // is read through its storage, so the reads never permit a write.
  const decisionKey = options.storageKey ?? "opencookie.consent";
  const callerStore = options.store;
  const callerStorage = options.storage;
  const defaultStorage = defaultBrowserStorage(document);
  const storage = callerStorage ?? defaultStorage;
  const readStoredDecision =
    callerStore === undefined
      ? () =>
          Promise.resolve().then(
            () =>
              (callerStorage === undefined
                ? defaultStorage.peek(decisionKey)
                : callerStorage.getItem(decisionKey)) ?? undefined,
          )
      : () => callerStore.read().then((result) => JSON.stringify(result));

  return {
    categoryDependencyResolver: resolvePurposeSelection,
    categoryResolver: expandCategorySelection,
    get copy() {
      return options.copy;
    },
    get links() {
      return options.links;
    },
    document,
    knownPurposeIds,
    get nonce() {
      return options.nonce;
    },
    get onError() {
      return options.onError;
    },
    purposeResolver: (policy, purposeId) =>
      resolvePurposeDependencies(policy, { [purposeId]: "granted" }),
    readStoredDecision,
    sectionResolver: projectPolicyPresentation,
    textResolver: resolvePolicyText,
    ownEntryPoint: launcherReplacement(options.launcher),
    prepareProduct: (declarativeResources) => {
      const declaredExceptions = (options.declaredExceptions ?? []).map(
        ({ exceptionReason, id, label }) => ({
          access: "declared-exception" as const,
          exceptionReason,
          id,
          ...(label === undefined ? {} : { label }),
          serviceId: `${id}-service`,
        }),
      );
      const exceptionIds = new Set(declaredExceptions.map(({ id }) => id));
      const resourceResult = defineResourcePolicy({
        policy,
        resources: [
          ...declarativeResources.map((resource) => ({
            access: "optional" as const,
            id: resource.resourceId,
            purposeIds: resource.purposeIds,
            ...(resource.purposeMatch === undefined
              ? {}
              : { purposeMatch: resource.purposeMatch }),
            serviceId: resource.serviceId,
          })),
          ...declaredExceptions,
        ],
        services: [...declarativeResources, ...declaredExceptions].map(
          ({ serviceId }) => ({ id: serviceId }),
        ),
      });
      if (!resourceResult.ok) {
        throw new TypeError(
          "The OpenCookie bootstrap resource policy is invalid.",
        );
      }
      // The head route has sent the default and captured the mapping already.
      const configuredGoogleConsentMode =
        establishedGoogleConsentMode === undefined
          ? options.googleConsentMode
          : undefined;
      const googleSignals =
        establishedGoogleConsentMode?.signals ??
        (configuredGoogleConsentMode === undefined
          ? undefined
          : captureGoogleSignals(configuredGoogleConsentMode));
      // A container that serves several purposes stays allowed while any one
      // is permitted, so a signal mapped to it would be granted for all.
      if (googleSignals !== undefined && "resources" in googleSignals) {
        for (const field of GOOGLE_MAPPING_KEYS) {
          for (const resourceId of googleSignals.resources[field] ?? []) {
            if (
              declarativeResources.some(
                (resource) =>
                  resource.resourceId === resourceId &&
                  resource.purposeMatch === "any",
              )
            ) {
              throw new TypeError(
                `Consent Mode ${field} is mapped to ${resourceId}, which serves several purposes; map the signals to purposes with purposeMapping.`,
              );
            }
          }
        }
      }

      const now = createVanillaBrowserClock(document, options.now ?? Date.now);
      if (options.store !== undefined && options.storage !== undefined) {
        throw new TypeError(
          "Bootstrap store and storage options are mutually exclusive.",
        );
      }
      if (options.store !== undefined && options.storageKey !== undefined) {
        throw new TypeError(
          "Bootstrap storageKey cannot be used with a caller-owned store.",
        );
      }
      const store =
        options.store ??
        createLocalStorageDecisionStore({
          key: requiredIdentifier(
            options.storageKey ?? "opencookie.consent",
            "Storage key",
          ),
          schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
          storage,
        });

      return ({ controllers, runWhileActive }) => {
        const accessReconciler = createAccessEnforcementReconciler({
          resources: controllers,
        });
        const googleConsentMode =
          establishedGoogleConsentMode?.broadcaster ??
          (configuredGoogleConsentMode === undefined
            ? undefined
            : establishGoogleConsentMode(configuredGoogleConsentMode));
        const enforce = (plan: EffectiveAccessPlan): Promise<void> =>
          runWhileActive(async () => {
            const result = await accessReconciler.reconcile(
              // A declared exception has no markup for the browser to enforce.
              projectAccessEnforcementDecisions(plan).filter(
                ({ resourceId }) => !exceptionIds.has(resourceId),
              ),
            );
            if (result.failures.length > 0) {
              throw new Error(
                `OpenCookie could not enforce ${String(result.failures.length)} declarative resource operation(s).`,
              );
            }
          });
        const broadcast =
          googleConsentMode === undefined && options.broadcast === undefined
            ? undefined
            : async (
                effect: ConsentRuntimeTransitionEffect,
                context?: OpenCookiePortContext,
              ): Promise<void> => {
                if (googleConsentMode !== undefined) {
                  requireGoogleBroadcast(
                    googleConsentMode,
                    googleSignals !== undefined && "purposes" in googleSignals
                      ? projectGoogleConsentModePurposeState(
                          effect.runtime.permittedPurposeIds,
                          googleSignals.purposes,
                        )
                      : projectGoogleConsentModeState(
                          effect.runtime.effectiveAccess,
                          googleSignals?.resources ?? {},
                        ),
                  );
                }
                await options.broadcast?.(effect, context);
              };
        const configuredPolicyHistory = options.policyHistory;
        // A policy in several languages records the one the visitor saw.
        const translated = policy.purposes.some(
          (purpose) => purpose.translations !== undefined,
        );
        const configuredGpc = options.globalPrivacyControl;
        const privacyRestrictions =
          configuredGpc === undefined
            ? options.privacyRestrictions
            : gpcPrivacyRestrictions(document, configuredGpc.purposeIds, now);
        const client = createOpenCookie({
          ...(broadcast === undefined ? {} : { broadcast }),
          consentDurationMs,
          idGenerator:
            options.idGenerator ?? defaultBrowserIdGenerator(document, now),
          ...(translated ? { locale: resolveCopy(options.copy).lang } : {}),
          now,
          policyHistory:
            configuredPolicyHistory === undefined
              ? [policySnapshot]
              : configuredPolicyHistory,
          policySnapshot,
          reconcile: (effect) => enforce(effect.runtime.effectiveAccess),
          ...(privacyRestrictions === undefined ? {} : { privacyRestrictions }),
          ...(options.receipt === undefined
            ? {}
            : { receipt: options.receipt }),
          resourcePolicy: resourceResult.resourcePolicy,
          store,
        });

        return composeVanillaProduct({
          client,
          enforceCurrentAccess: () =>
            enforce(client.getSnapshot().runtime.effectiveAccess),
          now,
        });
      };
    },
  };
}

/**
 * Creates a persistent client and mounts the default accessible interface.
 * The starter catalogue contains one optional analytics purpose and must be
 * replaced with the site's real disclosures before production use.
 *
 * @public
 */
export function bootstrapOpenCookie(
  options: BootstrapOpenCookieOptions = {},
): BootstrappedOpenCookie {
  assertBootstrapOptions(options);
  return createVanillaBrowserRuntime(prepareVanillaBrowserRuntime(options));
}

/**
 * Bootstraps from a script in `<head>`. The denied Google Consent Mode default
 * is sent in the calling task, before any later script can push a measurement
 * command; the rest waits until the document is parsed, so every declared
 * resource is found. A failure after the default leaves Consent Mode denied.
 * An invalid Google mapping rejects before anything is sent.
 *
 * @public
 */
export async function bootstrapOpenCookieFromHead(
  options: BootstrapOpenCookieOptions = {},
): Promise<BootstrappedOpenCookie> {
  assertBootstrapOptions(options);
  const document = resolveDocument(
    options.document,
    "bootstrapOpenCookieFromHead requires a browser document.",
  );
  const configured = options.googleConsentMode;
  let established: EstablishedGoogleConsentMode | undefined;
  if (configured !== undefined) {
    const signals = captureGoogleSignals(configured);
    established = {
      broadcaster: establishGoogleConsentMode(configured),
      signals,
    };
  }
  if (document.readyState === "loading") {
    await new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, { once: true });
    });
  }
  return createVanillaBrowserRuntime(
    prepareVanillaBrowserRuntime(options, established),
  );
}
