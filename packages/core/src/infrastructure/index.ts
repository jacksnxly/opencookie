import type { OpenCookieArchitecture } from "../application/index.js";

/** @public */
export interface InfrastructureBinding {
  readonly core: OpenCookieArchitecture;
  readonly layer: "infrastructure";
}

export {
  type AccessEnforcementAction,
  type AccessEnforcementActionName,
  type AccessEnforcementController,
  type AccessEnforcementDecision,
  type AccessEnforcementFailure,
  type AccessEnforcementOperation,
  type AccessEnforcementReconciler,
  type AccessEnforcementReconcilerOptions,
  type AccessEnforcementResult,
  createAccessEnforcementReconciler,
  projectAccessEnforcementDecisions,
  type DiscoveredResourceState,
  type EnforcedAccess,
  type EnforcementOperationResult,
  type IrreversibleAccessEffect,
} from "./enforcement/reconcile-access.js";

export {
  createGoogleConsentModeBroadcaster,
  type GoogleConsentModeBroadcaster,
  type GoogleConsentModeBroadcasterOptions,
  type GoogleConsentModeBroadcastResult,
  type GoogleConsentModeCall,
  type GoogleConsentModeCommand,
  type GoogleConsentModeImplementation,
  type GoogleConsentModePayload,
  type GoogleConsentModePurposeMapping,
  type GoogleConsentModeResourceMapping,
  type GoogleConsentModeState,
  type GoogleConsentStatus,
  projectGoogleConsentModePurposeState,
  projectGoogleConsentModeState,
} from "./signals/google-consent-mode.js";

export {
  createCookieDecisionStore,
  type CookieDecisionStore,
  type CookieDecisionStoreOptions,
  type CookieDomainScope,
  type CookieJarLike,
  type RegistrableDomainResolver,
} from "./storage/cookie-decision-store.js";

export {
  createLocalStorageDecisionStore,
  type LocalStorageDecisionStore,
  type LocalStorageDecisionStoreOptions,
  type StorageLike,
} from "./storage/local-storage-decision-store.js";
