import { createDemoOptions } from "./_support.js";

// docs:consumer-path: src/consent-lifecycle.ts
// docs:display:start
import {
  createOpenCookie,
  type OpenCookie,
  type OpenCookieOptions,
} from "@opencookie-dev/core";

export function createExpiringConsentClient(
  options: OpenCookieOptions,
  consentDurationMs: number,
) {
  return createOpenCookie({ ...options, consentDurationMs });
}

export async function withdrawAndInspect(client: OpenCookie) {
  await client.initialize();
  const result = await client.withdrawConsent();
  return {
    outcome: result.outcome,
    status: client.getSnapshot().runtime.consentEvaluation.status,
  };
}
// docs:display:end

export async function run(): Promise<void> {
  let withdrawalNow = 1_780_000_000_000;
  const withdrawalOptions = {
    ...createDemoOptions(),
    now: () => withdrawalNow,
  };
  const withdrawalClient = createExpiringConsentClient(
    withdrawalOptions,
    10_000,
  );
  await withdrawalClient.initialize();
  await withdrawalClient.acceptAll();
  withdrawalNow += 1;
  const withdrawn = await withdrawAndInspect(withdrawalClient);
  if (withdrawn.outcome !== "committed" || withdrawn.status !== "withdrawn") {
    throw new Error("Withdrawal did not produce a conservative denied state.");
  }

  let expiryNow = 1_780_000_000_000;
  const expiryOptions = { ...createDemoOptions(), now: () => expiryNow };
  const firstVisit = createExpiringConsentClient(expiryOptions, 10);
  await firstVisit.initialize();
  await firstVisit.acceptAll();
  expiryNow += 11;
  await firstVisit.refresh();
  const expiry = firstVisit.getSnapshot().runtime.consentEvaluation;
  if (expiry.status !== "expired" || !expiry.prompt) {
    throw new Error("Refreshed consent did not expire at the injected clock.");
  }
}
