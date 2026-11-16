import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type OpenCookie,
  type OpenCookieSnapshot,
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

function exactStateStore(initial: PersistedConsentState | null = null): {
  readonly mutationCount: () => number;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
  readonly writes: () => readonly PersistedConsentState[];
} {
  let durable = initial;
  let mutations = 0;
  const writes: PersistedConsentState[] = [];

  return {
    mutationCount: () => mutations,
    store: {
      clear: () => {
        mutations += 1;
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        mutations += 1;
        if (durable === null) return Promise.resolve("cleared" as const);
        if (!statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        mutations += 1;
        writes.push(candidate);
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
    },
    stored: () => durable,
    writes: () => writes,
  };
}

describe("createOpenCookie durable pending grant staging", () => {
  it("publishes a blocked first-grant snapshot before its broadcaster resolves", async () => {
    const memory = exactStateStore();
    const broadcastStarted = deferred();
    const releaseBroadcast = deferred();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    let observedSnapshot: OpenCookieSnapshot | undefined;
    const client: OpenCookie = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        observedSnapshot = client.getSnapshot();
        broadcastStarted.resolve();
        return releaseBroadcast.promise;
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record" ? "record-first" : "transition-first",
      now: () => 1_000,
      receipt,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const acceptance = client.acceptAll();
    await broadcastStarted.promise;

    try {
      const snapshot = client.getSnapshot();
      expect(snapshot).toMatchObject({
        grantActivation: "pending",
        pendingGrant: {
          phase: "broadcast",
          transitionId: "transition-first",
        },
        runtime: {
          effectiveAccess: {
            resources: [{ access: "blocked", resourceId: "analytics-script" }],
          },
        },
      });
      expect(snapshot).not.toHaveProperty("record");
      expect(observedSnapshot).toBe(snapshot);
      expect(memory.stored()).toMatchObject({
        pendingGrant: {
          candidate: {
            decidedAt: 1_000,
            expiresAt: 86_401_000,
            method: "accept-all",
            recordId: "record-first",
            revision: 1,
          },
          kind: "decision",
          receiptOccurredAt: 1_000,
          transitionId: "transition-first",
        },
      });
      expect(memory.stored()).not.toHaveProperty("record");
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        events: [],
        transitionId: "transition-first",
      });
      expect(receipt).not.toHaveBeenCalled();
    } finally {
      releaseBroadcast.resolve();
      await Promise.allSettled([acceptance]);
    }
  });

  it("retains the old public record while a replacement grant is blocked", async () => {
    const runtime = runtimePolicy();
    const activeRecord: PersistedDecisionRecord = {
      catalogueDigest: runtime.policySnapshot.catalogueDigest,
      decidedAt: 1_000,
      decisionSurfaceDigest: runtime.policySnapshot.decisionSurfaceDigest,
      decisions: { analytics: "granted", personalization: "granted" },
      expiresAt: 86_401_000,
      method: "accept-all",
      policyVersion: runtime.policySnapshot.policyVersion,
      recordId: "record-1",
      revision: 1,
    };
    const memory = exactStateStore({ record: activeRecord });
    const replacementStarted = deferred();
    const releaseReplacement = deferred();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    const transitionIds = ["transition-restore", "transition-replacement"];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        if (effect.transitionId === "transition-replacement") {
          replacementStarted.resolve();
          return releaseReplacement.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "transition"
          ? (transitionIds.shift() ?? "unexpected-transition")
          : "unexpected-id",
      now: () => now,
      receipt,
      ...runtime,
      store: memory.store,
    });
    await client.initialize();
    expect(client.getSnapshot()).toMatchObject({
      record: { recordId: "record-1", revision: 1 },
    });
    effects.length = 0;
    now = 2_000;

    const replacement = client.savePreferences(["analytics"]);
    await replacementStarted.promise;

    try {
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "pending",
        pendingGrant: {
          phase: "broadcast",
          transitionId: "transition-replacement",
        },
        record: {
          method: "accept-all",
          recordId: "record-1",
          revision: 1,
        },
        runtime: {
          effectiveAccess: {
            resources: [{ access: "blocked", resourceId: "analytics-script" }],
          },
        },
      });
      expect(memory.stored()).toMatchObject({
        pendingGrant: {
          candidate: {
            decidedAt: 2_000,
            method: "granular",
            recordId: "record-1",
            revision: 2,
          },
          kind: "decision",
          receiptOccurredAt: 2_000,
          transitionId: "transition-replacement",
        },
        record: {
          method: "accept-all",
          recordId: "record-1",
          revision: 1,
        },
      });
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        events: [],
        transitionId: "transition-replacement",
      });
      expect(receipt).not.toHaveBeenCalled();
    } finally {
      releaseReplacement.resolve();
      await Promise.allSettled([replacement]);
    }
  });

  it("does not write, publish, or run effects for invalid input", async () => {
    const memory = exactStateStore();
    const broadcast = vi.fn(() => Promise.resolve());
    const receipt = vi.fn(() => Promise.resolve());
    const reconcile = vi.fn(() => Promise.resolve());
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-invalid-input`,
      now: () => 1_000,
      receipt,
      reconcile,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const before = client.getSnapshot();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);

    await expect(
      client.savePreferences(["unknown-purpose"]),
    ).resolves.toMatchObject({ outcome: "rejected" });

    expect(memory.mutationCount()).toBe(0);
    expect(memory.stored()).toBeNull();
    expect(broadcast).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toBe(before);
    unsubscribe();
  });

  it("stages a later valid intent while the first broadcaster is unresolved", async () => {
    const memory = exactStateStore();
    const firstBroadcastStarted = deferred();
    const releaseFirstBroadcast = deferred();
    const broadcast = vi.fn((effect: ConsentRuntimeTransitionEffect) => {
      if (
        effect.transitionId === "transition-first" &&
        !firstBroadcastStartedResolved
      ) {
        firstBroadcastStartedResolved = true;
        firstBroadcastStarted.resolve();
        return releaseFirstBroadcast.promise;
      }
      return Promise.resolve();
    });
    const generated = ["record-1", "transition-first", "transition-second"];
    let firstBroadcastStartedResolved = false;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 86_400_000,
      idGenerator: () => generated.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const first = client.acceptAll();
    await firstBroadcastStarted.promise;
    now = 2_000;
    const second = client.savePreferences(["analytics"]);

    try {
      await vi.waitFor(
        () => {
          expect(memory.writes()).toHaveLength(2);
          expect(memory.stored()).toMatchObject({
            pendingGrant: {
              candidate: { method: "granular", revision: 1 },
              transitionId: "transition-second",
            },
          });
        },
        { timeout: 1_000 },
      );
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirstBroadcast.resolve();
      await Promise.allSettled([first, second]);
    }
  });
});
