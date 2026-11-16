import type { ConsentRuntimeTransitionEffect } from "../application/runtime/execute-consent-runtime-decision-kernel.js";
import type {
  OpenCookieIdKind,
  OpenCookiePortContext,
} from "../application/runtime/open-cookie-kernel-contract.js";
import {
  captureDataArray,
  captureDataProperty,
  type DataCaptureBudget,
} from "../domain/shared/capture-data-property.js";
import { normalizeIdentifier } from "../domain/policy-catalogue/policy-primitives.js";
import type {
  DiscoveredResourceState,
  EnforcementOperationResult,
} from "../infrastructure/enforcement/reconcile-access.js";
import type { GoogleConsentModeCommand } from "../infrastructure/signals/google-consent-mode.js";
import type { StorageLike } from "../infrastructure/storage/local-storage-decision-store.js";

const MAX_AUTO_INPUT_ENTRIES = 10_000;

const DEFINITION_KEYS = [
  "catalogueRevision",
  "consentDurationMs",
  "consentId",
  "disclosure",
  "locale",
  "policyVersion",
  "purposeId",
  "purposeLabel",
] as const;

const RUNTIME_KEYS = [
  "broadcast",
  "controllers",
  "google",
  "gpc",
  "idGenerator",
  "initialTime",
  "now",
  "onEnforcementReady",
  "onListenerError",
  "persistence",
  "reconcile",
  "resources",
] as const;

const COOKIE_PERSISTENCE_KEYS = [
  "domain",
  "hostname",
  "key",
  "kind",
  "read",
  "registrableDomain",
  "secure",
  "write",
] as const;

const LOCAL_STORAGE_PERSISTENCE_KEYS = ["key", "kind", "storage"] as const;

const UNAVAILABLE_PERSISTENCE_KEYS = ["kind"] as const;

const GPC_KEYS = ["navigationId", "observations"] as const;

const GPC_OBSERVATION_KEYS = ["observedAtMs", "source", "value"] as const;

const GOOGLE_KEYS = ["command", "mapping", "mode"] as const;

const GOOGLE_MAPPING_KEYS = [
  "adPersonalizationResourceIds",
  "adStorageResourceIds",
  "adUserDataResourceIds",
  "analyticsStorageResourceIds",
] as const;

const RESOURCE_KEYS = ["id", "serviceId"] as const;

const CONTROLLER_METHOD_KEYS = [
  "block",
  "cleanup",
  "discover",
  "start",
  "stop",
] as const;

type Fail = () => never;

function invalidDefinition(): never {
  throw new TypeError("Invalid auto consent definition.");
}

function invalidRuntimeOptions(): never {
  throw new TypeError("Invalid auto consent runtime options.");
}

function capturedSource(candidate: unknown, fail: Fail): object {
  try {
    if (
      typeof candidate === "object" &&
      candidate &&
      !Array.isArray(candidate)
    ) {
      return candidate;
    }
  } catch {
    // Invalid or revoked proxies are rejected below.
  }
  fail();
}

function requireExactKeys(
  source: object,
  allowed: readonly string[],
  fail: Fail,
): void {
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(source);
  } catch {
    fail();
  }
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) fail();
  }
}

function ownDataValue(source: object, field: PropertyKey, fail: Fail): unknown {
  const descriptor = captureDataProperty(source, field);
  if (descriptor === undefined) fail();
  return descriptor?.value;
}

function optionalString(value: unknown, fail: Fail): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) fail();
  return value;
}

function requiredString(value: unknown, fail: Fail): string {
  return optionalString(value, fail) ?? fail();
}

function requiredBoolean(value: unknown, fail: Fail): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function optionalSafeInteger(value: unknown, fail: Fail): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail();
  return value;
}

type CapturedCallback = (...args: never[]) => unknown;

function capturedCallback(
  value: unknown,
  receiver: object,
  fail: Fail,
): CapturedCallback {
  if (typeof value !== "function") fail();
  return (...args: never[]) => Reflect.apply(value, receiver, args) as unknown;
}

function optionalCapturedCallback(
  value: unknown,
  receiver: object,
  fail: Fail,
): CapturedCallback | undefined {
  if (value === undefined) return undefined;
  return capturedCallback(value, receiver, fail);
}

