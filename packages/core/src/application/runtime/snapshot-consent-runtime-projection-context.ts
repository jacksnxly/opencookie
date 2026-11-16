import {
  definePolicy,
  snapshotDefinedResourcePolicy,
  type DefinedResourcePolicy,
  type PolicyDefinition,
  type PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import {
  snapshotStoredConsentRecord,
  type ConsentRecord,
} from "../../domain/consent-decisioning/runtime.js";
import type { ProcessingRestrictionSet } from "../../domain/privacy-preference-resolution/index.js";
import type { ServicePreferenceRecord } from "../../domain/terminal-enforcement/index.js";
import type { ConsentRuntimePolicyProjector } from "./consent-policy-reconciliation-contract.js";
import type { ConsentRuntimeProjectionContext } from "./consent-runtime-projection-context.js";
import { MAX_POLICY_HISTORY_LENGTH } from "./policy-history-constraints.js";
import type { ConsentRuntimeProjectionInput } from "./project-consent-runtime-kernel.js";

const MAX_RUNTIME_INPUT_ENTRIES = 10_000;

type RuntimeInputKind =
  | "consent record"
  | "current time"
  | "policy history"
  | "policy snapshot"
  | "privacy restrictions"
  | "resource policy"
  | "service preferences";

type CapturedConsentRuntimeProjectionInputs = Omit<
  ConsentRuntimeProjectionContext,
  "projectPolicy" | "resolveAccess"
>;

interface CaptureBudget {
  remaining: number;
}

function invalidInput(kind: RuntimeInputKind): never {
  throw new TypeError(`Invalid consent runtime ${kind}.`);
}

function inputObject(value: unknown, kind: RuntimeInputKind): object {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidInput(kind);
    }
    return value;
  } catch {
    return invalidInput(kind);
  }
}

function ownDescriptor(
  source: object,
  field: PropertyKey,
  kind: RuntimeInputKind,
  required = true,
): PropertyDescriptor | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor === undefined) {
      if (required || Reflect.has(source, field)) return invalidInput(kind);
      return null;
    }
    return "value" in descriptor ? descriptor : invalidInput(kind);
  } catch {
    return invalidInput(kind);
  }
}

function ownValue(
  source: object,
  field: PropertyKey,
  kind: RuntimeInputKind,
): unknown {
  const descriptor = ownDescriptor(source, field, kind);
  return descriptor === null ? invalidInput(kind) : descriptor.value;
}

function nonBlankOwnString(
  source: object,
  field: string,
  kind: RuntimeInputKind,
): string {
  const value = ownValue(source, field, kind);
  return typeof value === "string" && value.trim().length > 0
    ? value
    : invalidInput(kind);
}

function stringArray(
  value: unknown,
  kind: RuntimeInputKind,
  budget: CaptureBudget,
): readonly string[] {
  try {
    if (!Array.isArray(value)) return invalidInput(kind);
  } catch {
    return invalidInput(kind);
  }
  const length = ownValue(value, "length", kind);
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > budget.remaining
  ) {
    return invalidInput(kind);
  }
  budget.remaining -= length;
  const values: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = ownValue(value, index, kind);
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return invalidInput(kind);
    }
    values.push(entry);
  }
  return Object.freeze(values);
}

function policySnapshot(
  value: unknown,
  kind: "policy history" | "policy snapshot" = "policy snapshot",
): PolicySnapshot {
  const source = inputObject(value, kind);
  const [
    catalogueDigest,
    catalogueRevision,
    decisionSurfaceDigest,
    policyVersion,
  ] = [
    "catalogueDigest",
    "catalogueRevision",
    "decisionSurfaceDigest",
    "policyVersion",
  ].map((field) => nonBlankOwnString(source, field, kind)) as [
    string,
    string,
    string,
    string,
  ];
  let result: ReturnType<typeof definePolicy>;
  try {
    result = definePolicy(ownValue(source, "policy", kind) as PolicyDefinition);
  } catch {
    return invalidInput(kind);
  }
  if (!result.ok) return invalidInput(kind);
  return Object.freeze({
    catalogueDigest,
    catalogueRevision,
    decisionSurfaceDigest,
    policy: result.policy,
    policyVersion,
  });
}

