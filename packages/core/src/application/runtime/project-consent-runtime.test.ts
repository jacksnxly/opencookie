import { describe, expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../../index.js";
import {
  projectConsentPolicy,
  projectConsentRuntimeState,
} from "../../application.js";
import { createPolicyReconciler } from "../../reconciliation.js";
import { recordConsentDecision, withdrawConsent } from "../../domain.js";
import {
  projectAccessEnforcementDecisions,
  projectGoogleConsentModeState,
} from "../../infrastructure.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";

function catalogue(purposeIds: readonly string[]) {
  const result = definePolicy(
    completeTestPolicyDefinition({
      purposes: purposeIds.map((id, index) => ({
        ...(index === 0 ? {} : { dependsOn: [purposeIds[index - 1] ?? ""] }),
        id,
      })),
    }),
  );
  if (!result.ok) throw new Error("Test catalogue must be valid.");
  return result.policy;
}

function snapshot(policy: ReturnType<typeof catalogue>) {
  return createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy,
    policyVersion: "policy-1",
  });
}

function splitView<T extends object>(ordinary: T, captured: T): T {
  return new Proxy(Object.create(null) as object, {
    get: (_target, property) => Reflect.get(ordinary, property),
    getOwnPropertyDescriptor: (_target, property) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(captured, property);
      return descriptor === undefined
        ? undefined
        : { ...descriptor, configurable: true };
    },
    has: (_target, property) => Reflect.has(captured, property),
  }) as T;
}

