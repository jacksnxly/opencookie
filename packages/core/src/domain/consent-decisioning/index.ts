import type { DomainContract } from "../shared/architecture-contract.js";

/** @public */
export interface ConsentDecisioningContract extends DomainContract {
  readonly context: "consent-decisioning";
}

export {
  createConsentEventBatch,
  type ConsentDecisionEvent,
  type ConsentDomainEvent,
  type ConsentEventBatchInput,
  type ConsentRecordCreatedEvent,
} from "./consent-events.js";

export {
  CONSENT_RECORD_SCHEMA_VERSION,
  comparePurposeId,
  freezeConsentRecord as rehydrateConsentRecord,
  freezeIdentity,
  sameIdentity,
  snapshotStoredConsentRecord,
  type ConsentDecision,
  type ConsentDecisionMethod,
  type ConsentDecisionState,
  type ConsentPolicyAffectedPurposeInput,
  type ConsentPolicyChangeSetInput,
  type ConsentPolicyIdentityInput,
  type ConsentPolicyInput,
  type ConsentRecord,
  type ConsentRecordBase,
  type ConsentRecordInput,
  type ConsentRecordSchemaVersion,
  type PurposeDecision,
  type PurposeDecisionState,
} from "./consent-record.js";
export { diffDecisions, type DecisionDiff } from "./diff-decisions.js";
export {
  evaluateConsent,
  type ConsentEvaluation,
  type ConsentEvaluationIssue,
} from "./evaluate-consent.js";
export {
  planReconsent,
  type ReconsentIssue,
  type ReconsentPlan,
} from "./plan-reconsent.js";
export {
  recordConsentDecision,
  type DecisionBeforeCurrentTransitionIssue,
  type InvalidConsentIdIssue,
  type InvalidConsentPolicyIssue,
  type InvalidCurrentRecordIssue,
  type InvalidDecisionMethodIssue,
  type InvalidDecisionIntervalIssue,
  type InvalidDecisionTimestampIssue,
  type InvalidGrantedPurposeSetIssue,
  type InvalidLocaleIssue,
  type InvalidRecordIdIssue,
  type MissingRecordIdIssue,
  type RecordDecisionCommand,
  type RecordDecisionCommandBase,
  type RecordDecisionIssue,
  type RecordDecisionResult,
  type UnknownPurposeIdIssue,
} from "./record-decision.js";
export {
  withdrawConsent,
  type InvalidWithdrawalRecordIssue,
  type InvalidWithdrawalTimeIssue,
  type WithdrawConsentResult,
} from "./withdraw-consent.js";
