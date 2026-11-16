import { deepFreeze, type DefinedPolicyPurpose } from "./define-policy.js";
import type { PolicySnapshot } from "./policy-identity.js";

/** @public */
export type PolicyChangeReason =
  | "added"
  | "data-category"
  | "dependency"
  | "free-text"
  | "operation"
  | "provider"
  | "recipient"
  | "removed"
  | "retention";

/** @public */
export interface PolicyPurposeChange {
  readonly purposeId: string;
  readonly reasons: readonly PolicyChangeReason[];
}

/** @public */
export interface PolicySnapshotIdentity {
  readonly catalogueDigest: string;
  readonly catalogueRevision: string;
  readonly decisionSurfaceDigest: string;
  readonly policyVersion: string;
}

/** @public */
export interface PolicyChangeSet {
  readonly addedPurposeIds: readonly string[];
  readonly affectedPurposeIds: readonly string[];
  readonly changes: readonly PolicyPurposeChange[];
  readonly nextIdentity: PolicySnapshotIdentity;
  readonly previousIdentity: PolicySnapshotIdentity;
  readonly removedPurposeIds: readonly string[];
}

/** @public */
export interface SuccessfulPolicyDiff {
  readonly changeSet: PolicyChangeSet;
  readonly ok: true;
}

/** @public */
export interface PolicyVersionChangedWithoutAffectedPurposeIssue {
  readonly code: "policy-version-changed-without-affected-purpose";
  readonly nextPolicyVersion: string;
  readonly previousPolicyVersion: string;
}

/** @public */
export interface PolicyVersionUnchangedWithAffectedPurposeIssue {
  readonly code: "policy-version-unchanged-with-affected-purpose";
  readonly policyVersion: string;
}

/** @public */
export type PolicyVersionConsistencyIssue =
  | PolicyVersionChangedWithoutAffectedPurposeIssue
  | PolicyVersionUnchangedWithAffectedPurposeIssue;

/** @public */
export interface FailedPolicyDiff {
  readonly issues: readonly PolicyVersionConsistencyIssue[];
  readonly ok: false;
}

/** @public */
export type PolicyDiffResult = FailedPolicyDiff | SuccessfulPolicyDiff;

function failedDiff(issue: PolicyVersionConsistencyIssue): FailedPolicyDiff {
  return deepFreeze({ issues: [issue], ok: false as const });
}

function identityOf(snapshot: PolicySnapshot): PolicySnapshotIdentity {
  return {
    catalogueDigest: snapshot.catalogueDigest,
    catalogueRevision: snapshot.catalogueRevision,
    decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
    policyVersion: snapshot.policyVersion,
  };
}

function sameIdentifiers(
  previous: readonly string[],
  next: readonly string[],
): boolean {
  return JSON.stringify(previous) === JSON.stringify(next);
}

const PURPOSE_CHANGE_FIELDS = [
  ["providerIds", "provider"],
  ["operationIds", "operation"],
  ["retentionIds", "retention"],
  ["recipientIds", "recipient"],
  ["dataCategoryIds", "data-category"],
  ["dependsOn", "dependency"],
] as const;

function changedReasons(
  previous: DefinedPolicyPurpose,
  next: DefinedPolicyPurpose,
): PolicyChangeReason[] {
  const reasons: PolicyChangeReason[] = [];

  for (const [field, reason] of PURPOSE_CHANGE_FIELDS) {
    if (!sameIdentifiers(previous[field], next[field])) reasons.push(reason);
  }
  if (
    previous.disclosure !== next.disclosure ||
    previous.label !== next.label ||
    JSON.stringify(previous.translations ?? []) !==
      JSON.stringify(next.translations ?? [])
  ) {
    reasons.push("free-text");
  }

  return reasons;
}

function freezeChange(
  purposeId: string,
  reasons: PolicyChangeReason[],
): PolicyPurposeChange {
  return { purposeId, reasons };
}

/** @public */
export function diffPolicies(
  previous: PolicySnapshot,
  next: PolicySnapshot,
): PolicyDiffResult {
  const previousPurposes = new Map(
    previous.policy.purposes.map((purpose) => [purpose.id, purpose]),
  );
  const nextPurposes = new Map(
    next.policy.purposes.map((purpose) => [purpose.id, purpose]),
  );
  const purposeIds = [
    ...new Set([...previousPurposes.keys(), ...nextPurposes.keys()]),
  ].sort();
  const changes: PolicyPurposeChange[] = [];
  const addedPurposeIds: string[] = [];
  const removedPurposeIds: string[] = [];

  for (const purposeId of purposeIds) {
    const previousPurpose = previousPurposes.get(purposeId);
    const nextPurpose = nextPurposes.get(purposeId);

    if (!previousPurpose) {
      addedPurposeIds.push(purposeId);
      changes.push(freezeChange(purposeId, ["added"]));
      continue;
    }
    if (!nextPurpose) {
      removedPurposeIds.push(purposeId);
      changes.push(freezeChange(purposeId, ["removed"]));
      continue;
    }

    const reasons = changedReasons(previousPurpose, nextPurpose);
    if (reasons.length > 0) changes.push(freezeChange(purposeId, reasons));
  }

  const policyVersionChanged = previous.policyVersion !== next.policyVersion;
  if (changes.length === 0 && policyVersionChanged) {
    return failedDiff({
      code: "policy-version-changed-without-affected-purpose",
      nextPolicyVersion: next.policyVersion,
      previousPolicyVersion: previous.policyVersion,
    });
  }
  if (changes.length > 0 && !policyVersionChanged) {
    return failedDiff({
      code: "policy-version-unchanged-with-affected-purpose",
      policyVersion: previous.policyVersion,
    });
  }

  const changeSet = {
    addedPurposeIds,
    affectedPurposeIds: changes.map((change) => change.purposeId),
    changes,
    nextIdentity: identityOf(next),
    previousIdentity: identityOf(previous),
    removedPurposeIds,
  };

  return deepFreeze({ changeSet, ok: true as const });
}
