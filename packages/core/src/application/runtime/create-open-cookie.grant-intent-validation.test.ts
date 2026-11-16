import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type PersistedConsentState,
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

function controlledStore(): {
  readonly armStageGate: (timing: "before-write" | "after-write") => void;
  readonly decisionStageWrites: () => number;
  readonly releaseStage: () => void;
  readonly stageStarted: Promise<void>;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  let durable: PersistedConsentState | null = null;
  let gateTiming: "before-write" | "after-write" | undefined;
  let decisionStageWrites = 0;
  const started = deferred();
  const release = deferred();
  const write = (
    expected: PersistedConsentState | null,
    candidate: PersistedConsentState,
  ) => {
    if (!statesEqual(durable, expected)) {
      return { status: "conflict" as const };
    }
    durable = candidate;
    return { status: "written" as const };
  };
  return {
    armStageGate: (timing) => {
      gateTiming = timing;
    },
    decisionStageWrites: () => decisionStageWrites,
    releaseStage: release.resolve,
    stageStarted: started.promise,
    store: {
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
        if (candidate.pendingGrant?.kind !== "decision") {
          return write(expected, candidate);
        }
        decisionStageWrites += 1;
        const timing = gateTiming;
        gateTiming = undefined;
        if (timing === "after-write") {
          const result = write(expected, candidate);
          started.resolve();
          await release.promise;
          return result;
        }
        if (timing === "before-write") {
          started.resolve();
          await release.promise;
        }
        return write(expected, candidate);
      },
      read: () =>
        Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const },
        ),
    },
    stored: () => durable,
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

interface GrantFixture {
  readonly broadcastCount: () => number;
  readonly client: ReturnType<typeof createOpenCookie>;
  readonly memory: ReturnType<typeof controlledStore>;
  readonly reconcileCount: () => number;
  readonly receiptCount: () => number;
  readonly releaseSignal: () => void;
  readonly signalStarted: Promise<void>;
  readonly startSignalGate: () => void;
}

async function grantFixture(): Promise<GrantFixture> {
  const memory = controlledStore();
  const signalStarted = deferred();
  const releaseSignal = deferred();
  let holdSignal = false;
  let broadcasts = 0;
  let reconciles = 0;
  let receipts = 0;
  let generated = 0;
  const client = createOpenCookie({
    broadcast: async (effect) => {
      if (effect.record.method === "accept-all") broadcasts += 1;
      if (
        holdSignal &&
        effect.record.method === "accept-all" &&
        accessOf(effect) === "allowed"
      ) {
        holdSignal = false;
        signalStarted.resolve();
        await releaseSignal.promise;
      }
    },
    consentDurationMs: 86_400_000,
    idGenerator: (kind) => `${kind}-${String(++generated)}`,
    now: () => 1_000,
    receipt: (receipt) => {
      if (receipt.method === "accept-all") receipts += 1;
      return Promise.resolve();
    },
    reconcile: (effect) => {
      if (effect.record.method === "accept-all") reconciles += 1;
      return Promise.resolve();
    },
    ...runtimePolicy(),
    store: memory.store,
  });
  await within(client.initialize(), "initialization");
  return {
    broadcastCount: () => broadcasts,
    client,
    memory,
    reconcileCount: () => reconciles,
    receiptCount: () => receipts,
    releaseSignal: releaseSignal.resolve,
    signalStarted: signalStarted.promise,
    startSignalGate: () => {
      holdSignal = true;
    },
  };
}