/** Immutable auto definition capture with defaults applied. */
export interface CapturedAutoOpenCookieDefinition {
  readonly catalogueRevision: string;
  readonly consentDurationMs: number;
  readonly consentId?: string;
  readonly disclosure: string;
  readonly locale?: string;
  readonly policyVersion: string;
  readonly purposeId: string;
  readonly purposeLabel: string;
}

export type CapturedAutoOpenCookieDefinitionValues = readonly [
  catalogueRevision: string,
  consentDurationMs: number,
  consentId: string | undefined,
  disclosure: string,
  locale: string | undefined,
  policyVersion: string,
  purposeId: string,
  purposeLabel: string,
];

/**
 * Captures the auto factory definition exactly once through own data
 * descriptors. The consent duration is validated before any other field of
 * the definition is observed because policy retention, record expiry, and
 * cookie lifetime all derive from that one validated value.
 */
export function captureAutoOpenCookieDefinitionValues(
  candidate: unknown,
): CapturedAutoOpenCookieDefinitionValues {
  const source = capturedSource(candidate, invalidDefinition);
  const consentDurationMs = ownDataValue(
    source,
    "consentDurationMs",
    invalidDefinition,
  );
  if (
    typeof consentDurationMs !== "number" ||
    !Number.isSafeInteger(consentDurationMs) ||
    consentDurationMs < 1
  ) {
    throw new TypeError("Consent duration must be a positive safe integer.");
  }
  requireExactKeys(source, DEFINITION_KEYS, invalidDefinition);

  const catalogueRevision =
    optionalString(
      ownDataValue(source, "catalogueRevision", invalidDefinition),
      invalidDefinition,
    ) ?? "catalogue-1";
  const consentId = optionalString(
    ownDataValue(source, "consentId", invalidDefinition),
    invalidDefinition,
  );
  const disclosure =
    optionalString(
      ownDataValue(source, "disclosure", invalidDefinition),
      invalidDefinition,
    ) ?? "Understand aggregate site usage.";
  const locale = optionalString(
    ownDataValue(source, "locale", invalidDefinition),
    invalidDefinition,
  );
  const policyVersion =
    optionalString(
      ownDataValue(source, "policyVersion", invalidDefinition),
      invalidDefinition,
    ) ?? "policy-1";
  const purposeId =
    optionalString(
      ownDataValue(source, "purposeId", invalidDefinition),
      invalidDefinition,
    ) ?? "analytics";
  const purposeLabel =
    optionalString(
      ownDataValue(source, "purposeLabel", invalidDefinition),
      invalidDefinition,
    ) ?? "Analytics";

  return Object.freeze([
    catalogueRevision,
    consentDurationMs,
    consentId,
    disclosure,
    locale,
    policyVersion,
    purposeId,
    purposeLabel,
  ]);
}

export function captureAutoOpenCookieDefinition(
  candidate: unknown,
): CapturedAutoOpenCookieDefinition {
  const [
    catalogueRevision,
    consentDurationMs,
    consentId,
    disclosure,
    locale,
    policyVersion,
    purposeId,
    purposeLabel,
  ] = captureAutoOpenCookieDefinitionValues(candidate);
  return Object.freeze({
    catalogueRevision,
    consentDurationMs,
    ...(consentId === undefined ? {} : { consentId }),
    disclosure,
    ...(locale === undefined ? {} : { locale }),
    policyVersion,
    purposeId,
    purposeLabel,
  });
}

export type CapturedAutoPersistence =
  | {
      readonly domain?: string;
      readonly hostname: string;
      readonly key: string;
      readonly kind: "cookie";
      readonly read: () => string;
      readonly registrableDomain?: string;
      readonly secure: boolean;
      readonly write: (serializedCookie: string) => void;
    }
  | {
      readonly key: string;
      readonly kind: "local-storage";
      readonly storage: StorageLike;
    }
  | { readonly kind: "unavailable" };

export type CapturedAutoPersistenceValues =
  | readonly [kind: "unavailable"]
  | readonly [kind: "local-storage", key: string, storage: StorageLike]
  | readonly [
      kind: "cookie",
      domain: string | undefined,
      hostname: string,
      key: string,
      read: () => string,
      registrableDomain: string | undefined,
      secure: boolean,
      write: (serializedCookie: string) => void,
    ];

