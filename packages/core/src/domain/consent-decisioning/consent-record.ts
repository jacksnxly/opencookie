import { compareStrings } from "../shared/compare-strings.js";
import {
  captureDataArray,
  captureDataProperty,
} from "../shared/capture-data-property.js";

/** @public */
export const CONSENT_RECORD_SCHEMA_VERSION = 1 as const;

/** @public */
export type ConsentRecordSchemaVersion = 1;

/** @public */
export type ConsentDecision = "denied" | "granted";

/** @public */
export type ConsentDecisionState = ConsentDecision | "unresolved";

/** @public */
export type ConsentDecisionMethod =
  "accept-all" | "granular" | "imported" | "reject-all" | "withdrawal";

/** @public */
export interface ConsentPolicyIdentityInput {
  readonly catalogueDigest: string;
  readonly decisionSurfaceDigest: string;
  readonly policyVersion: string;
}

/** @public */
export interface ConsentPolicyInput extends ConsentPolicyIdentityInput {
  readonly optionalPurposeIds: readonly string[];
}

/** @public */
export interface ConsentPolicyAffectedPurposeInput {
  readonly purposeId: string;
  readonly reasonCodes: readonly string[];
}

/** @public */
export interface ConsentPolicyChangeSetInput {
  readonly addedPurposeIds: readonly string[];
  readonly affectedPurposes: readonly ConsentPolicyAffectedPurposeInput[];
  readonly currentIdentity: ConsentPolicyIdentityInput;
  readonly previousIdentity: ConsentPolicyIdentityInput;
  readonly removedPurposeIds: readonly string[];
}

/** @public */
export interface PurposeDecision {
  readonly purposeId: string;
  readonly value: ConsentDecision;
}

/** @public */
export interface PurposeDecisionState {
  readonly purposeId: string;
  readonly value: ConsentDecisionState;
}

/** @public */
export interface ConsentRecordBase {
  readonly consentId?: string;
  readonly decidedAt: number;
  readonly decisions: readonly PurposeDecision[];
  readonly expiresAt: number;
  readonly locale?: string;
  readonly policy: ConsentPolicyIdentityInput;
  readonly recordId: string;
  readonly revision: number;
  readonly schemaVersion: ConsentRecordSchemaVersion;
}

/** @public */
export type ConsentRecord = ConsentRecordBase &
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
export type ConsentRecordInput = Omit<ConsentRecordBase, "schemaVersion"> & {
  readonly schemaVersion: number;
} & (
    | {
        readonly method: Exclude<ConsentDecisionMethod, "withdrawal">;
        readonly withdrawnAt?: never;
      }
    | {
        readonly method: "withdrawal";
        readonly withdrawnAt: number;
      }
  );

export type CurrentConsentRecordPath =
  | "current"
  | "current.consentId"
  | "current.decidedAt"
  | "current.decisions"
  | "current.expiresAt"
  | "current.locale"
  | "current.method"
  | "current.policy"
  | "current.recordId"
  | "current.revision"
  | "current.schemaVersion"
  | "current.withdrawnAt";

type ConsentPolicyInputPath =
  | "policy"
  | "policy.catalogueDigest"
  | "policy.decisionSurfaceDigest"
  | "policy.optionalPurposeIds"
  | "policy.policyVersion";

