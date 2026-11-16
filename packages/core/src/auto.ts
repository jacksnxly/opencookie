/**
 * Dedicated compact composition for the classic-script adapter. This barrel
 * is the only public auto surface: one factory plus its definition, runtime
 * option, and result types, and one function that sends the Consent Mode
 * defaults before the factory is built. It composes package-private kernels directly and
 * has no static path to consent-evidence projection or any public barrel.
 *
 * @packageDocumentation
 */

export {
  createAutoOpenCookieFactory,
  establishAutoGoogleConsentDefaults,
  type AutoOpenCookieController,
  type AutoOpenCookieDefinition,
  type AutoOpenCookieFactory,
  type AutoOpenCookieGoogleInput,
  type AutoOpenCookieGoogleResourceMapping,
  type AutoOpenCookieGpcInput,
  type AutoOpenCookieGpcObservation,
  type AutoOpenCookiePersistenceInput,
  type AutoOpenCookiePolicySection,
  type AutoOpenCookieResourceInput,
  type AutoOpenCookieRuntimeOptions,
  type AutoOpenCookieStorage,
} from "./auto/create-auto-open-cookie-factory.js";
export type {
  OpenCookie,
  OpenCookieAdoptionResult,
  OpenCookieGrantActivation,
  OpenCookieIdKind,
  OpenCookiePendingGrant,
  OpenCookiePendingGrantRetryResult,
  OpenCookiePortContext,
  OpenCookieReadiness,
  OpenCookieSnapshot,
  OpenCookieWithdrawalResult,
} from "./application/runtime/open-cookie-kernel-contract.js";
export type {
  ConsentRuntimeDecisionDiagnostic,
  ConsentRuntimeDecisionResult,
  ConsentRuntimeTransitionEffect,
  DenialReceiptDiagnostic,
  PendingGrantRuntimeTransition,
} from "./application/runtime/execute-consent-runtime-decision-kernel.js";
export type { ConsentRuntimeWithdrawalResult } from "./application/runtime/execute-consent-runtime-withdrawal-kernel.js";
export type {
  ConsentPolicyReconciliation,
  ConsentPolicyReconciliationIssue,
} from "./reconciliation.js";
export type { OpenCookieExternalStore } from "./application/runtime/external-store.js";
export type {
  ConsentInitializationDiagnostic,
  StoredConsentInvalidReason,
} from "./application/runtime/initialize-consent.js";
export type { GrantActivationDiagnostic } from "./application/runtime/pending-grant-lifecycle.js";
export type {
  PersistedDecisionRecord,
  PersistedDecisionRecordBase,
} from "./application/runtime/persisted-consent-record.js";
export type { ConsentRuntimeProjection } from "./application/runtime/project-consent-runtime.js";
export type { AppliedDecisionChange } from "./application/persistence/conservative-projection.js";
export type { DenialPersistenceDiagnostic } from "./application/persistence/persist-denial.js";
export type { GrantPersistenceDiagnostic } from "./application/persistence/persist-grant.js";
export type {
  DenialTransition,
  DenialTransitionDiagnostic,
} from "./application/transitions/execute-denial-transition.js";
export type {
  ConfirmedGrantTransition,
  ConservativeGrantTransition,
  GrantTransition,
} from "./application/transitions/execute-grant-transition.js";
export type {
  ConsentDecision,
  ConsentDecisionEvent,
  ConsentDecisionMethod,
  ConsentDecisionState,
  ConsentDomainEvent,
  ConsentEvaluation,
  ConsentEvaluationIssue,
  ConsentPolicyAffectedPurposeInput,
  ConsentPolicyIdentityInput,
  ConsentPolicyInput,
  ConsentRecord,
  ConsentRecordBase,
  ConsentRecordCreatedEvent,
  ConsentRecordSchemaVersion,
  DecisionBeforeCurrentTransitionIssue,
  DecisionDiff,
  InvalidConsentIdIssue,
  InvalidConsentPolicyIssue,
  InvalidCurrentRecordIssue,
  InvalidDecisionIntervalIssue,
  InvalidDecisionMethodIssue,
  InvalidDecisionTimestampIssue,
  InvalidGrantedPurposeSetIssue,
  InvalidLocaleIssue,
  InvalidRecordIdIssue,
  InvalidWithdrawalRecordIssue,
  InvalidWithdrawalTimeIssue,
  MissingRecordIdIssue,
  PurposeDecision,
  PurposeDecisionState,
  RecordDecisionIssue,
  UnknownPurposeIdIssue,
} from "./domain/consent-decisioning/index.js";
export type {
  DefinedPolicy,
  DefinedPolicyCategory,
  DefinedPolicyPurpose,
  DefinedPolicyReference,
  PolicyCategoryTranslation,
  PolicyPurposeTranslation,
  PolicySnapshot,
} from "./domain/policy-catalogue/index.js";
export type {
  AccessBlockReason,
  AccessConsentSnapshot,
  AccessConsentStatus,
  AccessDecisionValue,
  AccessPolicyPurpose,
  AccessPolicyResource,
  AccessPolicySnapshot,
  AccessPurposeDecision,
  AllowedResourceAccess,
  BlockedResourceAccess,
  EffectiveAccessPlan,
  EffectiveResourceAccess,
} from "./domain/terminal-enforcement/index.js";
export type {
  DiscoveredResourceState,
  EnforcementOperationResult,
} from "./infrastructure/enforcement/reconcile-access.js";
export type {
  GoogleConsentModeCall,
  GoogleConsentModeCommand,
  GoogleConsentModePayload,
  GoogleConsentStatus,
} from "./infrastructure/signals/google-consent-mode.js";
