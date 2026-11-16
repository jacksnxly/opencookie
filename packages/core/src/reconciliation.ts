/** Verified policy reconciliation as a dedicated core product. @packageDocumentation */

export { createPolicyReconciler } from "./application/runtime/reconcile-policy.js";

export type {
  ConsentDecision,
  ConsentDecisionMethod,
  ConsentDecisionState,
  ConsentPolicyAffectedPurposeInput,
  ConsentPolicyIdentityInput,
  ConsentPolicyInput,
  ConsentPolicyReconciliation,
  ConsentPolicyReconciliationInput,
  ConsentPolicyReconciliationIssue,
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
  PolicyReconciler,
  PolicySnapshot,
  PurposeDecision,
  PurposeDecisionState,
} from "./reconciliation/contract.js";
