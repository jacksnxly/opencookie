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

function activeGrant(revision = 1): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: revision * 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "granted" },
    expiresAt: 86_400_000 + revision * 1_000,
    method: "accept-all",
    policyVersion: policySnapshot.policyVersion,
    recordId: `record-grant-${String(revision)}`,
    revision,
  };
}

function storedState(kind: "active" | "pending"): PersistedConsentState {
  const record = activeGrant();
  if (kind === "active") return { record };
  return {
    pendingGrant: {
      candidate: { ...activeGrant(2), recordId: record.recordId },
      kind: "decision",
      receiptOccurredAt: 2_000,
      transitionId: "transition-pending-grant",
    },
    record,
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

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function gatedStore(initial: PersistedConsentState | null): {
  readonly readStarted: Promise<void>;
  readonly releaseRead: () => void;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  let durable = initial;
  const started = deferred();
  const release = deferred();
  return {
    readStarted: started.promise,
    releaseRead: release.resolve,
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
      compareAndSet: (expected, candidate) => {
        if (!statesEqual(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        durable = candidate;
        return Promise.resolve({ status: "written" as const });
      },
      read: async () => {
        started.resolve();
        await release.promise;
        return durable === null
          ? { status: "missing" as const }
          : { state: durable, status: "stored" as const };
      },
    },
    stored: () => durable,
  };
}

async function within<Result>(
  promise: Promise<Result>,
  label: string,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out.`));
    }, 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function effectAccess(
  effect: ConsentRuntimeTransitionEffect,
): "allowed" | "blocked" {
  const resource = effect.runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

function snapshotAccess(
  client: ReturnType<typeof createOpenCookie>,
): "allowed" | "blocked" {
  const resource = client
    .getSnapshot()
    .runtime.effectiveAccess.resources.find(
      ({ resourceId }) => resourceId === "analytics-script",
    );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

describe("createOpenCookie pre-initialization terminal authority", () => {
  it("blocks an exact cold pending grant before withdrawal persistence and forgets its lineage", async () => {
    const pendingRecord = activeGrant();
    let durable: PersistedConsentState | null = {
      pendingGrant: {
        candidate: pendingRecord,
        kind: "decision",
        receiptOccurredAt: 1_000,
        transitionId: "transition-pending-grant",
      },
    };
    const terminalCasStarted = deferred();
    const releaseTerminalCas = deferred();
    const observed: Array<{
      readonly context: "absent" | "present";
      readonly effect: ConsentRuntimeTransitionEffect;
      readonly port: "broadcast" | "reconcile";
    }> = [];
    let compareAndSetCalls = 0;
    let terminalCasHeld = false;
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
        compareAndSetCalls += 1;
        if (
          !terminalCasHeld &&
          candidate.record?.method === "reject-all" &&
          candidate.pendingGrant === undefined
        ) {
          terminalCasHeld = true;
          terminalCasStarted.resolve();
          await releaseTerminalCas.promise;
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
    let generated = 0;
    const client = createOpenCookie({
      broadcast: (effect, context) => {
        observed.push({
          context: context === undefined ? "absent" : "present",
          effect,
          port: "broadcast",
        });
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      reconcile: (effect, context) => {
        observed.push({
          context: context === undefined ? "absent" : "present",
          effect,
          port: "reconcile",
        });
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store,
    });

    const withdrawal = client.withdrawConsent();
    let withdrawalSettled = false;
    void withdrawal.finally(() => {
      withdrawalSettled = true;
    });
    try {
      await within(terminalCasStarted.promise, "cold pending terminal CAS");

      expect(snapshotAccess(client)).toBe("blocked");
      expect(withdrawalSettled).toBe(false);
      expect(observed).toHaveLength(2);
      for (const { context, effect, port } of observed) {
        expect(["broadcast", "reconcile"]).toContain(port);
        expect(context).toBe("present");
        expect(effect).toMatchObject({
          events: [],
          persistenceStatus: "pending",
          transitionId: "transition-pending-grant",
        });
        expect(effectAccess(effect)).toBe("blocked");
      }
    } finally {
      releaseTerminalCas.resolve();
    }

    await expect(
      within(withdrawal, "cold pending withdrawal"),
    ).resolves.toMatchObject({
      outcome: "committed",
      transition: { record: { method: "reject-all" } },
    });
    expect(durable).not.toHaveProperty("pendingGrant");
    const callsAfterCancellation = compareAndSetCalls;
    const effectsAfterCancellation = observed.length;

    await expect(client.withdrawConsent()).resolves.toMatchObject({
      outcome: "unchanged",
    });
    expect(compareAndSetCalls).toBe(callsAfterCancellation);
    expect(observed).toHaveLength(effectsAfterCancellation);
  });

  it.each([
    ["reject-all", "active"],
    ["reject-all", "pending"],
    ["deny-all", "active"],
    ["deny-all", "pending"],
    ["withdraw", "active"],
    ["withdraw", "pending"],
  ] as const)(
    "keeps direct %s authoritative over a stored %s grant",
    async (action, storedKind) => {
      const memory = gatedStore(storedState(storedKind));
      const snapshots: Array<"allowed" | "blocked"> = [];
      const broadcasts: Array<"allowed" | "blocked"> = [];
      const reconciles: Array<"allowed" | "blocked"> = [];
      let generated = 0;
      const client = createOpenCookie({
        broadcast: (effect) => {
          broadcasts.push(effectAccess(effect));
          return Promise.resolve();
        },
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => 3_000,
        reconcile: (effect) => {
          reconciles.push(effectAccess(effect));
          return Promise.resolve();
        },
        ...runtimePolicy(),
        store: memory.store,
      });
      client.subscribe(() => snapshots.push(snapshotAccess(client)));

      const terminal =
        action === "reject-all"
          ? client.rejectAll()
          : action === "deny-all"
            ? client.savePreferences([])
            : client.withdrawConsent();
      await within(memory.readStarted, "initial persisted-state read");

      expect(snapshotAccess(client)).toBe("blocked");
      memory.releaseRead();
      const result = await within<Awaited<typeof terminal>>(
        terminal,
        `${action} completion`,
      );

      expect(["committed", "degraded", "not-applicable"]).toContain(
        result.outcome,
      );
      if ("effect" in result)
        expect(effectAccess(result.effect)).toBe("blocked");
      expect(snapshotAccess(client)).toBe("blocked");
      expect(memory.stored()).not.toHaveProperty("pendingGrant");
      expect(memory.stored()?.record).toMatchObject({
        decisions: { analytics: "denied", personalization: "denied" },
        method:
          action === "reject-all"
            ? "reject-all"
            : action === "deny-all"
              ? "granular"
              : "withdrawal",
      });
      expect(snapshots).not.toContain("allowed");
      expect(broadcasts).toContain("blocked");
      expect(broadcasts).not.toContain("allowed");
      expect(reconciles).toContain("blocked");
      expect(reconciles).not.toContain("allowed");
    },
  );

  it("settles two synchronous first-visit rejections without an internal invariant", async () => {
    const memory = gatedStore(null);
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 1_000,
      ...runtimePolicy(),
      store: memory.store,
    });
    let first!: ReturnType<typeof client.rejectAll>;
    let second!: ReturnType<typeof client.rejectAll>;

    expect(() => {
      first = client.rejectAll();
      second = client.rejectAll();
    }).not.toThrow();
    await within(memory.readStarted, "first-visit persisted-state read");
    memory.releaseRead();

    const results = await within(
      Promise.allSettled([first, second]),
      "synchronous first-visit rejections",
    );
    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    expect(memory.stored()).toMatchObject({
      record: {
        decisions: { analytics: "denied", personalization: "denied" },
        method: "reject-all",
      },
    });
  });
});
