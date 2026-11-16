import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../index.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../../domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";
import { persistedConsentStatesEqual } from "./persisted-consent-record.js";

function runtimePolicy() {
  const catalogue = definePolicy(
    completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }, { id: "personalization" }],
    }),
  );
  if (!catalogue.ok) throw new Error("Policy must be valid.");

  const policySnapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: catalogue.policy,
    policyVersion: "policy-1",
  });
  const resources = defineResourcePolicy({
    policy: catalogue.policy,
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
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function access(effect: ConsentRuntimeTransitionEffect) {
  const analytics = effect.runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  );
  if (!analytics) throw new Error("Analytics resource must be projected.");
  return analytics.access;
}

function same(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
) {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

describe("createOpenCookie post-read exits", () => {
  it.each([
    "invalid-clock",
    "invalid-decision",
    "withdraw-invalid-clock",
  ] as const)(
    "blocks retained access after adopting an exact denial before an %s exit",
    async (mode) => {
      const policy = runtimePolicy();
      const completed: PersistedDecisionRecord = {
        catalogueDigest: policy.policySnapshot.catalogueDigest,
        decidedAt: 1_000,
        decisionSurfaceDigest: policy.policySnapshot.decisionSurfaceDigest,
        decisions: { analytics: "granted", personalization: "denied" },
        expiresAt: 86_401_000,
        method: "granular",
        policyVersion: policy.policySnapshot.policyVersion,
        recordId: "record-a",
        revision: 1,
      };
      const externalDenial: PersistedDecisionRecord = {
        ...completed,
        decidedAt: 1_500,
        decisions: { analytics: "denied", personalization: "denied" },
        expiresAt: 86_401_500,
        method: "reject-all",
        recordId: "record-u",
        revision: 7,
      };
      let durable: PersistedConsentState | null = { record: completed };
      let writesAllowed = true;
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (!same(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          if (!writesAllowed) {
            return Promise.reject(new Error("decision storage unavailable"));
          }
          if (!same(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        },
        read: () =>
          Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          ),
      };
      const order: string[] = [];
      let now = 2_000;
      let generated = 0;
      const client = createOpenCookie({
        broadcast: (effect) => {
          order.push(`broadcast:${access(effect)}`);
          return Promise.resolve();
        },
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => now,
        reconcile: (effect) => {
          order.push(`reconcile:${access(effect)}`);
          return Promise.resolve();
        },
        ...policy,
        store,
      });
      await client.initialize();
      writesAllowed = false;

      const pending = await client.acceptAll();
      expect(pending).toMatchObject({ outcome: "pending" });
      if (!("effect" in pending)) {
        throw new Error("Failed widening must expose its conservative effect.");
      }
      expect(access(pending.effect)).toBe("allowed");

      durable = { record: externalDenial };
      order.length = 0;
      if (mode !== "invalid-decision") now = Number.POSITIVE_INFINITY;
      const operation =
        mode === "withdraw-invalid-clock"
          ? client.withdrawConsent()
          : client.savePreferences([
              mode === "invalid-clock" ? "personalization" : "unknown-purpose",
            ]);
      const decision = operation.then(
        (result) => {
          order.push("settled");
          return result;
        },
        (error: unknown) => {
          order.push("settled");
          throw error;
        },
      );

      if (mode !== "invalid-decision") {
        await expect(decision).rejects.toThrow(
          "Current time must be a finite safe integer.",
        );
      } else {
        await expect(decision).resolves.toMatchObject({ outcome: "rejected" });
      }
      const snapshotAccess = client
        .getSnapshot()
        .runtime.effectiveAccess.resources.find(
          ({ resourceId }) => resourceId === "analytics-script",
        )?.access;
      expect({ order, snapshotAccess }).toEqual({
        order: ["broadcast:blocked", "reconcile:blocked", "settled"],
        snapshotAccess: "blocked",
      });
    },
  );
});