function isRecordObject(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/** Internal result used to carry one validated immutable record snapshot. */
export type ConsentRecordSnapshotResult =
  | {
      readonly ok: false;
      readonly path: CurrentConsentRecordPath;
    }
  | {
      readonly ok: true;
      readonly record: ConsentRecord;
    };

/** Internal result used to carry one validated immutable policy snapshot. */
export type ConsentPolicyInputSnapshotResult =
  | {
      readonly ok: false;
      readonly path: ConsentPolicyInputPath;
    }
  | {
      readonly ok: true;
      readonly policy: ConsentPolicyInput;
    };

export function snapshotConsentPolicyInput(
  candidate: unknown,
): ConsentPolicyInputSnapshotResult {
  const invalid = (
    path: ConsentPolicyInputPath,
  ): ConsentPolicyInputSnapshotResult => ({ ok: false, path });
  if (!isRecordObject(candidate)) return invalid("policy");

  const capturedCatalogueDigest = captureDataProperty(
    candidate,
    "catalogueDigest",
  );
  if (
    !capturedCatalogueDigest ||
    !isNonBlankString(capturedCatalogueDigest.value)
  ) {
    return invalid("policy.catalogueDigest");
  }
  const capturedDecisionSurfaceDigest = captureDataProperty(
    candidate,
    "decisionSurfaceDigest",
  );
  if (
    !capturedDecisionSurfaceDigest ||
    !isNonBlankString(capturedDecisionSurfaceDigest.value)
  ) {
    return invalid("policy.decisionSurfaceDigest");
  }
  const capturedPolicyVersion = captureDataProperty(candidate, "policyVersion");
  if (
    !capturedPolicyVersion ||
    !isNonBlankString(capturedPolicyVersion.value)
  ) {
    return invalid("policy.policyVersion");
  }

  const capturedOptionalPurposeIds = captureDataProperty(
    candidate,
    "optionalPurposeIds",
  );
  const capturedPurposeIds = captureDataArray(
    capturedOptionalPurposeIds?.value,
  );
  if (!capturedPurposeIds) return invalid("policy.optionalPurposeIds");
  const purposeIds: string[] = [];
  for (const purposeId of capturedPurposeIds) {
    if (!isNonBlankString(purposeId)) {
      return invalid("policy.optionalPurposeIds");
    }
    purposeIds.push(purposeId);
  }

  return {
    ok: true,
    policy: Object.freeze({
      catalogueDigest: capturedCatalogueDigest.value,
      decisionSurfaceDigest: capturedDecisionSurfaceDigest.value,
      optionalPurposeIds: stableUnique(purposeIds),
      policyVersion: capturedPolicyVersion.value,
    }),
  };
}

function captureRecord(
  candidate: unknown,
  allowBlankPolicyIdentity: boolean,
  requireAdvanceable: boolean,
): ConsentRecordSnapshotResult {
  const invalid = (
    path: CurrentConsentRecordPath,
  ): ConsentRecordSnapshotResult => ({ ok: false, path });
  if (!isRecordObject(candidate)) return invalid("current");

  const schemaVersion = captureDataProperty(candidate, "schemaVersion");
  if (schemaVersion?.value !== CONSENT_RECORD_SCHEMA_VERSION) {
    return invalid("current.schemaVersion");
  }

  const capturedMethod = captureDataProperty(candidate, "method");
  const method = capturedMethod?.value;
  if (
    method !== "accept-all" &&
    method !== "granular" &&
    method !== "imported" &&
    method !== "reject-all" &&
    method !== "withdrawal"
  ) {
    return invalid("current.method");
  }

  const capturedDecidedAt = captureDataProperty(candidate, "decidedAt");
  const decidedAt = capturedDecidedAt?.value;
  if (!capturedDecidedAt || !isSafeInteger(decidedAt)) {
    return invalid("current.decidedAt");
  }
  const capturedExpiresAt = captureDataProperty(candidate, "expiresAt");
  const expiresAt = capturedExpiresAt?.value;
  if (!isSafeInteger(expiresAt) || expiresAt <= decidedAt) {
    return invalid("current.expiresAt");
  }
  const capturedRevision = captureDataProperty(candidate, "revision");
  const revision = capturedRevision?.value;
  if (
    !capturedRevision ||
    !isSafeInteger(revision) ||
    revision < 1 ||
    (requireAdvanceable && revision >= Number.MAX_SAFE_INTEGER)
  ) {
    return invalid("current.revision");
  }

  const capturedRecordId = captureDataProperty(candidate, "recordId");
  const recordId = capturedRecordId?.value;
  if (!capturedRecordId || !isNonBlankString(recordId)) {
    return invalid("current.recordId");
  }

  const capturedConsentId = captureDataProperty(candidate, "consentId");
  const consentId = capturedConsentId?.value;
  if (
    capturedConsentId === undefined ||
    (consentId !== undefined && !isNonBlankString(consentId))
  ) {
    return invalid("current.consentId");
  }

  const capturedLocale = captureDataProperty(candidate, "locale");
  const locale = capturedLocale?.value;
  if (
    capturedLocale === undefined ||
    (locale !== undefined && typeof locale !== "string")
  ) {
    return invalid("current.locale");
  }

  const capturedPolicy = captureDataProperty(candidate, "policy");
  const policy = capturedPolicy?.value;
  const validIdentity = (value: unknown): value is string =>
    typeof value === "string" && (allowBlankPolicyIdentity || !!value.trim());
  if (!capturedPolicy || !isRecordObject(policy)) {
    return invalid("current.policy");
  }
  const capturedCatalogueDigest = captureDataProperty(
    policy,
    "catalogueDigest",
  );
  const capturedDecisionSurfaceDigest = captureDataProperty(
    policy,
    "decisionSurfaceDigest",
  );
  const capturedPolicyVersion = captureDataProperty(policy, "policyVersion");
  if (
    !capturedCatalogueDigest ||
    !capturedDecisionSurfaceDigest ||
    !capturedPolicyVersion ||
    !validIdentity(capturedCatalogueDigest.value) ||
    !validIdentity(capturedDecisionSurfaceDigest.value) ||
    !validIdentity(capturedPolicyVersion.value)
  ) {
    return invalid("current.policy");
  }

  const capturedWithdrawnAt = captureDataProperty(candidate, "withdrawnAt");
  if (capturedWithdrawnAt === undefined) return invalid("current.withdrawnAt");
  const withdrawnAt = capturedWithdrawnAt?.value;
  if (method === "withdrawal") {
    if (!isSafeInteger(withdrawnAt) || withdrawnAt < decidedAt) {
      return invalid("current.withdrawnAt");
    }
  } else if (capturedWithdrawnAt !== null) {
    return invalid("current.withdrawnAt");
  }

  const capturedDecisions = captureDataProperty(candidate, "decisions");
  const decisions = capturedDecisions?.value;
  if (!capturedDecisions) return invalid("current.decisions");
  const decisionEntries = captureDataArray(decisions);
  if (!decisionEntries) return invalid("current.decisions");
  const purposeIds = new Set<string>();
  const capturedDecisionEntries: PurposeDecision[] = [];
  for (const decision of decisionEntries) {
    if (!isRecordObject(decision)) {
      return invalid("current.decisions");
    }
    const capturedPurposeId = captureDataProperty(decision, "purposeId");
    const capturedValue = captureDataProperty(decision, "value");
    const purposeId = capturedPurposeId?.value;
    const value = capturedValue?.value;
    if (
      !capturedPurposeId ||
      !capturedValue ||
      !isNonBlankString(purposeId) ||
      purposeIds.has(purposeId) ||
      (value !== "denied" && value !== "granted") ||
      (method === "withdrawal" && value === "granted")
    ) {
      return invalid("current.decisions");
    }
    purposeIds.add(purposeId);
    capturedDecisionEntries.push({ purposeId, value });
  }

  const record = freezeConsentRecord({
    ...(consentId === undefined ? {} : { consentId }),
    decidedAt,
    decisions: capturedDecisionEntries,
    expiresAt,
    ...(locale === undefined ? {} : { locale }),
    method,
    policy: {
      catalogueDigest: capturedCatalogueDigest.value,
      decisionSurfaceDigest: capturedDecisionSurfaceDigest.value,
      policyVersion: capturedPolicyVersion.value,
    },
    recordId,
    revision,
    schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
    ...(method === "withdrawal" ? { withdrawnAt } : {}),
  } as ConsentRecord);
  return { ok: true, record };
}

export function snapshotConsentRecord(
  candidate: unknown,
): ConsentRecordSnapshotResult {
  return captureRecord(candidate, false, false);
}

export function snapshotStoredConsentRecord(
  candidate: unknown,
): ConsentRecordSnapshotResult {
  return captureRecord(candidate, true, false);
}

export function snapshotCurrentConsentRecord(
  candidate: unknown,
): ConsentRecordSnapshotResult {
  return captureRecord(candidate, false, true);
}

export function invalidConsentRecordPath(
  candidate: unknown,
): CurrentConsentRecordPath | undefined {
  const snapshot = snapshotConsentRecord(candidate);
  return snapshot.ok ? undefined : snapshot.path;
}

export function invalidStoredConsentRecordPath(
  candidate: unknown,
): CurrentConsentRecordPath | undefined {
  const snapshot = snapshotStoredConsentRecord(candidate);
  return snapshot.ok ? undefined : snapshot.path;
}

export function invalidCurrentConsentRecordPath(
  candidate: unknown,
): CurrentConsentRecordPath | undefined {
  const snapshot = snapshotCurrentConsentRecord(candidate);
  return snapshot.ok ? undefined : snapshot.path;
}

export function comparePurposeId(
  left: { readonly purposeId: string },
  right: { readonly purposeId: string },
): number {
  return compareStrings(left.purposeId, right.purposeId);
}

export function freezeIdentity(
  identity: ConsentPolicyIdentityInput,
): ConsentPolicyIdentityInput {
  return Object.freeze({
    catalogueDigest: identity.catalogueDigest,
    decisionSurfaceDigest: identity.decisionSurfaceDigest,
    policyVersion: identity.policyVersion,
  });
}

export function sameIdentity(
  left: ConsentPolicyIdentityInput,
  right: ConsentPolicyIdentityInput,
): boolean {
  return (
    left.catalogueDigest === right.catalogueDigest &&
    left.decisionSurfaceDigest === right.decisionSurfaceDigest &&
    left.policyVersion === right.policyVersion
  );
}

export function sameDecisionSurface(
  left: ConsentPolicyIdentityInput,
  right: ConsentPolicyIdentityInput,
): boolean {
  return (
    left.decisionSurfaceDigest === right.decisionSurfaceDigest &&
    left.policyVersion === right.policyVersion
  );
}

export function stableUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareStrings));
}

export function freezeConsentRecord(record: ConsentRecord): ConsentRecord {
  const base = {
    ...(record.consentId === undefined ? {} : { consentId: record.consentId }),
    decidedAt: record.decidedAt,
    decisions: Object.freeze(
      record.decisions
        .map((decision) =>
          Object.freeze({
            purposeId: decision.purposeId,
            value: decision.value,
          }),
        )
        .sort(comparePurposeId),
    ),
    expiresAt: record.expiresAt,
    ...(record.locale === undefined ? {} : { locale: record.locale }),
    policy: freezeIdentity(record.policy),
    recordId: record.recordId,
    revision: record.revision,
    schemaVersion: record.schemaVersion,
  };

  return record.method === "withdrawal"
    ? Object.freeze({
        ...base,
        method: record.method,
        withdrawnAt: record.withdrawnAt,
      })
    : Object.freeze({ ...base, method: record.method });
}