export interface CapturedAutoGpcObservation {
  readonly observedAtMs: number;
  readonly source: "browser" | "server";
  readonly value: "absent" | "disabled" | "enabled";
}

interface CapturedAutoGpcObservationValues extends CapturedAutoGpcObservation {
  readonly navigationId: string;
}

export interface CapturedAutoGpcInput {
  readonly navigationId: string;
  readonly observations: readonly CapturedAutoGpcObservation[];
}

export type CapturedAutoGpcValues = readonly [
  navigationId: string,
  observations: readonly CapturedAutoGpcObservationValues[],
];

export interface CapturedAutoGoogleMapping {
  readonly adPersonalizationResourceIds?: readonly string[];
  readonly adStorageResourceIds?: readonly string[];
  readonly adUserDataResourceIds?: readonly string[];
  readonly analyticsStorageResourceIds?: readonly string[];
}

export interface CapturedAutoGoogleInput {
  readonly command: GoogleConsentModeCommand;
  readonly mapping: CapturedAutoGoogleMapping;
  readonly mode: "advanced" | "basic";
}

export type CapturedAutoGoogleValues = readonly [
  command: GoogleConsentModeCommand,
  mapping: CapturedAutoGoogleMapping,
  mode: "advanced" | "basic",
];

export interface CapturedAutoController {
  readonly block: () => Promise<EnforcementOperationResult>;
  readonly cleanup: () => Promise<EnforcementOperationResult>;
  readonly discover: () => Promise<DiscoveredResourceState>;
  readonly start: () => Promise<EnforcementOperationResult>;
  readonly stop: () => Promise<void>;
}

export interface CapturedAutoResource {
  readonly id: string;
  readonly serviceId: string;
}

export interface CapturedAutoOpenCookieRuntimeOptions {
  readonly broadcast?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly controllers?: Readonly<Record<string, CapturedAutoController>>;
  readonly google?: CapturedAutoGoogleInput;
  readonly gpc?: CapturedAutoGpcInput;
  readonly idGenerator: (kind: OpenCookieIdKind) => string;
  readonly initialTime?: number;
  readonly now: () => number;
  readonly onEnforcementReady?: (
    enforceCurrentAccess: () => Promise<void>,
  ) => void;
  readonly onListenerError?: (error: unknown) => void;
  readonly persistence: CapturedAutoPersistence;
  readonly resources: readonly CapturedAutoResource[];
  readonly reconcile?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
}

export type CapturedAutoOpenCookieRuntimeValues = readonly [
  broadcast: CapturedAutoOpenCookieRuntimeOptions["broadcast"],
  controllers: CapturedAutoOpenCookieRuntimeOptions["controllers"],
  google: CapturedAutoGoogleValues | undefined,
  gpc: CapturedAutoGpcValues | undefined,
  idGenerator: CapturedAutoOpenCookieRuntimeOptions["idGenerator"],
  initialTime: CapturedAutoOpenCookieRuntimeOptions["initialTime"],
  now: CapturedAutoOpenCookieRuntimeOptions["now"],
  onEnforcementReady: CapturedAutoOpenCookieRuntimeOptions["onEnforcementReady"],
  onListenerError: CapturedAutoOpenCookieRuntimeOptions["onListenerError"],
  persistence: CapturedAutoPersistenceValues,
  reconcile: CapturedAutoOpenCookieRuntimeOptions["reconcile"],
  resources: CapturedAutoOpenCookieRuntimeOptions["resources"],
];

function capturedStorage(value: unknown, fail: Fail): StorageLike {
  if (value === null || typeof value !== "object") fail();
  const source = value;
  const method = (name: "getItem" | "removeItem" | "setItem"): unknown => {
    // Host storage exposes its methods on Storage.prototype, so this one
    // capture intentionally reads through the prototype chain and preserves
    // the storage receiver; the captured facade ignores later replacement.
    try {
      return (source as Record<string, unknown>)[name];
    } catch {
      fail();
    }
  };
  return Object.freeze({
    getItem: capturedCallback(
      method("getItem"),
      source,
      fail,
    ) as StorageLike["getItem"],
    removeItem: capturedCallback(
      method("removeItem"),
      source,
      fail,
    ) as StorageLike["removeItem"],
    setItem: capturedCallback(
      method("setItem"),
      source,
      fail,
    ) as StorageLike["setItem"],
  });
}

