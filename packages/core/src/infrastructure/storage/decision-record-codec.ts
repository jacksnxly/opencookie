import type { DecisionStoreReadResult } from "../../application/runtime/initialize-consent.js";
import {
  snapshotPersistedConsentState,
  type PersistedConsentState,
} from "../../application/runtime/persisted-consent-record.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function encodeDecisionRecordEnvelope(
  state: PersistedConsentState,
  schemaVersion: number,
): string {
  const snapshot = snapshotPersistedConsentState(state);
  if (!snapshot.ok) {
    throw new TypeError("Persisted consent state is invalid.");
  }
  return JSON.stringify({ ...snapshot.state, schemaVersion });
}

export function decodeDecisionRecordEnvelope(
  raw: string,
  currentSchemaVersion: number,
): DecisionStoreReadResult {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { reason: "malformed-json", status: "invalid" };
  }

  if (!isObject(value)) {
    return { reason: "invalid-record", status: "invalid" };
  }
  if (!Number.isSafeInteger(value["schemaVersion"])) {
    return { reason: "invalid-record", status: "invalid" };
  }
  if ((value["schemaVersion"] as number) > currentSchemaVersion) {
    return { reason: "future-schema", status: "invalid" };
  }
  if (value["schemaVersion"] !== currentSchemaVersion) {
    return { reason: "invalid-record", status: "invalid" };
  }

  const hasRecord = Object.hasOwn(value, "record");
  const hasPendingGrant = Object.hasOwn(value, "pendingGrant");
  const expectedKeys = [
    ...(hasPendingGrant ? ["pendingGrant"] : []),
    ...(hasRecord ? ["record"] : []),
    "schemaVersion",
  ].sort();
  if ((!hasRecord && !hasPendingGrant) || !hasExactKeys(value, expectedKeys)) {
    return { reason: "invalid-record", status: "invalid" };
  }

  // The state stays flattened so the pre-release record-only envelope
  // `{ record, schemaVersion }` migrates unambiguously to `{ record }`.
  const snapshot = snapshotPersistedConsentState({
    ...(hasRecord ? { record: value["record"] } : {}),
    ...(hasPendingGrant ? { pendingGrant: value["pendingGrant"] } : {}),
  });
  return snapshot.ok
    ? { state: snapshot.state, status: "stored" }
    : { reason: "invalid-record", status: "invalid" };
}
