import type { ConsentDecisioningContract } from "../domain/consent-decisioning/index.js";

/** @public */
export interface OpenCookieArchitecture {
  readonly consent: ConsentDecisioningContract;
  readonly layer: "application";
}

export {
  type ConsentReceiptOutbox,
  type ConsentReceiptSink,
  createInMemoryReceiptOutbox,
  deliverConsentReceipt,
  flushConsentReceiptOutbox,
  type InMemoryReceiptOutboxOptions,
  type ReceiptDeliveryResult,
  type ReceiptOutboxEnqueueResult,
  type ReceiptOutboxFlushResult,
} from "./evidence/deliver-receipt.js";

export {
  type AppliedDecisionChange,
  type ConservativePersistenceProjection,
  projectConservativePersistenceFailure,
} from "./persistence/conservative-projection.js";
export {
  type DenialPersistenceDiagnostic,
  type DenialPersistenceResult,
  persistDenial,
} from "./persistence/persist-denial.js";
export {
  type DecisionStore,
  type DecisionStoreConditionalClearResult,
  type DecisionStoreWriteResult,
  type GrantPersistenceDiagnostic,
  type GrantPersistenceResult,
  persistGrant,
} from "./persistence/persist-grant.js";

export {
  type DenialReceiptDiagnostic,
  type ConsentRuntimeDecisionDiagnostic,
  type ConsentRuntimeDecisionCommand,
  type ConsentRuntimeDecisionPorts,
  type ConsentRuntimeDecisionResult,
  type ConsentRuntimeTransition,
  type ConsentRuntimeTransitionEffect,
  type PendingGrantRuntimeTransition,
  executeConsentRuntimeDecision,
} from "./runtime/execute-consent-runtime-decision.js";
export { type GrantActivationDiagnostic } from "./runtime/pending-grant-lifecycle.js";
export {
  type ConsentRuntimeWithdrawalCommand,
  type ConsentRuntimeWithdrawalResult,
  executeConsentRuntimeWithdrawal,
} from "./runtime/execute-consent-runtime-withdrawal.js";
export {
  type ConsentRuntimeProjection,
  type ConsentRuntimeProjectionInput,
  projectAccessConsent,
  projectAccessPolicy,
  projectConsentPolicy,
  projectConsentRuntimeState,
} from "./runtime/project-consent-runtime.js";
export {
  type ConsentInitializationDiagnostic,
  type ConsentInitializationResult,
  type DecisionReader,
  type DecisionStoreReadResult,
  initializeConsent,
  type PersistedConsentState,
  type PersistedDecisionRecord,
  type PersistedDecisionRecordBase,
  type PersistedPendingGrant,
  type StoredConsentInvalidReason,
} from "./runtime/initialize-consent.js";
export {
  toConsentRecord,
  toPersistedDecisionRecord,
} from "./runtime/persisted-consent-record.js";
export {
  type LocalStateClearer,
  resetConsentForTesting,
  type ResetForTestingResult,
} from "./runtime/reset-for-testing.js";
export {
  type DenialTransition,
  type DenialTransitionCommand,
  type DenialTransitionDiagnostic,
  type DenialTransitionPorts,
  type DenialTransitionResult,
  executeDenialTransition,
  type PendingDenialTransition,
} from "./transitions/execute-denial-transition.js";
export {
  executeGrantTransition,
  type ConfirmedGrantTransition,
  type ConservativeGrantTransition,
  type GrantTransition,
  type GrantTransitionCommand,
  type GrantTransitionPorts,
  type GrantTransitionResult,
} from "./transitions/execute-grant-transition.js";
export {
  createTransitionQueue,
  type TransitionListener,
  type TransitionQueue,
  type TransitionQueueOptions,
} from "./transitions/transition-queue.js";