function capturedPersistenceValues(
  value: unknown,
  fail: Fail,
): CapturedAutoPersistenceValues {
  const source = capturedSource(value, fail);
  const kind = ownDataValue(source, "kind", fail);
  if (kind === "unavailable") {
    requireExactKeys(source, UNAVAILABLE_PERSISTENCE_KEYS, fail);
    return Object.freeze(["unavailable"]);
  }
  if (kind === "local-storage") {
    requireExactKeys(source, LOCAL_STORAGE_PERSISTENCE_KEYS, fail);
    const key =
      optionalString(ownDataValue(source, "key", fail), fail) ??
      "opencookie.consent";
    return Object.freeze([
      "local-storage",
      key,
      capturedStorage(ownDataValue(source, "storage", fail), fail),
    ]);
  }
  if (kind !== "cookie") fail();
  requireExactKeys(source, COOKIE_PERSISTENCE_KEYS, fail);
  const domain = optionalString(ownDataValue(source, "domain", fail), fail);
  const registrableDomain = optionalString(
    ownDataValue(source, "registrableDomain", fail),
    fail,
  );
  if ((domain === undefined) !== (registrableDomain === undefined)) fail();
  return Object.freeze([
    "cookie",
    domain,
    requiredString(ownDataValue(source, "hostname", fail), fail),
    optionalString(ownDataValue(source, "key", fail), fail) ??
      "opencookie-consent",
    capturedCallback(
      ownDataValue(source, "read", fail),
      source,
      fail,
    ) as () => string,
    registrableDomain,
    requiredBoolean(ownDataValue(source, "secure", fail), fail),
    capturedCallback(ownDataValue(source, "write", fail), source, fail) as (
      serializedCookie: string,
    ) => void,
  ]);
}

function capturedPersistenceObject(
  persistence: CapturedAutoPersistenceValues,
): CapturedAutoPersistence {
  if (persistence[0] === "unavailable") {
    return Object.freeze({ kind: "unavailable" });
  }
  if (persistence[0] === "local-storage") {
    return Object.freeze({
      key: persistence[1],
      kind: persistence[0],
      storage: persistence[2],
    });
  }
  const [kind, domain, hostname, key, read, registrableDomain, secure, write] =
    persistence;
  return Object.freeze({
    ...(domain === undefined ? {} : { domain }),
    hostname,
    key,
    kind,
    read,
    ...(registrableDomain === undefined ? {} : { registrableDomain }),
    secure,
    write,
  });
}

function capturedGpcValues(
  value: unknown,
  budget: DataCaptureBudget,
  fail: Fail,
): CapturedAutoGpcValues | undefined {
  if (value === undefined) return undefined;
  const source = capturedSource(value, fail);
  requireExactKeys(source, GPC_KEYS, fail);
  const navigationId = requiredString(
    ownDataValue(source, "navigationId", fail),
    fail,
  );
  // `fail` never returns, so the helper cannot return `undefined` on invalid input.
  const observations = captureDataArray<CapturedAutoGpcObservationValues>(
    ownDataValue(source, "observations", fail),
    budget,
    (entry) => {
      const observation = capturedSource(entry, fail);
      requireExactKeys(observation, GPC_OBSERVATION_KEYS, fail);
      const observedAtMs = ownDataValue(observation, "observedAtMs", fail);
      if (
        typeof observedAtMs !== "number" ||
        !Number.isSafeInteger(observedAtMs)
      ) {
        fail();
      }
      const observationSource = ownDataValue(observation, "source", fail);
      if (observationSource !== "browser" && observationSource !== "server") {
        fail();
      }
      const observationValue = ownDataValue(observation, "value", fail);
      if (
        observationValue !== "absent" &&
        observationValue !== "disabled" &&
        observationValue !== "enabled"
      ) {
        fail();
      }
      return Object.freeze({
        navigationId,
        observedAtMs,
        source: observationSource,
        value: observationValue,
      });
    },
    fail,
  ) as CapturedAutoGpcObservationValues[];
  return Object.freeze([navigationId, Object.freeze(observations)]);
}

