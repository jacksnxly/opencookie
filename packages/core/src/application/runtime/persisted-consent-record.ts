import {
  CONSENT_RECORD_SCHEMA_VERSION,
  rehydrateConsentRecord,
  snapshotStoredConsentRecord,
  type ConsentDecisionMethod,
  type ConsentRecord,
} from "../../domain/consent-decisioning/runtime.js";

/** @public */
export interface PersistedDecisionRecordBase {
  readonly catalogueDigest: string;
  readonly consentId?: string;
  readonly decidedAt: number;
  readonly decisionSurfaceDigest: string;
  readonly decisions: Readonly<Record<string, "denied" | "granted">>;
  readonly expiresAt: number;
  readonly locale?: string;
  readonly policyVersion: string;
  readonly recordId: string;
  readonly revision: number;
}

/** @public */
export type PersistedDecisionRecord = PersistedDecisionRecordBase &
  (
    | {
        readonly method: Exclude<ConsentDecisionMethod, "withdrawal">;
        readonly withdrawnAt?: never;
      }
    | {
        readonly method: "withdrawal";
        readonly withdrawnAt: number;
      }
  );

/** @public */
export type PersistedPendingGrant =
  | {
      readonly candidate: PersistedDecisionRecord;
      readonly kind: "decision";
      readonly receiptOccurredAt: number;
      readonly transitionId: string;
    }
  | {
      readonly kind: "restore";
      readonly transitionId: string;
    };

/** @public */
export type PersistedConsentState =
  | {
      readonly pendingGrant?: PersistedPendingGrant;
      readonly record: PersistedDecisionRecord;
    }
  | {
      readonly pendingGrant: Extract<
        PersistedPendingGrant,
        { readonly kind: "decision" }
      >;
      readonly record?: never;
    };

type CapturedDataObject = ReadonlyMap<string, unknown>;

export type PersistedConsentStateSnapshotResult =
  | { readonly ok: false }
  | { readonly ok: true; readonly state: PersistedConsentState };

function captureDataObject(value: unknown): CapturedDataObject | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  try {
    if (Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const captured = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return undefined;
      }
      captured.set(key, descriptor.value);
    }
    return captured;
  } catch {
    return undefined;
  }
}

function captureClosedDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): CapturedDataObject | undefined {
  const captured = captureDataObject(value);
  if (!captured) return undefined;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => captured.has(key)) &&
    [...captured.keys()].every((key) => allowed.has(key))
    ? captured
    : undefined;
}

function snapshotPersistedDecisionRecord(
  value: unknown,
): PersistedDecisionRecord | undefined {
  const captured = captureClosedDataObject(
    value,
    [
      "catalogueDigest",
      "decidedAt",
      "decisionSurfaceDigest",
      "decisions",
      "expiresAt",
      "method",
      "policyVersion",
      "recordId",
      "revision",
    ],
    ["consentId", "locale", "withdrawnAt"],
  );
  if (!captured) return undefined;

  const capturedDecisions = captureDataObject(captured.get("decisions"));
  if (!capturedDecisions) return undefined;
  const decisions = [...capturedDecisions]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([purposeId, decision]) => ({ purposeId, value: decision }));

  const candidate: Record<string, unknown> = {
    decisions,
    policy: {
      catalogueDigest: captured.get("catalogueDigest"),
      decisionSurfaceDigest: captured.get("decisionSurfaceDigest"),
      policyVersion: captured.get("policyVersion"),
    },
    schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
  };
  for (const field of [
    "consentId",
    "decidedAt",
    "expiresAt",
    "locale",
    "method",
    "recordId",
    "revision",
    "withdrawnAt",
  ]) {
    if (captured.has(field)) candidate[field] = captured.get(field);
  }
  const snapshot = snapshotStoredConsentRecord(candidate);
  return snapshot.ok ? toPersistedDecisionRecord(snapshot.record) : undefined;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function snapshotPendingGrant(
  value: unknown,
  record: PersistedDecisionRecord | undefined,
): PersistedPendingGrant | undefined {
  const captured = captureDataObject(value);
  const kind = captured?.get("kind");
  if (kind === "restore") {
    if (
      !record ||
      record.method === "reject-all" ||
      record.method === "withdrawal" ||
      !Object.values(record.decisions).includes("granted") ||
      captured?.size !== 2 ||
      !captured.has("transitionId") ||
      !nonBlankString(captured.get("transitionId"))
    ) {
      return undefined;
    }
    return Object.freeze({
      kind,
      transitionId: captured.get("transitionId") as string,
    });
  }
  if (
    kind !== "decision" ||
    captured?.size !== 4 ||
    !captured.has("candidate") ||
    !captured.has("receiptOccurredAt") ||
    !captured.has("transitionId") ||
    !nonBlankString(captured.get("transitionId"))
  ) {
    return undefined;
  }

  const candidate = snapshotPersistedDecisionRecord(captured.get("candidate"));
  const receiptOccurredAt = captured.get("receiptOccurredAt");
  if (
    !candidate ||
    candidate.method === "reject-all" ||
    candidate.method === "withdrawal" ||
    !Object.values(candidate.decisions).includes("granted") ||
    !Number.isSafeInteger(receiptOccurredAt) ||
    (receiptOccurredAt as number) < candidate.decidedAt ||
    (record === undefined
      ? candidate.revision !== 1
      : candidate.recordId !== record.recordId ||
        candidate.revision !== record.revision + 1 ||
        candidate.decidedAt <
          (record.method === "withdrawal"
            ? record.withdrawnAt
            : record.decidedAt))
  ) {
    return undefined;
  }

  return Object.freeze({
    candidate,
    kind,
    receiptOccurredAt: receiptOccurredAt as number,
    transitionId: captured.get("transitionId") as string,
  });
}

