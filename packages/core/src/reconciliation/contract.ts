import type {
  ConsentPolicyAffectedPurposeInput,
  ConsentPolicyInput,
  ConsentRecord,
  PurposeDecisionState,
} from "../domain/consent-decisioning/index.js";
import type { PolicySnapshot } from "../domain/policy-catalogue/index.js";

/** @public */
export interface ConsentPolicyReconciliationInput {
  readonly currentPolicy: PolicySnapshot;
  readonly now: number;
  readonly policyHistory: readonly PolicySnapshot[];
  readonly record: ConsentRecord;
}

/** @public */
export type ConsentPolicyReconciliationIssue =
  | {
      readonly code: "invalid-consent-record";
      readonly path: string;
    }
  | {
      readonly code: "invalid-policy-snapshot";
      readonly path: "currentPolicy" | "policyHistory";
    }
  | {
      readonly code: "invalid-current-time";
      readonly path: "now";
    }
  | {
      readonly code: "invalid-policy-history";
      readonly path: "policyHistory";
    }
  | {
      readonly code: "policy-history-duplicate" | "policy-history-missing";
      readonly path: "policyHistory";
    }
  | {
      readonly code: "policy-diff-inconsistent";
      readonly detail:
        | "policy-version-changed-without-affected-purpose"
        | "policy-version-unchanged-with-affected-purpose";
      readonly path: "policyHistory";
    }
  | {
      readonly code: "policy-plan-invalid";
      readonly detail: string;
      readonly path: string;
    };

/** @public */
export interface ConsentPolicyReconciliation {
  readonly affectedPurposes: readonly ConsentPolicyAffectedPurposeInput[];
  readonly decisions: readonly PurposeDecisionState[];
  readonly issues: readonly ConsentPolicyReconciliationIssue[];
  readonly policy: Readonly<
    Pick<
      ConsentPolicyInput,
      "catalogueDigest" | "decisionSurfaceDigest" | "policyVersion"
    >
  >;
  readonly prompt: boolean;
  readonly status:
    "current" | "expired" | "invalid" | "requires-reconsent" | "withdrawn";
}

/** @public */
export interface PolicyReconciler {
  readonly reconcile: (
    input: ConsentPolicyReconciliationInput,
  ) => ConsentPolicyReconciliation;
}

export type {
  ConsentDecision,
  ConsentDecisionMethod,
  ConsentDecisionState,
  ConsentPolicyAffectedPurposeInput,
  ConsentPolicyIdentityInput,
  ConsentPolicyInput,
  ConsentRecord,
  ConsentRecordBase,
  ConsentRecordSchemaVersion,
  DefinedPolicy,
  DefinedPolicyCategory,
  DefinedPolicyPurpose,
  DefinedPolicyReference,
  PolicyCategoryTranslation,
  PolicyPurposeTranslation,
  PolicyVersionChangedWithoutAffectedPurposeIssue,
  PolicyVersionConsistencyIssue,
  PolicyVersionUnchangedWithAffectedPurposeIssue,
  PolicySnapshot,
  PurposeDecision,
  PurposeDecisionState,
} from "../domain.js";