function capturedGpcObject(
  value: CapturedAutoGpcValues | undefined,
): CapturedAutoGpcInput | undefined {
  return value === undefined
    ? undefined
    : Object.freeze({
        navigationId: value[0],
        observations: Object.freeze(
          value[1].map(({ observedAtMs, source, value: observationValue }) =>
            Object.freeze({
              observedAtMs,
              source,
              value: observationValue,
            }),
          ),
        ),
      });
}

function capturedGoogleValues(
  value: unknown,
  budget: DataCaptureBudget,
  fail: Fail,
): CapturedAutoGoogleValues | undefined {
  if (value === undefined) return undefined;
  const source = capturedSource(value, fail);
  requireExactKeys(source, GOOGLE_KEYS, fail);
  const mode = ownDataValue(source, "mode", fail);
  if (mode !== "advanced" && mode !== "basic") fail();
  const mappingValue = ownDataValue(source, "mapping", fail);
  let mapping: CapturedAutoGoogleMapping = Object.freeze({});
  if (mappingValue !== undefined) {
    const mappingSource = capturedSource(mappingValue, fail);
    requireExactKeys(mappingSource, GOOGLE_MAPPING_KEYS, fail);
    const capturedMapping: Record<string, readonly string[]> = {};
    for (const field of GOOGLE_MAPPING_KEYS) {
      const identifiers = ownDataValue(mappingSource, field, fail);
      if (identifiers !== undefined) {
        capturedMapping[field] = Object.freeze(
          captureDataArray<string>(
            identifiers,
            budget,
            (entry) => normalizeIdentifier(entry) || fail(),
            fail,
          ) as string[],
        );
      }
    }
    mapping = Object.freeze(capturedMapping);
  }
  return Object.freeze([
    capturedCallback(
      ownDataValue(source, "command", fail),
      source,
      fail,
    ) as GoogleConsentModeCommand,
    mapping,
    mode,
  ]);
}

function capturedGoogleObject(
  value: CapturedAutoGoogleValues | undefined,
): CapturedAutoGoogleInput | undefined {
  return value === undefined
    ? undefined
    : Object.freeze({ command: value[0], mapping: value[1], mode: value[2] });
}

function capturedControllers(
  value: unknown,
  budget: DataCaptureBudget,
  fail: Fail,
): Readonly<Record<string, CapturedAutoController>> | undefined {
  if (value === undefined) return undefined;
  const source = capturedSource(value, fail);
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(source);
  } catch {
    fail();
  }
  const entries = captureDataArray(
    keys,
    budget,
    (key) => {
      const identifier = normalizeIdentifier(key) || fail();
      const controllerSource = capturedSource(
        ownDataValue(source, key as PropertyKey, fail),
        fail,
      );
      requireExactKeys(controllerSource, CONTROLLER_METHOD_KEYS, fail);
      const controller: Record<string, CapturedCallback> = {};
      for (const method of CONTROLLER_METHOD_KEYS) {
        controller[method] = capturedCallback(
          ownDataValue(controllerSource, method, fail),
          controllerSource,
          fail,
        );
      }
      return [
        identifier,
        Object.freeze(controller) as unknown as CapturedAutoController,
      ] as const;
    },
    fail,
  ) as (readonly [string, CapturedAutoController])[];
  const controllers = Object.fromEntries(entries);
  if (entries.length !== Object.values(controllers).length) fail();
  return Object.freeze(controllers);
}

function capturedResources(
  value: unknown,
  budget: DataCaptureBudget,
  fail: Fail,
): readonly CapturedAutoResource[] {
  if (value === undefined) return Object.freeze([]);
  const resources = captureDataArray<CapturedAutoResource>(
    value,
    budget,
    (entry) => {
      const resource = capturedSource(entry, fail);
      requireExactKeys(resource, RESOURCE_KEYS, fail);
      return Object.freeze({
        id: requiredString(ownDataValue(resource, "id", fail), fail),
        serviceId: requiredString(
          ownDataValue(resource, "serviceId", fail),
          fail,
        ),
      });
    },
    fail,
  ) as CapturedAutoResource[];
  return Object.freeze(resources);
}

