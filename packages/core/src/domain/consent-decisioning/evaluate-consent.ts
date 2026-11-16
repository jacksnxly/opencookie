import {
  CONSENT_RECORD_SCHEMA_VERSION,
  stableUnique,
  type ConsentPolicyInput,
  type ConsentRecordInput,
} from "./consent-record.js";

/** @public */
export type ConsentEvaluationIssue =
  | {
      readonly code:
        | "decision-in-future"
        | "invalid-decision-value"
        | "invalid-decision-set"
        | "invalid-decision-method"
        | "invalid-decision-interval"
        | "invalid-record-id"
        | "invalid-record-revision"
        | "invalid-timestamp"
        | "invalid-withdrawal-time"
        | "missing-withdrawal-timestamp"
        | "policy-identity-mismatch"
        | "unexpected-withdrawal-timestamp"
        | "unsupported-schema-version"
        | "withdrawal-has-grant";
      readonly path: string;
    }
  | {
      readonly code:
        | "duplicate-purpose-decision"
        | "missing-purpose-decision"
        | "unknown-purpose-id";
      readonly path: string;
      readonly purposeId: string;
    };

/** @public */
export interface ConsentEvaluation {
  readonly issues: readonly ConsentEvaluationIssue[];
  readonly prompt: boolean;
  readonly status:
    "active" | "expired" | "first-visit" | "invalid" | "withdrawn";
}

function result(
  status: ConsentEvaluation["status"],
  prompt: boolean,
  issues: readonly ConsentEvaluationIssue[] = [],
): ConsentEvaluation {
  return Object.freeze({
    issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
    prompt,
    status,
  });
}

/**
 * Evaluates a record at an injected epoch-millisecond instant.
 *
 * @public
 */
export function evaluateConsent(
  record: ConsentRecordInput | undefined,
  policy: ConsentPolicyInput,
  now: number,
): ConsentEvaluation {
  const issues: ConsentEvaluationIssue[] = [];

  const hasValidNow = Number.isSafeInteger(now);
  if (!hasValidNow) {
    issues.push({ code: "invalid-timestamp", path: "now" });
  }
  if (!record) {
    return hasValidNow
      ? result("first-visit", true)
      : result("invalid", true, issues);
  }

  if (record.schemaVersion !== CONSENT_RECORD_SCHEMA_VERSION) {
    issues.push({
      code: "unsupported-schema-version",
      path: "schemaVersion",
    });
  }
  const recordId: unknown = record.recordId;
  if (typeof recordId !== "string" || recordId.trim().length === 0) {
    issues.push({ code: "invalid-record-id", path: "recordId" });
  }
  const revision: unknown = record.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    issues.push({ code: "invalid-record-revision", path: "revision" });
  }
  const method: unknown = record.method;
  if (
    method !== "accept-all" &&
    method !== "granular" &&
    method !== "imported" &&
    method !== "reject-all" &&
    method !== "withdrawal"
  ) {
    issues.push({ code: "invalid-decision-method", path: "method" });
  }
  const hasValidDecidedAt = Number.isSafeInteger(record.decidedAt);
  const hasValidExpiresAt = Number.isSafeInteger(record.expiresAt);
  if (!hasValidDecidedAt) {
    issues.push({ code: "invalid-timestamp", path: "decidedAt" });
  }
  if (!hasValidExpiresAt) {
    issues.push({ code: "invalid-timestamp", path: "expiresAt" });
  }
  if (hasValidDecidedAt && hasValidNow && record.decidedAt > now) {
    issues.push({ code: "decision-in-future", path: "decidedAt" });
  }
  if (
    hasValidDecidedAt &&
    hasValidExpiresAt &&
    record.expiresAt <= record.decidedAt
  ) {
    issues.push({
      code: "invalid-decision-interval",
      path: "expiresAt",
    });
  }
  if (record.method === "withdrawal") {
    const withdrawnAt: unknown = record.withdrawnAt;
    if (withdrawnAt === undefined) {
      issues.push({
        code: "missing-withdrawal-timestamp",
        path: "withdrawnAt",
      });
    } else if (
      typeof withdrawnAt !== "number" ||
      !Number.isSafeInteger(withdrawnAt)
    ) {
      issues.push({ code: "invalid-timestamp", path: "withdrawnAt" });
    } else if (
      (hasValidDecidedAt && withdrawnAt < record.decidedAt) ||
      (hasValidNow && withdrawnAt > now)
    ) {
      issues.push({ code: "invalid-withdrawal-time", path: "withdrawnAt" });
    }
  } else if (Object.hasOwn(record, "withdrawnAt")) {
    issues.push({
      code: "unexpected-withdrawal-timestamp",
      path: "withdrawnAt",
    });
  }

  const identityFields = ["decisionSurfaceDigest", "policyVersion"] as const;
  for (const field of identityFields) {
    if (record.policy[field] !== policy[field]) {
      issues.push({
        code: "policy-identity-mismatch",
        path: `policy.${field}`,
      });
    }
  }

  const expectedPurposeIds = stableUnique(policy.optionalPurposeIds);
  const expectedPurposeIdSet = new Set(expectedPurposeIds);
  const recordedPurposeIds = new Set<string>();
  const grantedPurposeIds = new Set<string>();
  const decisionSet: unknown = record.decisions;
  if (!Array.isArray(decisionSet)) {
    issues.push({ code: "invalid-decision-set", path: "decisions" });
  } else {
    decisionSet.forEach((decision: unknown, index) => {
      if (
        typeof decision !== "object" ||
        decision === null ||
        Array.isArray(decision)
      ) {
        issues.push({
          code: "invalid-decision-set",
          path: `decisions[${String(index)}]`,
        });
        return;
      }
      const purposeId: unknown = Reflect.get(decision, "purposeId");
      if (typeof purposeId !== "string" || purposeId.trim().length === 0) {
        issues.push({
          code: "invalid-decision-set",
          path: `decisions[${String(index)}].purposeId`,
        });
        return;
      }
      if (recordedPurposeIds.has(purposeId)) {
        issues.push({
          code: "duplicate-purpose-decision",
          path: `decisions[${String(index)}].purposeId`,
          purposeId,
        });
      }
      recordedPurposeIds.add(purposeId);
      const decisionValue: unknown = Reflect.get(decision, "value");
      if (decisionValue !== "denied" && decisionValue !== "granted") {
        issues.push({
          code: "invalid-decision-value",
          path: `decisions[${String(index)}].value`,
        });
      }
      if (decisionValue === "granted") grantedPurposeIds.add(purposeId);
      if (!expectedPurposeIdSet.has(purposeId)) {
        issues.push({
          code: "unknown-purpose-id",
          path: `decisions[${String(index)}].purposeId`,
          purposeId,
        });
      }
    });
    for (const purposeId of expectedPurposeIds) {
      if (!recordedPurposeIds.has(purposeId)) {
        issues.push({
          code: "missing-purpose-decision",
          path: "decisions",
          purposeId,
        });
      }
    }
    if (record.method === "withdrawal" && grantedPurposeIds.size > 0) {
      issues.push({ code: "withdrawal-has-grant", path: "decisions" });
    }
  }

  if (issues.length > 0) return result("invalid", true, issues);
  if (record.method === "withdrawal") return result("withdrawn", false);
  if (now >= record.expiresAt) return result("expired", true);
  return result("active", false);
}
