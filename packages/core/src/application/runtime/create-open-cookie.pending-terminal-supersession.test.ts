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

type PersistedActiveDecisionRecord = Extract<
  PersistedDecisionRecord,
  { readonly withdrawnAt?: never }
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

function grantRecord(): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "granted" },
    expiresAt: 86_401_000,
    method: "accept-all",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-1",
    revision: 1,
  };
}

function withdrawalRecord(): PersistedDecisionRecord {
  return {
    ...grantRecord(),
    decisions: { analytics: "denied", personalization: "denied" },
    method: "withdrawal",
    revision: 2,
    withdrawnAt: 1_500,
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

interface StoreWrite {
  readonly candidate: PersistedConsentState;
  readonly expected: PersistedConsentState | null;
}

function exactStateStore(initial: PersistedConsentState | null = null): {
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
  readonly writes: () => readonly StoreWrite[];
} {
  let durable = initial;
  const writes: StoreWrite[] = [];
  return {
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (durable === null) return Promise.resolve("cleared" as const);
        if (!statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        writes.push({ candidate, expected });
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

function firstWriteFailsStore(initial: PersistedConsentState | null = null): {
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  const memory = exactStateStore(initial);
  let first = true;
  return {
    store: {
      ...memory.store,
      compareAndSet: (expected, candidate) => {
        if (first) {
          first = false;
          return Promise.reject(new Error("first write unavailable"));
        }
        return memory.store.compareAndSet(expected, candidate);
      },
    },
    stored: memory.stored,
  };
}

function accessOf(
  effect: ConsentRuntimeTransitionEffect,
): "allowed" | "blocked" {
  const resource = effect.runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

describe("createOpenCookie pending terminal supersession", () => {
  it("cancels a broader pending choice before returning the completed narrower choice unchanged", async () => {
    const completed: PersistedActiveDecisionRecord = {
      ...grantRecord(),
      decisions: { analytics: "granted", personalization: "denied" },
      method: "granular" as const,
    };
    const memory = exactStateStore({ record: completed });
    let failGrantWrite = false;
    const receipt = vi.fn(() => Promise.resolve());
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      receipt,
      ...runtimePolicy(),
      store: {
        ...memory.store,
        compareAndSet: (expected, candidate) =>
          failGrantWrite && candidate.pendingGrant?.kind === "decision"
            ? Promise.reject(new Error("grant storage unavailable"))
            : memory.store.compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    failGrantWrite = true;

    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "pending",
      transition: { record: { method: "accept-all", revision: 2 } },
    });
    expect(client.getSnapshot()).toMatchObject({
      pendingGrant: { grantedPurposeIds: ["analytics", "personalization"] },
    });
    failGrantWrite = false;

    await expect(client.savePreferences(["analytics"])).resolves.toMatchObject({
      outcome: "unchanged",
      record: { method: "granular", recordId: completed.recordId, revision: 1 },
    });
    expect(memory.stored()).toEqual({ record: completed });
    expect(client.getSnapshot()).not.toHaveProperty("pendingGrant");
    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "not-applicable",
    });
    expect(receipt).not.toHaveBeenCalled();
  });

  it("never reconciles an older cancellation after a newer rejection", async () => {
    const completed: PersistedActiveDecisionRecord = {
      ...grantRecord(),
      decisions: { analytics: "granted", personalization: "denied" },
      method: "granular" as const,
    };
    const memory = exactStateStore({ record: completed });
    const cancellationStarted = deferred();
    const releaseCancellation = deferred();
    const order: string[] = [];
    let enforced: "allowed" | "blocked" = "blocked";
    let failGrantWrite = false;
    let holdCancellation = false;
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: async (effect) => {
        if (
          holdCancellation &&
          effect.record.method === "granular" &&
          accessOf(effect) === "allowed"
        ) {
          order.push("cancellation broadcast allowed");
          enforced = accessOf(effect);
          cancellationStarted.resolve();
          await releaseCancellation.promise;
          enforced = accessOf(effect);
          return;
        }
        if (effect.record.method === "reject-all") {
          order.push("rejection broadcast blocked");
        }
        enforced = accessOf(effect);
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect) => {
        enforced = accessOf(effect);
        order.push(
          effect.record.method === "reject-all"
            ? "rejection reconcile blocked"
            : "cancellation reconcile allowed",
        );
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: {
        ...memory.store,
        compareAndSet: (expected, candidate) =>
          failGrantWrite && candidate.pendingGrant?.kind === "decision"
            ? Promise.reject(new Error("grant storage unavailable"))
            : memory.store.compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    failGrantWrite = true;
    now = 2_000;
    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "pending",
    });
    failGrantWrite = false;
    order.length = 0;
    holdCancellation = true;
    now = 3_000;

    const cancellation = client.savePreferences(["analytics"]);
    await cancellationStarted.promise;
    now = 4_000;
    let rejectionSettled = false;
    const rejection = client.rejectAll().then((result) => {
      rejectionSettled = true;
      return result;
    });
    try {
      await vi.waitFor(
        () => {
          expect(rejectionSettled).toBe(true);
          expect(enforced).toBe("blocked");
          expect(memory.stored()).toMatchObject({
            record: { method: "reject-all", revision: 2 },
          });
          expect(client.getSnapshot()).toMatchObject({
            grantActivation: "not-applicable",
            record: { method: "reject-all", revision: 2 },
          });
        },
        { timeout: 500 },
      );
    } finally {
      releaseCancellation.resolve();
    }
    await expect(cancellation).resolves.toMatchObject({ outcome: "unchanged" });
    await expect(rejection).resolves.toMatchObject({ outcome: "committed" });

    expect(enforced).toBe("blocked");
    expect(order.at(-1)).toBe("rejection reconcile blocked");
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all", revision: 2 },
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "not-applicable",
      record: { method: "reject-all", revision: 2 },
    });
  });

  it("blocks a pending grant before terminal persistence settles", async () => {
    const completed: PersistedActiveDecisionRecord = {
      ...grantRecord(),
      decisions: { analytics: "granted", personalization: "denied" },
      method: "granular" as const,
    };
    const memory = exactStateStore({ record: completed });
    const terminalWriteStarted = deferred();
    const releaseTerminalWrite = deferred();
    let failGrantWrite = false;
    let holdTerminalWrite = false;
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...runtimePolicy(),
      store: {
        ...memory.store,
        compareAndSet: async (expected, candidate) => {
          if (failGrantWrite && candidate.pendingGrant?.kind === "decision") {
            throw new Error("grant storage unavailable");
          }
          if (
            holdTerminalWrite &&
            candidate.pendingGrant === undefined &&
            candidate.record?.method === "reject-all"
          ) {
            terminalWriteStarted.resolve();
            await releaseTerminalWrite.promise;
          }
          return memory.store.compareAndSet(expected, candidate);
        },
      },
    });
    await client.initialize();
    failGrantWrite = true;
    now = 2_000;
    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "pending",
    });
    expect(client.getSnapshot().runtime.effectiveAccess.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          access: "allowed",
          resourceId: "analytics-script",
        }),
      ]),
    );

    failGrantWrite = false;
    holdTerminalWrite = true;
    now = 3_000;
    const rejection = client.rejectAll();
    await terminalWriteStarted.promise;
    try {
      expect(client.getSnapshot().runtime.effectiveAccess.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            access: "blocked",
            resourceId: "analytics-script",
          }),
        ]),
      );
    } finally {
      releaseTerminalWrite.resolve();
    }

    await expect(rejection).resolves.toMatchObject({ outcome: "committed" });
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all", revision: 2 },
    });
  });

  it("cancels a pending replacement when the active record is already withdrawn", async () => {
    const withdrawn = withdrawalRecord();
    const memory = exactStateStore({ record: withdrawn });
    const replacementStarted = deferred();
    const releaseReplacement = deferred();
    const order: string[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    const ids = ["transition-replacement", "transition-cancel"];
    let now = 2_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.transitionId === "transition-replacement" &&
          accessOf(effect) === "allowed"
        ) {
          order.push("replacement intended");
          replacementStarted.resolve();
          return releaseReplacement.promise;
        }
        order.push(
          effect.transitionId === "transition-replacement"
            ? "replacement correction"
            : "cancellation signal",
        );
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      receipt,
      reconcile: (effect) => {
        order.push(
          effect.transitionId === "transition-replacement"
            ? "replacement reconcile"
            : "cancellation reconcile",
        );
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const replacement = client.acceptAll();
    await replacementStarted.promise;
    now = 3_000;
    const cancellation = client.withdrawConsent();

    try {
      await vi.waitFor(() => {
        expect(memory.stored()).toEqual({ record: withdrawn });
        expect(client.getSnapshot()).toMatchObject({
          grantActivation: "not-applicable",
          record: { method: "withdrawal", revision: 2 },
        });
      });
      expect(order[0]).toBe("replacement intended");
      expect(order).toContain("cancellation signal");
      expect(order).toContain("cancellation reconcile");
    } finally {
      releaseReplacement.resolve();
    }

    await expect(replacement).resolves.toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      outcome: "invalidated",
    });
    await expect(cancellation).resolves.toMatchObject({
      effect: { events: [], record: { method: "withdrawal", revision: 2 } },
      outcome: "committed",
    });
    expect(order.filter((entry) => entry === "replacement intended")).toEqual([
      "replacement intended",
    ]);
    expect(
      order
        .filter(
          (entry) => !entry.includes("reconcile") && !entry.includes("receipt"),
        )
        .at(-1),
    ).toBe("cancellation signal");
    expect(order.filter((entry) => entry.includes("reconcile")).at(-1)).toBe(
      "cancellation reconcile",
    );
    expect(receipt).not.toHaveBeenCalled();
  });

  it.each([
    ["reject", "successful", undefined, undefined],
    ["withdraw", "successful", undefined, undefined],
    [
      "reject",
      "undefined broadcast",
      "broadcast",
      "denial-signal-broadcast-failed",
    ],
    ["reject", "undefined reconcile", "reconcile", "denial-reconcile-failed"],
  ] as const)(
    "conservatively %ss a persistence-pending first grant with %s reservation signals",
    async (action, _signalCase, failingPort, diagnostic) => {
      const memory = firstWriteFailsStore();
      let broadcastCalls = 0;
      const broadcast = vi.fn((effect: ConsentRuntimeTransitionEffect) => {
        void effect;
        broadcastCalls += 1;
        if (failingPort === "broadcast" && broadcastCalls === 2) {
          // This regression deliberately exercises a rejection without a reason.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject();
        }
        return Promise.resolve();
      });
      let reconcileCalls = 0;
      const reconcile = vi.fn((effect: ConsentRuntimeTransitionEffect) => {
        void effect;
        reconcileCalls += 1;
        if (failingPort === "reconcile" && reconcileCalls === 2) {
          // This regression deliberately exercises a rejection without a reason.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject();
        }
        return Promise.resolve();
      });
      const ids = ["record-1", "transition-grant", "transition-cancel"];
      let now = 1_000;
      const client = createOpenCookie({
        broadcast,
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected-id",
        now: () => now,
        reconcile,
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();

      await expect(client.acceptAll()).resolves.toMatchObject({
        diagnostics: [{ code: "grant-write-failed" }],
        outcome: "pending",
      });
      expect(client.getSnapshot()).toMatchObject({
        pendingGrant: { phase: "persistence" },
      });

      now = 2_000;
      const cancellation =
        action === "reject" ? client.rejectAll() : client.withdrawConsent();
      await expect(cancellation).resolves.toMatchObject({
        ...(diagnostic === undefined
          ? { outcome: "committed" }
          : { diagnostics: [{ code: diagnostic }], outcome: "degraded" }),
        effect: { record: { method: "reject-all", revision: 1 } },
      });
      expect(memory.stored()).toMatchObject({
        record: { method: "reject-all", revision: 1 },
      });
      expect(memory.stored()).not.toHaveProperty("pendingGrant");
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all", revision: 1 },
      });
      for (const signal of [broadcast, reconcile]) {
        expect(signal).toHaveBeenCalledTimes(3);
        const firstSignal = signal.mock.calls[0]?.[0];
        const reservationSignal = signal.mock.calls[1]?.[0];
        const terminalSignal = signal.mock.calls[2]?.[0];
        if (
          firstSignal === undefined ||
          reservationSignal === undefined ||
          terminalSignal === undefined
        ) {
          throw new Error(
            "Expected correction, reservation, and cancellation signals.",
          );
        }
        expect(accessOf(firstSignal)).toBe("blocked");
        expect(accessOf(reservationSignal)).toBe("blocked");
        expect(reservationSignal.transitionId).toBe("transition-grant");
        expect(terminalSignal.record.method).toBe("reject-all");
      }
    },
  );

  it("durably supersedes a pending grant with reject-all before terminal signals", async () => {
    const memory = exactStateStore();
    const grantStarted = deferred();
    const releaseGrant = deferred();
    const order: string[] = [];
    const receipts: string[] = [];
    const ids = ["record-1", "transition-grant", "transition-reject"];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.transitionId === "transition-grant" &&
          accessOf(effect) === "allowed"
        ) {
          order.push("grant intended");
          grantStarted.resolve();
          return releaseGrant.promise;
        }
        order.push(
          effect.transitionId === "transition-grant"
            ? "grant correction"
            : "reject signal",
        );
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      receipt: (receipt) => {
        receipts.push(receipt.method);
        order.push("reject receipt");
        return Promise.resolve();
      },
      reconcile: (effect) => {
        order.push(
          effect.transitionId === "transition-grant"
            ? "grant reconcile"
            : "reject reconcile",
        );
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const grant = client.acceptAll();
    await grantStarted.promise;
    now = 2_000;
    const rejection = client.rejectAll();

    try {
      await vi.waitFor(
        () => {
          expect(memory.stored()).toMatchObject({
            record: { method: "reject-all", revision: 1 },
          });
        },
        { timeout: 1_000 },
      );
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all", revision: 1 },
      });
      expect(memory.stored()).not.toHaveProperty("pendingGrant");
      const supersedingWrite = memory.writes().at(-1);
      expect(supersedingWrite).toMatchObject({
        candidate: { record: { method: "reject-all", revision: 1 } },
        expected: {
          pendingGrant: { transitionId: "transition-grant" },
        },
      });
      expect(order[0]).toBe("grant intended");
      expect(order).toContain("reject signal");
      expect(order).toContain("reject reconcile");
      expect(order.filter((entry) => entry === "reject receipt")).toEqual([
        "reject receipt",
      ]);
    } finally {
      releaseGrant.resolve();
    }

    await expect(grant).resolves.toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      outcome: "invalidated",
    });
    await expect(rejection).resolves.toMatchObject({ outcome: "committed" });
    expect(order.filter((entry) => entry === "grant intended")).toEqual([
      "grant intended",
    ]);
    expect(
      order
        .filter(
          (entry) => !entry.includes("reconcile") && !entry.includes("receipt"),
        )
        .at(-1),
    ).toBe("reject signal");
    expect(order.filter((entry) => entry.includes("reconcile")).at(-1)).toBe(
      "reject reconcile",
    );
    expect(order.filter((entry) => entry === "reject receipt")).toEqual([
      "reject receipt",
    ]);
    expect(receipts).toEqual(["reject-all"]);
  });

  it("withdraws the active record while superseding its pending replacement", async () => {
    const memory = exactStateStore({ record: grantRecord() });
    const replacementStarted = deferred();
    const releaseReplacement = deferred();
    const order: string[] = [];
    const receipts: string[] = [];
    const ids = [
      "transition-restore",
      "transition-replacement",
      "transition-withdrawal",
    ];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.transitionId === "transition-replacement" &&
          accessOf(effect) === "allowed"
        ) {
          order.push("replacement intended");
          replacementStarted.resolve();
          return releaseReplacement.promise;
        }
        order.push(
          effect.transitionId === "transition-replacement"
            ? "replacement correction"
            : effect.transitionId === "transition-withdrawal"
              ? "withdrawal signal"
              : "restore signal",
        );
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      receipt: (receipt) => {
        receipts.push(receipt.method);
        order.push("withdrawal receipt");
        return Promise.resolve();
      },
      reconcile: (effect) => {
        order.push(
          effect.transitionId === "transition-replacement"
            ? "replacement reconcile"
            : effect.transitionId === "transition-withdrawal"
              ? "withdrawal reconcile"
              : "restore reconcile",
        );
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    order.length = 0;

    now = 2_000;
    const replacement = client.savePreferences(["analytics"]);
    await replacementStarted.promise;
    now = 3_000;
    const withdrawal = client.withdrawConsent();

    try {
      await vi.waitFor(
        () => {
          expect(memory.stored()).toMatchObject({
            record: {
              method: "withdrawal",
              revision: 2,
              withdrawnAt: 3_000,
            },
          });
        },
        { timeout: 1_000 },
      );
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "withdrawal", revision: 2 },
      });
      expect(memory.stored()).not.toHaveProperty("pendingGrant");
      expect(order[0]).toBe("replacement intended");
      expect(order).toContain("withdrawal signal");
      expect(order).toContain("withdrawal reconcile");
      expect(order.filter((entry) => entry === "withdrawal receipt")).toEqual([
        "withdrawal receipt",
      ]);
    } finally {
      releaseReplacement.resolve();
    }

    await expect(replacement).resolves.toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      outcome: "invalidated",
    });
    await expect(withdrawal).resolves.toMatchObject({ outcome: "committed" });
    expect(memory.stored()).toMatchObject({
      record: { method: "withdrawal", revision: 2, withdrawnAt: 3_000 },
    });
    expect(order.filter((entry) => entry === "replacement intended")).toEqual([
      "replacement intended",
    ]);
    expect(
      order
        .filter(
          (entry) => !entry.includes("reconcile") && !entry.includes("receipt"),
        )
        .at(-1),
    ).toBe("withdrawal signal");
    expect(order.filter((entry) => entry.includes("reconcile")).at(-1)).toBe(
      "withdrawal reconcile",
    );
    expect(order.filter((entry) => entry === "withdrawal receipt")).toEqual([
      "withdrawal receipt",
    ]);
    expect(receipts).toEqual(["withdrawal"]);
  });

  it("cancels a first pending grant as a denial without inventing withdrawal", async () => {
    const memory = exactStateStore();
    const grantStarted = deferred();
    const releaseGrant = deferred();
    const receipts: string[] = [];
    const ids = ["record-1", "transition-grant", "transition-cancel"];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.transitionId === "transition-grant" &&
          accessOf(effect) === "allowed"
        ) {
          grantStarted.resolve();
          return releaseGrant.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      receipt: (receipt) => {
        receipts.push(receipt.method);
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const grant = client.acceptAll();
    await grantStarted.promise;
    now = 2_000;
    const cancellation = client.withdrawConsent();

    try {
      await vi.waitFor(
        () => {
          expect(memory.stored()).toMatchObject({
            record: { method: "reject-all", revision: 1 },
          });
        },
        { timeout: 1_000 },
      );
      expect(memory.stored()).not.toHaveProperty("pendingGrant");
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all", revision: 1 },
      });
      expect(client.getSnapshot().record?.method).not.toBe("withdrawal");
    } finally {
      releaseGrant.resolve();
    }

    await expect(grant).resolves.toMatchObject({ outcome: "invalidated" });
    await expect(cancellation).resolves.toMatchObject({
      effect: { record: { method: "reject-all" } },
      outcome: "committed",
    });
    expect(receipts).toEqual(["reject-all"]);
  });

  it("finalizes and notifies a denial when receipt delivery fails", async () => {
    const memory = exactStateStore();
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-denial-receipt`,
      now: () => 1_000,
      receipt: () => Promise.reject(new Error("receipt unavailable")),
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const snapshots: Array<ReturnType<typeof client.getSnapshot>> = [];
    client.subscribe(() => {
      snapshots.push(client.getSnapshot());
    });

    await expect(client.rejectAll()).resolves.toMatchObject({
      diagnostics: [{ code: "denial-receipt-failed" }],
      outcome: "degraded",
      transition: { persistenceStatus: "confirmed" },
    });
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all", revision: 1 },
    });
    expect(client.getSnapshot()).toMatchObject({
      record: { method: "reject-all", revision: 1 },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      lastPersistenceStatus: "pending",
      record: { method: "reject-all", revision: 1 },
    });
    expect(snapshots[1]).toMatchObject({
      lastPersistenceStatus: "confirmed",
      record: { method: "reject-all", revision: 1 },
    });
  });

  it("finalizes and notifies a withdrawal when receipt delivery fails", async () => {
    const memory = exactStateStore({ record: grantRecord() });
    let failReceipt = false;
    let now = 1_000;
    const ids = ["transition-restore", "transition-withdrawal"];
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      receipt: () =>
        failReceipt
          ? Promise.reject(new Error("receipt unavailable"))
          : Promise.resolve(),
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const snapshots: Array<ReturnType<typeof client.getSnapshot>> = [];
    client.subscribe(() => {
      snapshots.push(client.getSnapshot());
    });
    failReceipt = true;
    now = 2_000;

    await expect(client.withdrawConsent()).resolves.toMatchObject({
      diagnostics: [{ code: "denial-receipt-failed" }],
      outcome: "degraded",
      transition: { persistenceStatus: "confirmed" },
    });
    expect(memory.stored()).toMatchObject({
      record: { method: "withdrawal", revision: 2, withdrawnAt: 2_000 },
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "not-applicable",
      record: { method: "withdrawal", revision: 2 },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      lastPersistenceStatus: "pending",
      record: { method: "withdrawal", revision: 2 },
    });
    expect(snapshots[1]).toMatchObject({
      lastPersistenceStatus: "confirmed",
      record: { method: "withdrawal", revision: 2 },
    });
  });
});
