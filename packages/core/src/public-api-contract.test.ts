import { expectTypeOf, it } from "vitest";

import type { DenialReceiptDiagnostic } from "./application.js";
import type {
  ConsentPolicyReconciliation as RootConsentPolicyReconciliation,
  ConsentPolicyReconciliationIssue as RootConsentPolicyReconciliationIssue,
  DenialReceiptDiagnostic as RootDenialReceiptDiagnostic,
  OpenCookieOptions as RootOpenCookieOptions,
  OpenCookiePendingGrantRetryResult as RootPendingGrantRetryResult,
  OpenCookiePortContext as RootPortContext,
} from "./index.js";
import {
  createPolicyReconciler,
  type ConsentPolicyReconciliation,
  type ConsentPolicyReconciliationIssue,
  type PolicyReconciler,
} from "./reconciliation.js";

// @ts-expect-error the headless client is root-only
import type { OpenCookieOptions as ApplicationOpenCookieOptions } from "./application.js";
// @ts-expect-error reconciliation has its own public product boundary
import { createPolicyReconciler as ApplicationPolicyReconciler } from "./application.js";

it("exports pending grant retry and denial receipt contracts from their public entries", () => {
  expectTypeOf<RootDenialReceiptDiagnostic>().toEqualTypeOf<DenialReceiptDiagnostic>();
  expectTypeOf<
    DenialReceiptDiagnostic["code"]
  >().toEqualTypeOf<"denial-receipt-failed">();
});

it("exports the port-scoped terminal capability from ESM and CommonJS declaration entries", () => {
  expectTypeOf<RootPortContext>().toEqualTypeOf<{
    readonly rejectAll: () => ReturnType<RootPortContext["rejectAll"]>;
    readonly withdrawConsent: () => ReturnType<
      RootPortContext["withdrawConsent"]
    >;
  }>();
  expectTypeOf<
    Parameters<NonNullable<RootOpenCookieOptions["broadcast"]>>[1]
  >().toEqualTypeOf<RootPortContext | undefined>();
  expectTypeOf<
    Parameters<NonNullable<RootOpenCookieOptions["reconcile"]>>[1]
  >().toEqualTypeOf<RootPortContext | undefined>();
  expectTypeOf<
    Parameters<NonNullable<RootOpenCookieOptions["receipt"]>>[1]
  >().toEqualTypeOf<RootPortContext | undefined>();
});

it("publishes reconciliation separately while retaining root result types", () => {
  expectTypeOf<RootConsentPolicyReconciliation>().toEqualTypeOf<ConsentPolicyReconciliation>();
  expectTypeOf<RootConsentPolicyReconciliationIssue>().toEqualTypeOf<ConsentPolicyReconciliationIssue>();
  expectTypeOf(createPolicyReconciler()).toEqualTypeOf<PolicyReconciler>();

  expectTypeOf<ApplicationOpenCookieOptions>();
  expectTypeOf(ApplicationPolicyReconciler);
  expectTypeOf<RootPendingGrantRetryResult>();
});
