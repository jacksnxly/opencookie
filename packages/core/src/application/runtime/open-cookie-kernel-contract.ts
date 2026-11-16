import type { ConsentRecord } from "../../domain/consent-decisioning/index.js";
import type { PolicySnapshot } from "../../domain/policy-catalogue/index.js";
import type { DecisionStore } from "../persistence/persist-grant.js";
import type {
  ConsentRuntimeDecisionResult,
  ConsentRuntimeTransitionEffect,
} from "./execute-consent-runtime-decision-kernel.js";
import type { ConsentRuntimeWithdrawalResult } from "./execute-consent-runtime-withdrawal-kernel.js";
import type { OpenCookieExternalStore } from "./external-store.js";
import type { ConsentInitializationDiagnostic } from "./initialize-consent.js";
import type { ConsentRuntimeProjection } from "./project-consent-runtime.js";
import type { ConsentRuntimeAftercareInput } from "./snapshot-consent-runtime-inputs.js";

/** @public */
export type OpenCookieIdKind = "record" | "transition";

/** @public */
export type OpenCookieReadiness = "invalid" | "ready" | "uninitialized";

/** @public */
export type OpenCookieGrantActivation = "active" | "not-applicable" | "pending";

/** @public */
export interface OpenCookiePendingGrant {
  readonly grantedPurposeIds: readonly string[];
  readonly phase: "broadcast" | "persistence";
  readonly transitionId: string;
}

/** @public */
export interface OpenCookieSnapshot {
  readonly diagnostics: readonly ConsentInitializationDiagnostic[];
  readonly grantActivation: OpenCookieGrantActivation;
  readonly lastPersistenceStatus?: ConsentRuntimeTransitionEffect["persistenceStatus"];
  readonly pendingGrant?: OpenCookiePendingGrant;
  readonly policySnapshot: PolicySnapshot;
  readonly preferencesOpen: boolean;
  readonly readiness: OpenCookieReadiness;
  readonly record?: ConsentRecord;
  readonly runtime: ConsentRuntimeProjection;
}

/**
 * Terminal operations scoped to the exact grant attempt invoking a runtime
 * port. The same frozen context is passed to that attempt's broadcast,
 * reconcile, and receipt callbacks. It remains valid across arbitrary promise
 * and microtask boundaries that belong to an awaited callback lifetime. After
 * the last applicable callback settles, the context closes before the grant
 * result is calculated. Detached work that outlives its callback rejects. The
 * context is single-use: its first operation wins, and later calls reject
 * without changing consent state or invoking runtime ports.
 *
 * Calling and awaiting the ordinary `OpenCookie.rejectAll` or
 * `OpenCookie.withdrawConsent` method from an asynchronous port callback is
 * unsupported because those methods retain external queue ordering. Use this
 * context for asynchronous callback reentry. Direct synchronous calls through
 * the ordinary client remain supported.
 *
 * @public
 */
export interface OpenCookiePortContext {
  readonly rejectAll: () => Promise<ConsentRuntimeDecisionResult>;
  readonly withdrawConsent: () => Promise<OpenCookieWithdrawalResult>;
}

/** @public */
export type OpenCookieWithdrawalResult =
  | ConsentRuntimeWithdrawalResult
  | {
      readonly outcome: "not-applicable";
      readonly runtime: ConsentRuntimeProjection;
    };

/** @public */
export type OpenCookiePendingGrantRetryResult =
  | ConsentRuntimeDecisionResult
  | {
      readonly outcome: "not-applicable";
      readonly runtime: ConsentRuntimeProjection;
    };

/** @public */
export type OpenCookieAdoptionResult = "adopted" | "unchanged" | "unavailable";

/** @public */
export interface OpenCookie extends OpenCookieExternalStore<OpenCookieSnapshot> {
  readonly acceptAll: () => Promise<ConsentRuntimeDecisionResult>;
  readonly adoptStoredDecision?: () => Promise<OpenCookieAdoptionResult>;
  readonly closePreferences: () => void;
  readonly initialize: () => Promise<OpenCookieSnapshot>;
  readonly openPreferences: () => void;
  readonly refresh: () => Promise<OpenCookieSnapshot>;
  readonly rejectAll: () => Promise<ConsentRuntimeDecisionResult>;
  readonly retryPendingGrant: () => Promise<OpenCookiePendingGrantRetryResult>;
  readonly savePreferences: (
    grantedPurposeIds: readonly string[],
  ) => Promise<ConsentRuntimeDecisionResult>;
  readonly withdrawConsent: () => Promise<OpenCookieWithdrawalResult>;
}

/**
 * Receipt-neutral aftercare hook injected by a product composition. Generic
 * wrappers adapt it to consent-receipt projection; the auto product supplies
 * a frozen no-op so its graph never reaches consent-evidence code.
 */
export type ConsentRuntimeAftercareHook = (
  input: ConsentRuntimeAftercareInput,
  context?: OpenCookiePortContext,
) => Promise<void>;

/**
 * Receipt-neutral construction options for the package-private lifecycle
 * kernel. Runtime ports keep their lazy reads and callback receivers, while
 * projection state and receipt delivery arrive through separate injected
 * boundaries.
 */
export interface OpenCookieKernelOptions {
  readonly broadcast?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly consentDurationMs: number;
  readonly consentId?: string;
  readonly idGenerator: (kind: OpenCookieIdKind) => string;
  readonly initialRecord?: ConsentRecord;
  readonly initialTime?: number;
  readonly locale?: string;
  readonly now: () => number;
  readonly onListenerError?: (error: unknown) => void;
  readonly reconcile?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly store: DecisionStore;
}
