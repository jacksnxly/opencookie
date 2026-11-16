import { describe, expect, it, vi } from "vitest";

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
      {
        access: "optional",
        id: "personalization-script",
        purposeIds: ["personalization"],
        serviceId: "personalization",
      },
    ],
    services: [{ id: "metrics" }, { id: "personalization" }],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function activeAnalyticsRecord(): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "denied" },
    expiresAt: 86_401_000,
    method: "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-post-correction",
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

describe("createOpenCookie post-correction terminal authority", () => {
  it("does not replay an older terminal signal after a newer grant activates", async () => {
    const initial = activeAnalyticsRecord();
    const broaderStageStarted = deferred();
    const releaseBroaderStage = deferred();
    const correctionStarted = deferred();
    const releaseCorrection = deferred();
    const callbacks: Array<{
      readonly access: "allowed" | "blocked";
      readonly method: PersistedDecisionRecord["method"];
      readonly port: "broadcast" | "reconcile";
      readonly transitionId: string;
    }> = [];
    let durable: PersistedConsentState | null = { record: initial };
    let broaderTransitionId: string | undefined;
    let holdBroaderStage = true;
    const store: DecisionStore = {
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
      compareAndSet: async (expected, candidate) => {
        if (
          holdBroaderStage &&
          candidate.pendingGrant?.kind === "decision" &&
          candidate.pendingGrant.candidate.method === "accept-all"
        ) {
          holdBroaderStage = false;
          broaderTransitionId = candidate.pendingGrant.transitionId;
          broaderStageStarted.resolve();
          await releaseBroaderStage.promise;
        }
        if (!statesEqual(durable, expected)) {
          return { status: "conflict" as const };
        }
        durable = candidate;
        return { status: "written" as const };
      },
      read: () =>
        Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const },
        ),
    };
    const observe = async (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
    ): Promise<void> => {
      callbacks.push({
        access: accessOf(effect),
        method: effect.record.method,
        port,
        transitionId: effect.transitionId,
      });
      if (
        port === "broadcast" &&
        effect.transitionId === broaderTransitionId &&
        accessOf(effect) === "blocked"
      ) {
        correctionStarted.resolve();
        await releaseCorrection.promise;
      }
    };
    let transitionSequence = 0;
    let recordSequence = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => observe("broadcast", effect),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "transition"
          ? `transition-${String(++transitionSequence)}`
          : `record-${String(++recordSequence)}`,
      now: () => now,
      reconcile: (effect) => observe("reconcile", effect),
      ...runtimePolicy(),
      store,
    });
    await within(client.initialize(), "initialization");
    callbacks.length = 0;
    now = 2_000;

    const broaderGrant = client.acceptAll();
    await within(broaderStageStarted.promise, "broader grant stage");
    now = 3_000;
    const rejection = client.rejectAll();

    let newerGrant: ReturnType<typeof client.savePreferences> | undefined;
    try {
      await within(correctionStarted.promise, "exact blocked correction");
      await vi.waitFor(() => {
        expect(durable?.record?.method).toBe("reject-all");
      });
      const terminalTransitionId = `transition-${String(transitionSequence)}`;
      releaseBroaderStage.resolve();

      now = 4_000;
      newerGrant = client.savePreferences(["analytics"]);
      await expect(
        within(newerGrant, "newer grant activation"),
      ).resolves.toMatchObject({
        outcome: "committed",
        transition: {
          record: {
            decisions: { analytics: "granted", personalization: "denied" },
            method: "granular",
            revision: 3,
          },
        },
      });
      const newerBoundary = callbacks.length;

      releaseCorrection.resolve();
      await within(
        Promise.allSettled([broaderGrant, rejection]),
        "older operations",
      );

      expect(terminalTransitionId).toBeDefined();
      expect(callbacks.slice(newerBoundary)).not.toContainEqual(
        expect.objectContaining({ transitionId: terminalTransitionId }),
      );
      expect(callbacks.slice(newerBoundary)).not.toContainEqual(
        expect.objectContaining({ method: "reject-all" }),
      );
      expect(durable).toMatchObject({
        record: {
          decisions: { analytics: "granted", personalization: "denied" },
          method: "granular",
          revision: 3,
        },
      });
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        record: { method: "granular", revision: 3 },
      });
      expect(snapshotAccess(client)).toBe("allowed");
    } finally {
      releaseCorrection.resolve();
      releaseBroaderStage.resolve();
      await Promise.allSettled([
        broaderGrant,
        rejection,
        ...(newerGrant === undefined ? [] : [newerGrant]),
      ]);
    }
  });
});