/**
 * Captures the auto runtime options exactly once through own data
 * descriptors, cloning and freezing resource identifiers, GPC observations,
 * Google configuration, controllers, callbacks, and store methods before any
 * effect runs. Callback and method receivers are preserved with
 * `Reflect.apply`, so later mutation of the caller's graph changes nothing.
 */
/** Captures one Google input exactly as the runtime options capture it. */
export function captureAutoGoogleValues(
  value: unknown,
): CapturedAutoGoogleValues {
  return (
    capturedGoogleValues(
      value,
      { remaining: MAX_AUTO_INPUT_ENTRIES },
      invalidRuntimeOptions,
    ) ?? invalidRuntimeOptions()
  );
}

export function captureAutoOpenCookieRuntimeValues(
  candidate: unknown,
): CapturedAutoOpenCookieRuntimeValues {
  const fail = invalidRuntimeOptions;
  const source = capturedSource(candidate, fail);
  requireExactKeys(source, RUNTIME_KEYS, fail);
  const budget: DataCaptureBudget = { remaining: MAX_AUTO_INPUT_ENTRIES };

  const broadcast = optionalCapturedCallback(
    ownDataValue(source, "broadcast", fail),
    source,
    fail,
  ) as CapturedAutoOpenCookieRuntimeOptions["broadcast"];
  const controllers = capturedControllers(
    ownDataValue(source, "controllers", fail),
    budget,
    fail,
  );
  const google = capturedGoogleValues(
    ownDataValue(source, "google", fail),
    budget,
    fail,
  );
  const gpc = capturedGpcValues(
    ownDataValue(source, "gpc", fail),
    budget,
    fail,
  );
  const idGenerator = capturedCallback(
    ownDataValue(source, "idGenerator", fail),
    source,
    fail,
  ) as (kind: OpenCookieIdKind) => string;
  const initialTime = optionalSafeInteger(
    ownDataValue(source, "initialTime", fail),
    fail,
  );
  const now = capturedCallback(
    ownDataValue(source, "now", fail),
    source,
    fail,
  ) as () => number;
  const onEnforcementReady = optionalCapturedCallback(
    ownDataValue(source, "onEnforcementReady", fail),
    source,
    fail,
  ) as ((enforceCurrentAccess: () => Promise<void>) => void) | undefined;
  const onListenerError = optionalCapturedCallback(
    ownDataValue(source, "onListenerError", fail),
    source,
    fail,
  ) as ((error: unknown) => void) | undefined;
  const persistence = capturedPersistenceValues(
    ownDataValue(source, "persistence", fail),
    fail,
  );
  const reconcile = optionalCapturedCallback(
    ownDataValue(source, "reconcile", fail),
    source,
    fail,
  ) as CapturedAutoOpenCookieRuntimeOptions["reconcile"];
  const resources = capturedResources(
    ownDataValue(source, "resources", fail),
    budget,
    fail,
  );

  return Object.freeze([
    broadcast,
    controllers,
    google,
    gpc,
    idGenerator,
    initialTime,
    now,
    onEnforcementReady,
    onListenerError,
    persistence,
    reconcile,
    resources,
  ]);
}

export function captureAutoOpenCookieRuntimeOptions(
  candidate: unknown,
): CapturedAutoOpenCookieRuntimeOptions {
  const [
    broadcast,
    controllers,
    google,
    gpc,
    idGenerator,
    initialTime,
    now,
    onEnforcementReady,
    onListenerError,
    persistence,
    reconcile,
    resources,
  ] = captureAutoOpenCookieRuntimeValues(candidate);
  return Object.freeze({
    ...(broadcast === undefined ? {} : { broadcast }),
    ...(controllers === undefined ? {} : { controllers }),
    ...(google === undefined
      ? {}
      : { google: capturedGoogleObject(google) as CapturedAutoGoogleInput }),
    ...(gpc === undefined
      ? {}
      : { gpc: capturedGpcObject(gpc) as CapturedAutoGpcInput }),
    idGenerator,
    ...(initialTime === undefined ? {} : { initialTime }),
    now,
    ...(onEnforcementReady === undefined ? {} : { onEnforcementReady }),
    ...(onListenerError === undefined ? {} : { onListenerError }),
    persistence: capturedPersistenceObject(persistence),
    ...(reconcile === undefined ? {} : { reconcile }),
    resources,
  });
}
