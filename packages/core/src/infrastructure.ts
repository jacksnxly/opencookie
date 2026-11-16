/** Optional storage, signal, and access-enforcement adapters. @packageDocumentation */

export * from "./infrastructure/index.js";

export type {
  AccessBlockReason,
  AllowedResourceAccess,
  BlockedResourceAccess,
  ConsentDecisioningContract,
  ConsentDecisionMethod,
  DecisionReader,
  DecisionStore,
  DecisionStoreConditionalClearResult,
  DecisionStoreReadResult,
  DecisionStoreWriteResult,
  DomainContract,
  EffectiveAccessPlan,
  EffectiveResourceAccess,
  OpenCookieArchitecture,
  PersistedConsentState,
  PersistedDecisionRecord,
  PersistedDecisionRecordBase,
  PersistedPendingGrant,
  StoredConsentInvalidReason,
} from "./application.js";