describe("consent runtime projections", () => {
  it("captures split-view projection inputs before reconciliation and access", () => {
    const previousPolicy = catalogue(["analytics"]);
    const previousSnapshot = snapshot(previousPolicy);
    const changedDefinition = definePolicy(
      completeTestPolicyDefinition({
        purposes: [{ disclosure: "Changed disclosure", id: "analytics" }],
      }),
    );
    if (!changedDefinition.ok) throw new Error("Policy must be valid.");
    const changedSnapshot = createPolicySnapshot({
      catalogueRevision: "catalogue-2",
      policy: changedDefinition.policy,
      policyVersion: "policy-2",
    });
    const previousResources = defineResourcePolicy({
      policy: previousPolicy,
      resources: [],
      services: [],
    });
    const changedResources = defineResourcePolicy({
      policy: changedDefinition.policy,
      resources: [
        {
          access: "optional",
          id: "changed-analytics-script",
          purposeIds: ["analytics"],
          serviceId: "metrics",
        },
      ],
      services: [{ id: "metrics" }],
    });
    if (!previousResources.ok || !changedResources.ok) {
      throw new Error("Resource policies must be valid.");
    }
    const recorded = recordConsentDecision(
      undefined,
      projectConsentPolicy(previousSnapshot),
      {
        decidedAt: 1_000,
        expiresAt: 3_000,
        method: "accept-all",
        recordId: "record-split-view",
      },
    );
    if (!recorded.ok) throw new Error("Decision must be valid.");

    const runtime = projectConsentRuntimeState({
      consentRecord: recorded.record,
      now: 2_000,
      policySnapshot: splitView(changedSnapshot, previousSnapshot),
      resourcePolicy: splitView(
        changedResources.resourcePolicy,
        previousResources.resourcePolicy,
      ),
    });

    expect(runtime.policyReconciliation).toMatchObject({
      policy: {
        catalogueDigest: previousSnapshot.catalogueDigest,
        decisionSurfaceDigest: previousSnapshot.decisionSurfaceDigest,
        policyVersion: previousSnapshot.policyVersion,
      },
      status: "current",
    });
    expect(runtime.consentPolicy).toEqual(
      projectConsentPolicy(previousSnapshot),
    );
    expect(runtime.consentEvaluation.status).toBe("active");
    expect(runtime.accessPolicy.resources).toEqual([]);
    expect(runtime.effectiveAccess.resources).toEqual([]);
  });

  it("requires explicit runtime history to include the current policy", () => {
    const previousPolicy = catalogue(["analytics"]);
    const previousSnapshot = snapshot(previousPolicy);
    const currentDefinition = definePolicy(
      completeTestPolicyDefinition({
        purposes: [{ disclosure: "Changed disclosure", id: "analytics" }],
      }),
    );
    if (!currentDefinition.ok) throw new Error("Policy must be valid.");
    const currentSnapshot = createPolicySnapshot({
      catalogueRevision: "catalogue-2",
      policy: currentDefinition.policy,
      policyVersion: "policy-2",
    });
    const resources = defineResourcePolicy({
      policy: currentDefinition.policy,
      resources: [],
      services: [],
    });
    if (!resources.ok) throw new Error("Resource policy must be valid.");
    const recorded = recordConsentDecision(
      undefined,
      projectConsentPolicy(previousSnapshot),
      {
        decidedAt: 1_000,
        expiresAt: 3_000,
        method: "accept-all",
        recordId: "record-prior-only-history",
      },
    );
    if (!recorded.ok) throw new Error("Decision must be valid.");

    expect(() =>
      projectConsentRuntimeState({
        consentRecord: recorded.record,
        now: 2_000,
        policyHistory: [previousSnapshot],
        policySnapshot: currentSnapshot,
        resourcePolicy: resources.resourcePolicy,
      }),
    ).toThrow("Invalid consent runtime policy history.");
    expect(
      createPolicyReconciler().reconcile({
        currentPolicy: currentSnapshot,
        now: 2_000,
        policyHistory: [previousSnapshot],
        record: recorded.record,
      }),
    ).toMatchObject({ status: "requires-reconsent" });
  });

  it("omits reconciliation when no consent record exists", () => {
    const policy = catalogue(["analytics"]);
    const policySnapshot = snapshot(policy);
    const resources = defineResourcePolicy({
      policy,
      resources: [],
      services: [],
    });
    if (!resources.ok) throw new Error("Resource policy must be valid.");

    const runtime = projectConsentRuntimeState({
      now: 1_000,
      policyHistory: [policySnapshot],
      policySnapshot,
      resourcePolicy: resources.resourcePolicy,
    });

    expect(Object.hasOwn(runtime, "policyReconciliation")).toBe(false);
    expect(runtime.accessConsent.status).toBe("first-visit");
  });

  it("preserves denials and makes every grant unresolved after invalid reconciliation", () => {
    const policy = catalogue(["analytics", "personalization"]);
    const policySnapshot = snapshot(policy);
    const resources = defineResourcePolicy({
      policy,
      resources: [],
      services: [],
    });
    if (!resources.ok) throw new Error("Resource policy must be valid.");
    const recorded = recordConsentDecision(
      undefined,
      projectConsentPolicy(policySnapshot),
      {
        decidedAt: 1_000,
        expiresAt: 3_000,
        grantedPurposeIds: ["analytics"],
        method: "granular",
        recordId: "record-invalid-mapping",
      },
    );
    if (!recorded.ok) throw new Error("Decision must be valid.");

    const runtime = projectConsentRuntimeState({
      consentRecord: {
        ...recorded.record,
        policy: {
          ...recorded.record.policy,
          decisionSurfaceDigest: "foreign-digest",
        },
      },
      now: 2_000,
      policyHistory: [policySnapshot],
      policySnapshot,
      resourcePolicy: resources.resourcePolicy,
    });

    expect(runtime.policyReconciliation).toMatchObject({
      decisions: [
        { purposeId: "analytics", value: "unresolved" },
        { purposeId: "personalization", value: "denied" },
      ],
      status: "invalid",
    });
    expect(runtime.accessConsent.decisions).toEqual([
      { decision: "unresolved", purposeId: "analytics" },
      { decision: "denied", purposeId: "personalization" },
    ]);
  });

  it("projects validated policy and consent into effective, signal, and enforcement state", () => {
    const policy = catalogue(["analytics"]);
    const policySnapshot = snapshot(policy);
    const resourceResult = defineResourcePolicy({
      policy,
      resources: [
        {
          access: "optional",
          id: "analytics-script",
          purposeIds: ["analytics"],
          serviceId: "metrics",
        },
      ],
      services: [{ id: "metrics" }],
    });
    if (!resourceResult.ok) throw new Error("Resource policy must be valid.");

    const consentPolicy = projectConsentPolicy(policySnapshot);
    const decision = recordConsentDecision(undefined, consentPolicy, {
      decidedAt: 1_000,
      expiresAt: 2_000,
      method: "accept-all",
      recordId: "record-1",
    });
    if (!decision.ok) throw new Error("Decision must be valid.");

    const runtime = projectConsentRuntimeState({
      consentRecord: decision.record,
      now: 1_500,
      policySnapshot,
      resourcePolicy: resourceResult.resourcePolicy,
    });

    expect(runtime.consentEvaluation).toEqual({
      issues: [],
      prompt: false,
      status: "active",
    });
    expect(runtime.accessPolicy.valid).toBe(true);
    expect(runtime.effectiveAccess).toEqual({
      resources: [
        {
          access: "allowed",
          basis: "explicit-consent",
          blockReasons: [],
          resourceId: "analytics-script",
          serviceId: "metrics",
        },
      ],
    });
    expect(
      projectGoogleConsentModeState(runtime.effectiveAccess, {
        analyticsStorageResourceIds: ["analytics-script"],
      }),
    ).toEqual({
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "granted",
    });
    expect(projectAccessEnforcementDecisions(runtime.effectiveAccess)).toEqual([
      { access: "allowed", resourceId: "analytics-script" },
    ]);
  });

  // A presentation reads this to show a restricted grant as restricted: a
  // checked control would claim a purpose is active while enforcement blocks it.
  it("names the purposes a privacy signal restricts, and only policy purposes", () => {
    const policy = catalogue(["analytics", "marketing"]);
    const policySnapshot = snapshot(policy);
    const resourceResult = defineResourcePolicy({
      policy,
      resources: [
        {
          access: "optional",
          id: "analytics-script",
          purposeIds: ["analytics"],
          serviceId: "metrics",
        },
      ],
      services: [{ id: "metrics" }],
    });
    if (!resourceResult.ok) throw new Error("Resource policy must be valid.");
    const decision = recordConsentDecision(
      undefined,
      projectConsentPolicy(policySnapshot),
      {
        decidedAt: 1_000,
        expiresAt: 2_000,
        method: "accept-all",
        recordId: "record-1",
      },
    );
    if (!decision.ok) throw new Error("Decision must be valid.");
    const input = {
      consentRecord: decision.record,
      now: 1_500,
      policySnapshot,
      resourcePolicy: resourceResult.resourcePolicy,
    };

    const restricted = projectConsentRuntimeState({
      ...input,
      privacyRestrictions: {
        purposeIds: ["unknown-purpose", "analytics"],
        resourceIds: [],
        serviceIds: [],
        source: "gpc",
      },
    });
    const unrestricted = projectConsentRuntimeState(input);

    expect(restricted.restrictedPurposeIds).toEqual(["analytics"]);
    expect(restricted.effectiveAccess.resources[0]).toMatchObject({
      access: "blocked",
      blockReasons: ["privacy-signal"],
    });
    expect(unrestricted.restrictedPurposeIds).toEqual([]);
  });

  // A bridge for a vendor OpenCookie does not load itself, such as an analytics
  // SDK started from code, needs the purposes the decision permits right now,
  // by the same rule that blocks a resource bound to that purpose alone.
  describe("permittedPurposeIds", () => {
    // marketing depends on analytics.
    const policy = catalogue(["analytics", "marketing"]);
    const policySnapshot = snapshot(policy);
    const resources = defineResourcePolicy({
      policy,
      resources: [],
      services: [],
    });
    if (!resources.ok) throw new Error("Resource policy must be valid.");
    const decide = (grantedPurposeIds?: readonly string[]) => {
      const recorded = recordConsentDecision(
        undefined,
        projectConsentPolicy(policySnapshot),
        {
          decidedAt: 1_000,
          expiresAt: 2_000,
          ...(grantedPurposeIds === undefined
            ? { method: "accept-all" as const }
            : { grantedPurposeIds, method: "granular" as const }),
          recordId: "record-1",
        },
      );
      if (!recorded.ok) throw new Error("Decision must be valid.");
      return recorded.record;
    };
    const permitted = (
      consentRecord: ReturnType<typeof decide> | undefined,
      options: {
        readonly now?: number;
        readonly restrictedPurposeIds?: readonly string[];
      } = {},
    ) =>
      projectConsentRuntimeState({
        ...(consentRecord === undefined ? {} : { consentRecord }),
        now: options.now ?? 1_500,
        policySnapshot,
        ...(options.restrictedPurposeIds === undefined
          ? {}
          : {
              privacyRestrictions: {
                purposeIds: options.restrictedPurposeIds,
                resourceIds: [],
                serviceIds: [],
                source: "gpc" as const,
              },
            }),
        resourcePolicy: resources.resourcePolicy,
      }).permittedPurposeIds;

    it("lists the granted purposes in policy order", () => {
      expect(permitted(decide())).toEqual(["analytics", "marketing"]);
      expect(permitted(decide(["analytics"]))).toEqual(["analytics"]);
    });

    it("leaves out a purpose whose dependency is not granted", () => {
      expect(permitted(decide(["marketing"]))).toEqual([]);
    });

    it("leaves out a purpose a privacy signal restricts, and what depends on it", () => {
      expect(
        permitted(decide(), { restrictedPurposeIds: ["analytics"] }),
      ).toEqual([]);
      expect(
        permitted(decide(), { restrictedPurposeIds: ["marketing"] }),
      ).toEqual(["analytics"]);
    });

    it("is empty before a decision, after withdrawal and after expiry", () => {
      const withdrawn = withdrawConsent(decide(), 1_200);
      if (!withdrawn.ok) throw new Error("Withdrawal must be valid.");

      expect(permitted(undefined)).toEqual([]);
      expect(permitted(withdrawn.record)).toEqual([]);
      expect(permitted(decide(), { now: 2_500 })).toEqual([]);
    });
  });

  it("preserves the authored reason for each declared resource exception", () => {
    const policy = catalogue(["analytics"]);
    const policySnapshot = snapshot(policy);
    const resourceResult = defineResourcePolicy({
      policy,
      resources: [
        {
          access: "declared-exception",
          exceptionReason: "  Keeps the signed-in session available.  ",
          id: "session-cookie",
          serviceId: "session",
        },
      ],
      services: [{ id: "session" }],
    });
    if (!resourceResult.ok) throw new Error("Resource policy must be valid.");

    const runtime = projectConsentRuntimeState({
      now: 1_500,
      policySnapshot,
      resourcePolicy: resourceResult.resourcePolicy,
    });

    expect(runtime.accessPolicy.resources).toEqual([
      {
        access: "declared-exception",
        exceptionReason: "Keeps the signed-in session available.",
        id: "session-cookie",
        purposeIds: [],
        serviceId: "session",
      },
    ]);
    expect(runtime.effectiveAccess.resources).toEqual([
      {
        access: "allowed",
        basis: "declared-exception",
        blockReasons: [],
        resourceId: "session-cookie",
        serviceId: "session",
      },
    ]);
  });

  it("computes policy validity itself and fails closed on a mismatched resource contract", () => {
    const currentPolicy = catalogue(["analytics"]);
    const otherPolicy = catalogue(["analytics", "personalization"]);
    const resourceResult = defineResourcePolicy({
      policy: otherPolicy,
      resources: [
        {
          access: "optional",
          id: "analytics-script",
          purposeIds: ["analytics"],
          serviceId: "metrics",
        },
      ],
      services: [{ id: "metrics" }],
    });
    if (!resourceResult.ok) throw new Error("Resource policy must be valid.");

    const runtime = projectConsentRuntimeState({
      now: 1_500,
      policySnapshot: snapshot(currentPolicy),
      resourcePolicy: resourceResult.resourcePolicy,
    });

    expect(runtime.accessPolicy.valid).toBe(false);
    expect(runtime.effectiveAccess.resources[0]).toEqual({
      access: "blocked",
      blockReasons: ["invalid-policy", "first-visit"],
      resourceId: "analytics-script",
      serviceId: "metrics",
    });
  });

  it("blocks a mismatched resource that names a foreign-only purpose", () => {
    const currentPolicy = catalogue(["analytics"]);
    const otherPolicy = catalogue(["analytics", "personalization"]);
    const resourceResult = defineResourcePolicy({
      policy: otherPolicy,
      resources: [
        {
          access: "optional",
          id: "personalization-script",
          purposeIds: ["personalization"],
          serviceId: "personalization",
        },
      ],
      services: [{ id: "personalization" }],
    });
    if (!resourceResult.ok) throw new Error("Resource policy must be valid.");

    const runtime = projectConsentRuntimeState({
      now: 1_500,
      policySnapshot: snapshot(currentPolicy),
      resourcePolicy: resourceResult.resourcePolicy,
    });

    expect(runtime.accessPolicy.valid).toBe(false);
    expect(runtime.effectiveAccess.resources).toEqual([
      {
        access: "blocked",
        blockReasons: ["invalid-policy", "first-visit"],
        resourceId: "personalization-script",
        serviceId: "personalization",
      },
    ]);
  });

  it("never grants a Google signal from a declared exception or partial mapping", () => {
    const effectiveAccess = {
      resources: [
        {
          access: "allowed" as const,
          basis: "declared-exception" as const,
          blockReasons: [] as const,
          resourceId: "session-cookie",
          serviceId: "session",
        },
        {
          access: "blocked" as const,
          blockReasons: ["denied" as const],
          resourceId: "analytics-script",
          serviceId: "metrics",
        },
      ],
    };

    expect(
      projectGoogleConsentModeState(effectiveAccess, {
        adStorageResourceIds: ["missing-resource"],
        analyticsStorageResourceIds: ["session-cookie", "analytics-script"],
      }),
    ).toEqual({
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "denied",
    });
  });

  it.each([
    ["current", "active"],
    ["requires-reconsent", "requires-reconsent"],
    ["invalid", "requires-reconsent"],
    ["expired", "expired"],
    ["withdrawn", "withdrawn"],
  ] as const)(
    "maps verified %s reconciliation to %s access",
    (reconciliationStatus, accessStatus) => {
      const previousPolicy = catalogue(["analytics"]);
      const previousSnapshot = snapshot(previousPolicy);
      const currentDefinition =
        reconciliationStatus === "requires-reconsent"
          ? definePolicy(
              completeTestPolicyDefinition({
                purposes: [
                  { disclosure: "Changed disclosure", id: "analytics" },
                ],
              }),
            )
          : { ok: true as const, policy: previousPolicy };
      if (!currentDefinition.ok) throw new Error("Policy must be valid.");
      const policySnapshot =
        reconciliationStatus === "requires-reconsent"
          ? createPolicySnapshot({
              catalogueRevision: "catalogue-2",
              policy: currentDefinition.policy,
              policyVersion: "policy-2",
            })
          : previousSnapshot;
      const resourceResult = defineResourcePolicy({
        policy: currentDefinition.policy,
        resources: [],
        services: [],
      });
      if (!resourceResult.ok) throw new Error("Resource policy must be valid.");
      const consentPolicy = projectConsentPolicy(previousSnapshot);
      const recorded = recordConsentDecision(undefined, consentPolicy, {
        decidedAt: 1_000,
        expiresAt: reconciliationStatus === "expired" ? 1_500 : 3_000,
        method:
          reconciliationStatus === "withdrawn" ? "reject-all" : "accept-all",
        recordId: "record-mapping",
      });
      if (!recorded.ok) throw new Error("Decision must be valid.");
      const record =
        reconciliationStatus === "withdrawn"
          ? {
              ...recorded.record,
              method: "withdrawal" as const,
              withdrawnAt: 1_500,
            }
          : reconciliationStatus === "invalid"
            ? {
                ...recorded.record,
                policy: {
                  ...recorded.record.policy,
                  decisionSurfaceDigest: "foreign-digest",
                },
              }
            : recorded.record;

      const runtime = projectConsentRuntimeState({
        consentRecord: record,
        now: 2_000,
        policyHistory:
          reconciliationStatus === "requires-reconsent"
            ? [policySnapshot, previousSnapshot]
            : [policySnapshot],
        policySnapshot,
        resourcePolicy: resourceResult.resourcePolicy,
      });

      expect(runtime.policyReconciliation?.status).toBe(reconciliationStatus);
      expect(runtime.accessConsent.status).toBe(accessStatus);
    },
  );
});