function policyHistory(
  value: unknown,
  current: PolicySnapshot,
): readonly PolicySnapshot[] {
  const kind = "policy history" as const;
  if (value === undefined) return Object.freeze([current]);
  try {
    if (!Array.isArray(value)) return invalidInput(kind);
  } catch {
    return invalidInput(kind);
  }
  const length = ownValue(value, "length", kind);
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > MAX_POLICY_HISTORY_LENGTH
  ) {
    return invalidInput(kind);
  }
  const snapshots: PolicySnapshot[] = [];
  for (let index = 0; index < length; index += 1) {
    snapshots.push(policySnapshot(ownValue(value, index, kind), kind));
  }
  if (
    !snapshots.some(
      (snapshot) =>
        snapshot.catalogueDigest === current.catalogueDigest &&
        snapshot.decisionSurfaceDigest === current.decisionSurfaceDigest &&
        snapshot.policyVersion === current.policyVersion,
    )
  ) {
    return invalidInput(kind);
  }
  return Object.freeze(snapshots);
}

function resourcePolicy(value: unknown): DefinedResourcePolicy {
  const kind = "resource policy" as const;
  let result: ReturnType<typeof snapshotDefinedResourcePolicy>;
  try {
    result = snapshotDefinedResourcePolicy(value);
  } catch {
    return invalidInput(kind);
  }
  return result ?? invalidInput(kind);
}

function privacyRestrictions(
  value: unknown,
  budget: CaptureBudget,
): ProcessingRestrictionSet {
  const kind = "privacy restrictions" as const;
  const source = inputObject(value, kind);
  if (ownValue(source, "source", kind) !== "gpc") return invalidInput(kind);
  return Object.freeze({
    purposeIds: stringArray(ownValue(source, "purposeIds", kind), kind, budget),
    resourceIds: stringArray(
      ownValue(source, "resourceIds", kind),
      kind,
      budget,
    ),
    serviceIds: stringArray(ownValue(source, "serviceIds", kind), kind, budget),
    source: "gpc",
  });
}

function servicePreferences(
  value: unknown,
  budget: CaptureBudget,
): ServicePreferenceRecord {
  const kind = "service preferences" as const;
  const source = inputObject(value, kind);
  return Object.freeze({
    restrictedServiceIds: stringArray(
      ownValue(source, "restrictedServiceIds", kind),
      kind,
      budget,
    ),
  });
}

function snapshotProjectionInputs(
  commandSource: object,
): CapturedConsentRuntimeProjectionInputs {
  const snapshot = policySnapshot(
    ownValue(commandSource, "policySnapshot", "policy snapshot"),
  );
  const budget: CaptureBudget = { remaining: MAX_RUNTIME_INPUT_ENTRIES };
  const capturedResourcePolicy = resourcePolicy(
    ownValue(commandSource, "resourcePolicy", "resource policy"),
  );
  const capturedPrivacyRestrictions = ownDescriptor(
    commandSource,
    "privacyRestrictions",
    "privacy restrictions",
    false,
  );
  const capturedServicePreferences = ownDescriptor(
    commandSource,
    "servicePreferences",
    "service preferences",
    false,
  );
  const capturedPolicyHistory = ownDescriptor(
    commandSource,
    "policyHistory",
    "policy history",
    false,
  );
  return Object.freeze({
    policyHistory: policyHistory(capturedPolicyHistory?.value, snapshot),
    policySnapshot: snapshot,
    ...(capturedPrivacyRestrictions?.value === undefined
      ? {}
      : {
          privacyRestrictions: privacyRestrictions(
            capturedPrivacyRestrictions.value,
            budget,
          ),
        }),
    resourcePolicy: capturedResourcePolicy,
    ...(capturedServicePreferences?.value === undefined
      ? {}
      : {
          servicePreferences: servicePreferences(
            capturedServicePreferences.value,
            budget,
          ),
        }),
  });
}

export function snapshotConsentRuntimeProjectionContext(
  command: unknown,
  projectPolicy: ConsentRuntimePolicyProjector,
  resolveAccess: ConsentRuntimeProjectionContext["resolveAccess"],
): ConsentRuntimeProjectionContext {
  const commandSource = inputObject(command, "policy snapshot");
  return Object.freeze({
    ...snapshotProjectionInputs(commandSource),
    projectPolicy,
    resolveAccess,
  });
}

export function snapshotConsentRuntimeProjectionInput(
  input: unknown,
): ConsentRuntimeProjectionInput {
  const source = inputObject(input, "policy snapshot");
  const projectionInputs = snapshotProjectionInputs(source);
  const capturedRecord = ownDescriptor(
    source,
    "consentRecord",
    "consent record",
    false,
  );
  let consentRecord: ConsentRecord | undefined;
  if (capturedRecord?.value !== undefined) {
    const result = snapshotStoredConsentRecord(capturedRecord.value);
    if (!result.ok) return invalidInput("consent record");
    consentRecord = result.record;
  }
  return Object.freeze({
    ...projectionInputs,
    ...(consentRecord === undefined ? {} : { consentRecord }),
    now: ownValue(source, "now", "current time") as number,
  });
}
