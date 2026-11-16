/**
 * Package-private runtime boundary for application lifecycle projection.
 * Planning and diffing exports deliberately stay behind the public context
 * entrypoint so compact products cannot reach them through this module.
 */
export { checkedSafeInteger as checked } from "../shared/checked-safe-integer.js";
export {
  createConsentEventBatch,
  type ConsentDomainEvent,
} from "./consent-events.js";
export {
  CONSENT_RECORD_SCHEMA_VERSION,
  freezeConsentRecord as rehydrateConsentRecord,
  snapshotStoredConsentRecord,
  type ConsentDecisionMethod,
  type ConsentPolicyInput,
  type ConsentRecord,
  type PurposeDecisionState,
} from "./consent-record.js";
export { evaluateConsent, type ConsentEvaluation } from "./evaluate-consent.js";
export {
  recordConsentDecision,
  type RecordDecisionCommand,
  type RecordDecisionIssue,
} from "./record-decision.js";
export {
  withdrawConsent,
  type InvalidWithdrawalRecordIssue,
  type InvalidWithdrawalTimeIssue,
} from "./withdraw-consent.js";
