// docs:consumer-path: src/policy-version.ts
// docs:display:start
import {
  createOpenCookie,
  type OpenCookieOptions,
  type PolicySnapshot,
} from "@opencookie-dev/core";

import { createPolicySnapshotForVersion } from "../opencookie.policy.js";

export function clientWithVerifiedHistory(
  options: OpenCookieOptions,
  currentPolicy: PolicySnapshot,
  previousPolicy: PolicySnapshot,
) {
  return createOpenCookie({
    ...options,
    policyHistory: [currentPolicy, previousPolicy],
    policySnapshot: currentPolicy,
  });
}
// docs:display:end

import { createDemoOptions } from "./_support.js";

export async function run(): Promise<void> {
  const previousPolicy = createPolicySnapshotForVersion(
    "privacy-2026-08",
    "Measure aggregate product usage.",
    "catalogue-2026-08",
  );
  const currentPolicy = createPolicySnapshotForVersion(
    "privacy-2026-09",
    "Measure aggregate product usage and feature adoption.",
    "catalogue-2026-09",
  );
  const options = createDemoOptions();
  const previousClient = createOpenCookie({
    ...options,
    policyHistory: [previousPolicy],
    policySnapshot: previousPolicy,
  });
  await previousClient.initialize();
  await previousClient.acceptAll();

  const currentClient = clientWithVerifiedHistory(
    options,
    currentPolicy,
    previousPolicy,
  );
  await currentClient.initialize();
  const reconciliation =
    currentClient.getSnapshot().runtime.policyReconciliation;
  if (reconciliation?.status !== "requires-reconsent") {
    throw new Error("Changed policy did not require selective re-consent.");
  }
  const analytics = reconciliation.decisions.find(
    (decision) => decision.purposeId === "analytics",
  );
  const personalization = reconciliation.decisions.find(
    (decision) => decision.purposeId === "personalization",
  );
  if (
    analytics?.value !== "unresolved" ||
    personalization?.value !== "granted"
  ) {
    throw new Error("Selective re-consent did not carry unaffected access.");
  }
}
