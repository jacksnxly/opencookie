import {
  comparePurposeId,
  evaluateConsent,
  freezeIdentity,
  planReconsent,
  sameIdentity,
  type ConsentPolicyAffectedPurposeInput,
  type ConsentPolicyChangeSetInput,
  type ConsentPolicyInput,
  type ConsentRecord,
  type PurposeDecisionState,
  type ReconsentPlan,
  snapshotStoredConsentRecord,
} from "../../domain/consent-decisioning/index.js";
import {
  createPolicySnapshot,
  definePolicy,
  diffPolicies,
  isSupportedPolicyIdentity,
  type PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import {
  captureDataArray,
  captureDataProperty,
} from "../../domain/shared/index.js";
import type {
  ConsentPolicyReconciliation,
  ConsentPolicyReconciliationInput,
  ConsentPolicyReconciliationIssue,
  PolicyReconciler,
} from "../../reconciliation/contract.js";
import { MAX_POLICY_HISTORY_LENGTH } from "./policy-history-constraints.js";

const INVALID_POLICY_SNAPSHOT = Symbol("invalid-policy-snapshot");
const INVALID_POLICY_IDENTITY = "invalid-policy-snapshot";
const INVALID_CURRENT_POLICY = Object.freeze({
  catalogueDigest: INVALID_POLICY_IDENTITY,
  decisionSurfaceDigest: INVALID_POLICY_IDENTITY,
  optionalPurposeIds: Object.freeze([]),
  policyVersion: INVALID_POLICY_IDENTITY,
});

function objectValue(candidate: unknown): object | undefined {
  try {
    return candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate)
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function ownValue(source: object, field: PropertyKey): unknown {
  const descriptor = captureDataProperty(source, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Creates a reconciler bound to OpenCookie's canonical, collision-resistant
 * policy identity scheme. No caller-provided verifier enters reconciliation
 * data.
 *
 * @public
 */
export function createPolicyReconciler(): PolicyReconciler {
  return Object.freeze({
    reconcile: (input: ConsentPolicyReconciliationInput) =>
      reconcileConsentPolicy(input),
  });
}

function capturePolicySnapshot(candidate: unknown): PolicySnapshot | undefined {
  const source = objectValue(candidate);
  if (source === undefined) return undefined;
  const catalogueDigest = ownValue(source, "catalogueDigest");
  const catalogueRevision = ownValue(source, "catalogueRevision");
  const decisionSurfaceDigest = ownValue(source, "decisionSurfaceDigest");
  const policyVersion = ownValue(source, "policyVersion");
  if (
    !nonBlankString(catalogueDigest) ||
    !nonBlankString(catalogueRevision) ||
    !nonBlankString(decisionSurfaceDigest) ||
    !nonBlankString(policyVersion)
  ) {
    return undefined;
  }
  let defined: ReturnType<typeof definePolicy>;
  try {
    defined = definePolicy(ownValue(source, "policy") as never);
  } catch {
    return undefined;
  }
  if (!defined.ok) return undefined;
  return Object.freeze({
    catalogueDigest,
    catalogueRevision,
    decisionSurfaceDigest,
    policy: defined.policy,
    policyVersion,
  });
}

interface CapturedPolicyHistory {
  readonly snapshots: readonly PolicySnapshot[];
  readonly valid: boolean;
}

function capturePolicyHistory(candidate: unknown): CapturedPolicyHistory {
  const captured: unknown = captureDataArray(
    candidate,
    MAX_POLICY_HISTORY_LENGTH,
    (entry) => capturePolicySnapshot(entry) ?? INVALID_POLICY_SNAPSHOT,
    () => undefined,
  );
  const snapshots = Array.isArray(captured)
    ? captured.filter(
        (entry): entry is PolicySnapshot => entry !== INVALID_POLICY_SNAPSHOT,
      )
    : [];
  return Object.freeze({
    snapshots: Object.freeze(snapshots),
    valid:
      Array.isArray(captured) &&
      captured.every((entry) => entry !== INVALID_POLICY_SNAPSHOT),
  });
}

interface VerifiedPolicySnapshot {
  readonly matches: boolean;
  readonly policy: ConsentPolicyInput;
}

function verifySnapshotIdentity(
  snapshot: PolicySnapshot,
): VerifiedPolicySnapshot | undefined {
  try {
    const derived = createPolicySnapshot({
      catalogueRevision: snapshot.catalogueRevision,
      policy: snapshot.policy,
      policyVersion: snapshot.policyVersion,
    });
    const { catalogueDigest, decisionSurfaceDigest } = derived;
    return Object.freeze({
      matches:
        catalogueDigest === snapshot.catalogueDigest &&
        decisionSurfaceDigest === snapshot.decisionSurfaceDigest,
      policy: Object.freeze({
        ...consentPolicy(snapshot),
        catalogueDigest,
        decisionSurfaceDigest,
      }),
    });
  } catch {
    return undefined;
  }
}

function unverifiedPolicy(snapshot: PolicySnapshot): ConsentPolicyInput {
  return Object.freeze({
    ...consentPolicy(snapshot),
    catalogueDigest: INVALID_POLICY_IDENTITY,
    decisionSurfaceDigest: INVALID_POLICY_IDENTITY,
  });
}

function consentPolicy(snapshot: PolicySnapshot): ConsentPolicyInput {
  return Object.freeze({
    catalogueDigest: snapshot.catalogueDigest,
    decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
    optionalPurposeIds: Object.freeze(
      snapshot.policy.purposes.map(({ id }) => id),
    ),
    policyVersion: snapshot.policyVersion,
  });
}

function sameRecordIdentity(
  snapshot: PolicySnapshot,
  record: ConsentRecord,
): boolean {
  return sameIdentity(snapshot, record.policy);
}

function hasDuplicateHistory(history: readonly PolicySnapshot[]): boolean {
  return history.some((snapshot, index) =>
    history
      .slice(index + 1)
      .some((candidate) => sameIdentity(snapshot, candidate)),
  );
}

function freezeAffectedPurposes(
  affected: readonly ConsentPolicyAffectedPurposeInput[],
): readonly ConsentPolicyAffectedPurposeInput[] {
  return Object.freeze(
    affected
      .map(({ purposeId, reasonCodes }) =>
        Object.freeze({
          purposeId,
          reasonCodes: Object.freeze([...reasonCodes]),
        }),
      )
      .sort(comparePurposeId),
  );
}

function freezeDecisions(
  decisions: readonly PurposeDecisionState[],
): readonly PurposeDecisionState[] {
  return Object.freeze(
    decisions
      .map((decision) => Object.freeze({ ...decision }))
      .sort(comparePurposeId),
  );
}

function freezeIssues(
  issues: readonly ConsentPolicyReconciliationIssue[],
): readonly ConsentPolicyReconciliationIssue[] {
  return Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
}

function result(
  policy: ConsentPolicyInput,
  status: ConsentPolicyReconciliation["status"],
  decisions: readonly PurposeDecisionState[],
  affectedPurposes: readonly ConsentPolicyAffectedPurposeInput[],
  issues: readonly ConsentPolicyReconciliationIssue[],
): ConsentPolicyReconciliation {
  return Object.freeze({
    affectedPurposes: freezeAffectedPurposes(affectedPurposes),
    decisions: freezeDecisions(decisions),
    issues: freezeIssues(issues),
    policy: freezeIdentity(policy),
    prompt: status !== "current" && status !== "withdrawn",
    status,
  });
}

function conservativeResult(
  policy: ConsentPolicyInput,
  record: ConsentRecord | undefined,
  status: "expired" | "invalid",
  issues: readonly ConsentPolicyReconciliationIssue[],
  validatedWithdrawal = false,
): ConsentPolicyReconciliation {
  const decisionsByPurpose = new Map(
    record?.decisions.map(({ purposeId, value }) => [purposeId, value]),
  );
  const decisions = policy.optionalPurposeIds.map((purposeId) => ({
    purposeId,
    value:
      decisionsByPurpose.get(purposeId) === "denied"
        ? ("denied" as const)
        : ("unresolved" as const),
  }));
  return result(
    policy,
    validatedWithdrawal ? "withdrawn" : status,
    decisions,
    decisions
      .filter(({ value }) => value === "unresolved")
      .map(({ purposeId }) => ({
        purposeId,
        reasonCodes: ["identity-unverified"],
      })),
    issues,
  );
}

function validatesAsWithdrawal(
  record: ConsentRecord,
  policy: ConsentPolicyInput,
  now: number,
): boolean {
  return evaluateConsent(record, policy, now).status === "withdrawn";
}

function validateWithdrawalWithoutPolicyHistory(
  record: ConsentRecord,
  current: PolicySnapshot,
  now: number,
): boolean {
  const captured = snapshotStoredConsentRecord(record);
  if (
    !captured.ok ||
    captured.record.method !== "withdrawal" ||
    !isSupportedPolicyIdentity(captured.record.policy.catalogueDigest) ||
    !isSupportedPolicyIdentity(captured.record.policy.decisionSurfaceDigest) ||
    !nonBlankString(captured.record.policy.policyVersion)
  ) {
    return false;
  }
  return validatesAsWithdrawal(
    captured.record,
    Object.freeze({
      catalogueDigest: captured.record.policy.catalogueDigest,
      decisionSurfaceDigest: captured.record.policy.decisionSurfaceDigest,
      optionalPurposeIds: consentPolicy(current).optionalPurposeIds,
      policyVersion: captured.record.policy.policyVersion,
    }),
    now,
  );
}

function validateWithdrawal(
  record: ConsentRecord,
  now: number,
  current: PolicySnapshot,
  history: readonly PolicySnapshot[],
): boolean {
  if (record.method !== "withdrawal") return false;
  const matchingSnapshots = [current, ...history].filter((snapshot) =>
    sameRecordIdentity(snapshot, record),
  );
  if (matchingSnapshots.length === 0) {
    return validateWithdrawalWithoutPolicyHistory(record, current, now);
  }
  return matchingSnapshots.every((snapshot) =>
    validatesAsWithdrawal(record, consentPolicy(snapshot), now),
  );
}

function fromPlan(
  policy: ConsentPolicyInput,
  plan: ReconsentPlan,
  record: ConsentRecord,
): ConsentPolicyReconciliation {
  if (plan.issues.length > 0) {
    const issue = plan.issues[0];
    return conservativeResult(policy, record, "invalid", [
      {
        code: "policy-plan-invalid",
        detail: issue?.code ?? "unknown",
        path: issue?.path ?? "plan",
      },
    ]);
  }
  return result(policy, plan.status, plan.decisions, plan.affectedPurposes, []);
}

function derivedChangeSet(
  previous: PolicySnapshot,
  current: PolicySnapshot,
):
  | { readonly issue: ConsentPolicyReconciliationIssue }
  | { readonly value: ConsentPolicyChangeSetInput } {
  const diff = diffPolicies(previous, current);
  if (!diff.ok) {
    return {
      issue: {
        code: "policy-diff-inconsistent",
        detail:
          diff.issues[0]?.code ??
          "policy-version-changed-without-affected-purpose",
        path: "policyHistory",
      },
    };
  }
  const added = new Set(diff.changeSet.addedPurposeIds);
  const removed = new Set(diff.changeSet.removedPurposeIds);
  return {
    value: Object.freeze({
      addedPurposeIds: Object.freeze([...diff.changeSet.addedPurposeIds]),
      affectedPurposes: Object.freeze(
        diff.changeSet.changes
          .filter(
            ({ purposeId }) => !added.has(purposeId) && !removed.has(purposeId),
          )
          .map(({ purposeId, reasons }) =>
            Object.freeze({
              purposeId,
              reasonCodes: Object.freeze([...reasons]),
            }),
          ),
      ),
      currentIdentity: freezeIdentity(current),
      previousIdentity: freezeIdentity(previous),
      removedPurposeIds: Object.freeze([...diff.changeSet.removedPurposeIds]),
    }),
  };
}

/**
 * Derives selective reconsent only from captured, identity-matched policy
 * history. The returned plan never replaces the visitor's persisted record.
 *
 * @public
 */
function reconcileConsentPolicy(
  input: ConsentPolicyReconciliationInput,
): ConsentPolicyReconciliation {
  const source = objectValue(input);
  const current = capturePolicySnapshot(
    source === undefined ? undefined : ownValue(source, "currentPolicy"),
  );
  if (source === undefined || current === undefined) {
    return conservativeResult(INVALID_CURRENT_POLICY, undefined, "invalid", [
      { code: "invalid-policy-snapshot", path: "currentPolicy" },
    ]);
  }
  const capturedRecord = snapshotStoredConsentRecord(
    ownValue(source, "record"),
  );
  const now = ownValue(source, "now");
  const history = capturePolicyHistory(ownValue(source, "policyHistory"));
  const snapshots = Object.freeze([current, ...history.snapshots]);
  const verifications = snapshots.map((snapshot) =>
    verifySnapshotIdentity(snapshot),
  );
  const verifiedCurrent = verifications[0];
  const verifiedHistory = verifications.slice(1);
  const policy = verifiedCurrent?.policy ?? unverifiedPolicy(current);
  if (verifiedCurrent?.matches !== true) {
    return conservativeResult(
      policy,
      capturedRecord.ok ? capturedRecord.record : undefined,
      "invalid",
      [{ code: "invalid-policy-snapshot", path: "currentPolicy" }],
    );
  }
  if (verifiedHistory.some((verification) => verification?.matches !== true)) {
    return conservativeResult(
      policy,
      capturedRecord.ok ? capturedRecord.record : undefined,
      "invalid",
      [{ code: "invalid-policy-snapshot", path: "policyHistory" }],
    );
  }
  if (!capturedRecord.ok) {
    return conservativeResult(policy, undefined, "invalid", [
      { code: "invalid-consent-record", path: capturedRecord.path },
    ]);
  }
  const record = capturedRecord.record;
  if (!Number.isSafeInteger(now)) {
    return conservativeResult(policy, record, "invalid", [
      { code: "invalid-current-time", path: "now" },
    ]);
  }
  if (!history.valid) {
    return conservativeResult(policy, record, "invalid", [
      { code: "invalid-policy-history", path: "policyHistory" },
    ]);
  }
  if (hasDuplicateHistory(history.snapshots)) {
    return conservativeResult(policy, record, "invalid", [
      { code: "policy-history-duplicate", path: "policyHistory" },
    ]);
  }
  const validatedWithdrawal = validateWithdrawal(
    record,
    now as number,
    current,
    history.snapshots,
  );

  const currentEvaluation = evaluateConsent(record, policy, now as number);
  if (currentEvaluation.status === "withdrawn") {
    return fromPlan(policy, planReconsent(record, policy), record);
  }
  if (currentEvaluation.status === "expired") {
    return conservativeResult(policy, record, "expired", []);
  }
  if (
    sameRecordIdentity(current, record) &&
    currentEvaluation.status !== "active"
  ) {
    return conservativeResult(policy, record, "invalid", [
      {
        code: "invalid-consent-record",
        path: currentEvaluation.issues[0]?.path ?? "current",
      },
    ]);
  }

  const matchingHistory = history.snapshots.filter((snapshot) =>
    sameRecordIdentity(snapshot, record),
  );
  if (matchingHistory.length === 0) {
    return conservativeResult(
      policy,
      record,
      "invalid",
      [{ code: "policy-history-missing", path: "policyHistory" }],
      validatedWithdrawal,
    );
  }
  if (matchingHistory.length > 1) {
    return conservativeResult(
      policy,
      record,
      "invalid",
      [{ code: "policy-history-duplicate", path: "policyHistory" }],
      validatedWithdrawal,
    );
  }
  if (sameRecordIdentity(current, record)) {
    return fromPlan(policy, planReconsent(record, policy), record);
  }
  const previous = matchingHistory[0] as PolicySnapshot;
  const historicalEvaluation = evaluateConsent(
    record,
    consentPolicy(previous),
    now as number,
  );
  if (historicalEvaluation.status === "expired") {
    return conservativeResult(policy, record, "expired", []);
  }
  if (
    historicalEvaluation.status !== "active" &&
    historicalEvaluation.status !== "withdrawn"
  ) {
    return conservativeResult(policy, record, "invalid", [
      {
        code: "invalid-consent-record",
        path: historicalEvaluation.issues[0]?.path ?? "current",
      },
    ]);
  }

  const changeSet = derivedChangeSet(previous, current);
  if ("issue" in changeSet) {
    return conservativeResult(
      policy,
      record,
      "invalid",
      [changeSet.issue],
      validatedWithdrawal,
    );
  }
  return fromPlan(
    policy,
    planReconsent(record, policy, changeSet.value),
    record,
  );
}