export function snapshotPersistedConsentState(
  candidate: unknown,
): PersistedConsentStateSnapshotResult {
  const captured = captureClosedDataObject(
    candidate,
    [],
    ["pendingGrant", "record"],
  );
  if (!captured) return { ok: false };

  const hasRecord = captured.has("record");
  const record = hasRecord
    ? snapshotPersistedDecisionRecord(captured.get("record"))
    : undefined;
  if (hasRecord && !record) return { ok: false };

  const hasPendingGrant = captured.has("pendingGrant");
  const pendingGrant = hasPendingGrant
    ? snapshotPendingGrant(captured.get("pendingGrant"), record)
    : undefined;
  if (hasPendingGrant && !pendingGrant) return { ok: false };
  if (!record && (!pendingGrant || pendingGrant.kind !== "decision")) {
    return { ok: false };
  }

  return {
    ok: true,
    state: Object.freeze({
      ...(record ? { record } : {}),
      ...(pendingGrant ? { pendingGrant } : {}),
    }) as PersistedConsentState,
  };
}

export function persistedConsentStatesEqual(
  left: unknown,
  right: unknown,
): boolean {
  const leftSnapshot = snapshotPersistedConsentState(left);
  const rightSnapshot = snapshotPersistedConsentState(right);
  return (
    leftSnapshot.ok &&
    rightSnapshot.ok &&
    JSON.stringify(leftSnapshot.state) === JSON.stringify(rightSnapshot.state)
  );
}

/** @public */
export function toPersistedDecisionRecord(
  record: ConsentRecord,
): PersistedDecisionRecord {
  const decisions = Object.create(null) as Record<string, "denied" | "granted">;
  for (const decision of record.decisions) {
    decisions[decision.purposeId] = decision.value;
  }

  const base = {
    catalogueDigest: record.policy.catalogueDigest,
    ...(record.consentId === undefined ? {} : { consentId: record.consentId }),
    decidedAt: record.decidedAt,
    decisionSurfaceDigest: record.policy.decisionSurfaceDigest,
    decisions: Object.freeze(decisions),
    expiresAt: record.expiresAt,
    ...(record.locale === undefined ? {} : { locale: record.locale }),
    policyVersion: record.policy.policyVersion,
    recordId: record.recordId,
    revision: record.revision,
  };

  return record.method === "withdrawal"
    ? Object.freeze({
        ...base,
        method: record.method,
        withdrawnAt: record.withdrawnAt,
      })
    : Object.freeze({ ...base, method: record.method });
}

/** @public */
export function toConsentRecord(
  record: PersistedDecisionRecord,
): ConsentRecord {
  const base = {
    ...(record.consentId === undefined ? {} : { consentId: record.consentId }),
    decidedAt: record.decidedAt,
    decisions: Object.entries(record.decisions).map(([purposeId, value]) => ({
      purposeId,
      value,
    })),
    expiresAt: record.expiresAt,
    ...(record.locale === undefined ? {} : { locale: record.locale }),
    policy: {
      catalogueDigest: record.catalogueDigest,
      decisionSurfaceDigest: record.decisionSurfaceDigest,
      policyVersion: record.policyVersion,
    },
    recordId: record.recordId,
    revision: record.revision,
    schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
  };

  return rehydrateConsentRecord(
    record.method === "withdrawal"
      ? { ...base, method: record.method, withdrawnAt: record.withdrawnAt }
      : { ...base, method: record.method },
  );
}
