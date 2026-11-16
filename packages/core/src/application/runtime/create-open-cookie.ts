import type { ConsentRecord } from "../../domain/consent-decisioning/index.js";
import type { ConsentReceipt } from "../../domain/consent-evidence/index.js";
import type {
  DefinedResourcePolicy,
  PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import type { ProcessingRestrictionSet } from "../../domain/privacy-preference-resolution/index.js";
import type { ServicePreferenceRecord } from "../../domain/terminal-enforcement/index.js";
import type { DecisionStore } from "../persistence/persist-grant.js";
import { consentReceiptAftercare } from "./consent-runtime-receipt-aftercare.js";
import { createOpenCookieKernel } from "./create-open-cookie-kernel.js";
import type { ConsentRuntimeTransitionEffect } from "./execute-consent-runtime-decision-kernel.js";
import type {
  OpenCookie,
  OpenCookieAdoptionResult,
  OpenCookieIdKind,
  OpenCookiePortContext,
} from "./open-cookie-kernel-contract.js";
import { resolveEffectiveAccess } from "../../domain/terminal-enforcement/index.js";
import { snapshotConsentRuntimeProjectionContext } from "./snapshot-consent-runtime-projection-context.js";
import { projectVerifiedConsentPolicy } from "./verified-consent-runtime-projector.js";

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
} from "./open-cookie-kernel-contract.js";

/** @public */
export interface OpenCookieOptions {
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
  readonly policyHistory?: readonly PolicySnapshot[];
  readonly policySnapshot: PolicySnapshot;
  readonly privacyRestrictions?: ProcessingRestrictionSet;
  readonly receipt?: (
    receipt: ConsentReceipt,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly reconcile?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly resourcePolicy: DefinedResourcePolicy;
  readonly servicePreferences?: ServicePreferenceRecord;
  readonly store: DecisionStore;
}

/**
 * Creates the framework-neutral, SSR-safe OpenCookie application facade.
 * Construction performs no storage or browser access. Call `initialize` once
 * the host runtime is ready.
 *
 * @public
 */
export function createOpenCookie(options: OpenCookieOptions): OpenCookie & {
  readonly adoptStoredDecision: () => Promise<OpenCookieAdoptionResult>;
} {
  // Runtime ports and the clock still flow into the kernel unchanged so their
  // lazy reads and receivers retain their exact semantics. Projection inputs
  // are instead captured once during construction into a detached, frozen
  // context, and the receipt sink is adapted into a per-decision aftercare
  // hook.
  return createOpenCookieKernel(
    options,
    () => consentReceiptAftercare(options.receipt ?? (() => Promise.resolve())),
    () =>
      snapshotConsentRuntimeProjectionContext(
        options,
        projectVerifiedConsentPolicy,
        resolveEffectiveAccess,
      ),
  );
}
