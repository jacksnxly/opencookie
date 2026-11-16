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

type PersistedActiveDecisionRecord = Exclude<
  PersistedDecisionRecord,
  { readonly method: "withdrawal" }
>;

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

function completedAnalyticsRecord(): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "denied" },
    expiresAt: 10_000,
    method: "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-expiry-authority",
    revision: 1,
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<Result>(
  promise: Promise<Result>,
  label: string,
  timeoutMs = 2_000,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function exactStore(initial: PersistedConsentState): DecisionStore {
  let durable: PersistedConsentState | null = initial;
  return {
    clear: () => {
      durable = null;
      return Promise.resolve();
    },
    clearIfCurrent: (expected) => {
      if (!statesEqual(durable, expected)) {
        return Promise.resolve("conflict" as const);
      }
      durable = null;
      return Promise.resolve("cleared" as const);
    },
    compareAndSet: (expected, candidate) => {
      if (!statesEqual(durable, expected)) {
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
}

function accessOf(effect: ConsentRuntimeTransitionEffect) {
  const resource = effect.runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

function snapshotAccess(client: ReturnType<typeof createOpenCookie>) {
  const resource = client
    .getSnapshot()
    .runtime.effectiveAccess.resources.find(
      ({ resourceId }) => resourceId === "analytics-script",
    );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

describe("createOpenCookie expiry signal authority", () => {
  it.each([false, true])(
    "replays expiry blocking after an older allowed repair resumes (rejects: %s)",
    async (rejectRepair) => {
      const oldTerminalReconcileStarted = deferred();
      const releaseOldTerminalReconcile = deferred();
      const staleAllowedRepairStarted = deferred();
      const releaseStaleAllowedRepair = deferred();
      let holdOldTerminal = false;
      let allowedGrantReconciles = 0;
      let enforced: "allowed" | "blocked" = "blocked";
      let expiryBlockedBroadcasts = 0;
      let expiryBlockedReconciles = 0;
      let generated = 0;
      let now = 1_000;
      const apply = (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ) => {
        enforced = accessOf(effect);
        if (
          effect.runtime.consentEvaluation.status === "expired" &&
          accessOf(effect) === "blocked"
        ) {
          if (port === "broadcast") expiryBlockedBroadcasts += 1;
          else expiryBlockedReconciles += 1;
        }
      };
      const client = createOpenCookie({
        broadcast: (effect) => {
          apply("broadcast", effect);
          return Promise.resolve();
        },
        consentDurationMs: 1_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => now,
        reconcile: async (effect) => {
          apply("reconcile", effect);
          if (
            holdOldTerminal &&
            effect.record.method === "reject-all" &&
            accessOf(effect) === "blocked"
          ) {
            holdOldTerminal = false;
            oldTerminalReconcileStarted.resolve();
            await releaseOldTerminalReconcile.promise;
            return;
          }
          if (
            effect.record.method === "accept-all" &&
            accessOf(effect) === "allowed"
          ) {
            allowedGrantReconciles += 1;
            if (allowedGrantReconciles === 2) {
              staleAllowedRepairStarted.resolve();
              await releaseStaleAllowedRepair.promise;
              enforced = "allowed";
              if (rejectRepair) throw new Error("stale allowed repair failed");
            }
          }
        },
        ...runtimePolicy(),
        store: exactStore({ record: completedAnalyticsRecord() }),
      });
      await within(client.initialize(), "initialization");
      now = 2_000;
      holdOldTerminal = true;

      const oldTerminal = client.rejectAll();
      let newerGrant: ReturnType<typeof client.acceptAll> | undefined;
      try {
        await within(
          oldTerminalReconcileStarted.promise,
          "old terminal reconcile",
        );

        now = 2_500;
        newerGrant = client.acceptAll();
        await expect(within(newerGrant, "newer grant")).resolves.toMatchObject({
          outcome: "committed",
        });
        expect(snapshotAccess(client)).toBe("allowed");
        expect(enforced).toBe("allowed");
        expect(allowedGrantReconciles).toBe(1);

        releaseOldTerminalReconcile.resolve();
        await within(staleAllowedRepairStarted.promise, "stale allowed repair");

        now = 3_501;
        await within(client.refresh(), "expiry refresh");
        expect(client.getSnapshot().runtime.consentEvaluation.status).toBe(
          "expired",
        );
        expect(snapshotAccess(client)).toBe("blocked");
        expect(expiryBlockedBroadcasts).toBe(1);
        expect(expiryBlockedReconciles).toBe(1);
        expect(enforced).toBe("blocked");

        releaseStaleAllowedRepair.resolve();
        await within(oldTerminal, "old terminal repair completion");

        expect(client.getSnapshot().runtime.consentEvaluation.status).toBe(
          "expired",
        );
        expect(snapshotAccess(client)).toBe("blocked");
        expect(enforced).toBe("blocked");
      } finally {
        releaseOldTerminalReconcile.resolve();
        releaseStaleAllowedRepair.resolve();
        await Promise.allSettled(
          newerGrant === undefined ? [oldTerminal] : [oldTerminal, newerGrant],
        );
      }
    },
  );
});