describe("createOpenCookie grant intent validation", () => {
  it("preserves invalid consent capture through the coordinator", async () => {
    let callbacks = 0;
    let compareAndSets = 0;
    const client = createOpenCookie({
      broadcast: () => {
        callbacks += 1;
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      consentId: 42 as unknown as string,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      receipt: () => {
        callbacks += 1;
        return Promise.resolve();
      },
      reconcile: () => {
        callbacks += 1;
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("conflict"),
        compareAndSet: () => {
          compareAndSets += 1;
          return Promise.resolve({ status: "written" });
        },
        read: () => Promise.resolve({ status: "missing" }),
      },
    });

    await expect(client.acceptAll()).resolves.toEqual({
      issues: [{ code: "invalid-consent-id", path: "consentId" }],
      outcome: "rejected",
    });
    expect(compareAndSets).toBe(0);
    expect(callbacks).toBe(0);
  });

  it.each(["durable-stage", "signal"] as const)(
    "keeps a valid grant authoritative when invalid input arrives during %s",
    async (phase) => {
      const fixture = await grantFixture();
      if (phase === "durable-stage") {
        fixture.memory.armStageGate("after-write");
      } else {
        fixture.startSignalGate();
      }

      const grant = fixture.client.acceptAll();
      await within(
        phase === "durable-stage"
          ? fixture.memory.stageStarted
          : fixture.signalStarted,
        `grant ${phase}`,
      );
      if (phase === "durable-stage") {
        expect(fixture.memory.stored()).toMatchObject({
          pendingGrant: {
            candidate: { method: "accept-all", revision: 1 },
            kind: "decision",
          },
        });
      }

      const invalid = fixture.client.savePreferences(["unknown-purpose"]);
      try {
        if (phase === "signal") {
          await expect(
            within(invalid, "invalid decision"),
          ).resolves.toMatchObject({ outcome: "rejected" });
        }
      } finally {
        fixture.memory.releaseStage();
        fixture.releaseSignal();
      }

      const [grantResult, invalidResult] = await within(
        Promise.all([grant, invalid]),
        "valid and invalid decisions",
      );
      expect(grantResult).toMatchObject({
        outcome: "committed",
        transition: { record: { method: "accept-all", revision: 1 } },
      });
      expect(invalidResult).toMatchObject({ outcome: "rejected" });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: "accept-all", revision: 1 },
      });
      expect(fixture.memory.stored()).not.toHaveProperty("pendingGrant");
      expect(fixture.client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        record: { method: "accept-all", revision: 1 },
      });
      expect(snapshotAccess(fixture.client)).toBe("allowed");
      expect(fixture.memory.decisionStageWrites()).toBe(1);
      expect(fixture.broadcastCount()).toBe(1);
      expect(fixture.reconcileCount()).toBe(1);
      expect(fixture.receiptCount()).toBe(1);
    },
  );

  it("keeps an initial grant live when retry is called before its first write", async () => {
    const fixture = await grantFixture();
    fixture.memory.armStageGate("before-write");
    const grant = fixture.client.acceptAll();
    await within(fixture.memory.stageStarted, "initial grant prewrite");
    expect(fixture.memory.stored()).toBeNull();

    try {
      await expect(
        within(fixture.client.retryPendingGrant(), "premature retry"),
      ).resolves.toMatchObject({ outcome: "not-applicable" });
    } finally {
      fixture.memory.releaseStage();
    }

    await expect(within(grant, "original grant")).resolves.toMatchObject({
      outcome: "committed",
      transition: { record: { method: "accept-all", revision: 1 } },
    });
    expect(fixture.memory.stored()).toMatchObject({
      record: { method: "accept-all", revision: 1 },
    });
    expect(fixture.client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      record: { method: "accept-all", revision: 1 },
    });
    expect(snapshotAccess(fixture.client)).toBe("allowed");
    expect(fixture.memory.decisionStageWrites()).toBe(1);
    expect(fixture.receiptCount()).toBe(1);
  });

  it("coalesces repeated identical grants without invalidating shared work", async () => {
    const fixture = await grantFixture();
    fixture.startSignalGate();
    const first = fixture.client.acceptAll();
    await within(fixture.signalStarted, "first grant signal");
    const second = fixture.client.acceptAll();

    try {
      await Promise.resolve();
      expect(fixture.memory.decisionStageWrites()).toBe(1);
    } finally {
      fixture.releaseSignal();
    }

    const [firstResult, secondResult] = await within(
      Promise.all([first, second]),
      "coalesced grants",
    );
    expect(firstResult).toMatchObject({ outcome: "committed" });
    expect(secondResult).toMatchObject({ outcome: "committed" });
    if (
      firstResult.outcome !== "committed" ||
      secondResult.outcome !== "committed"
    ) {
      throw new Error("Identical grants must both observe committed work.");
    }
    expect(secondResult.transition.transitionId).toBe(
      firstResult.transition.transitionId,
    );
    expect(secondResult.transition.record).toEqual(
      firstResult.transition.record,
    );
    expect(fixture.memory.stored()).toMatchObject({
      record: { method: "accept-all", revision: 1 },
    });
    expect(fixture.client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      record: { method: "accept-all", revision: 1 },
    });
    expect(snapshotAccess(fixture.client)).toBe("allowed");
    expect(fixture.memory.decisionStageWrites()).toBe(1);
    expect(fixture.broadcastCount()).toBe(1);
    expect(fixture.reconcileCount()).toBe(1);
    expect(fixture.receiptCount()).toBe(1);
  });
});
