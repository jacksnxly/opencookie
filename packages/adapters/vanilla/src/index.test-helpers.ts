import type { OpenCookie, OpenCookieSnapshot } from "@opencookie-dev/core";

const createSnapshot = (): OpenCookieSnapshot =>
  ({
    diagnostics: [],
    policySnapshot: {
      policy: {
        categories: [],
        presentationRootCategoryIds: [],
        purposes: [
          {
            dependsOn: [],
            disclosure: "Policy-bound analytics disclosure.",
            id: "analytics",
            label: "Policy-bound analytics",
          },
          {
            dependsOn: [],
            disclosure: "Policy-bound personalization disclosure.",
            id: "personalization",
            label: "Policy-bound personalization",
          },
        ],
      },
    },
    preferencesOpen: true,
    readiness: "ready",
    runtime: {
      accessConsent: {
        decisions: ["analytics", "personalization"].map((purposeId) => ({
          decision: "unresolved" as const,
          purposeId,
        })),
        status: "first-visit",
      },
      accessPolicy: {
        purposes: ["analytics", "personalization"].map((id) => ({
          dependsOn: [],
          id,
        })),
        resources: [],
        valid: true,
      },
      consentEvaluation: {
        issues: [],
        prompt: true,
        status: "first-visit",
      },
      effectiveAccess: { resources: [] },
      permittedPurposeIds: [],
    },
  }) as unknown as OpenCookieSnapshot;

export function createTestClient(): OpenCookie {
  const snapshot = createSnapshot();
  const unchanged = () =>
    Promise.resolve({ outcome: "unchanged" as const } as never);

  return {
    acceptAll: unchanged,
    closePreferences: () => undefined,
    getServerSnapshot: () => snapshot,
    getSnapshot: () => snapshot,
    initialize: () => Promise.resolve(snapshot),
    openPreferences: () => undefined,
    refresh: () => Promise.resolve(snapshot),
    rejectAll: unchanged,
    retryPendingGrant: unchanged,
    savePreferences: unchanged,
    subscribe: () => () => undefined,
    withdrawConsent: unchanged,
  };
}
