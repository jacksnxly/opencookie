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
    expiresAt: 86_401_000,
    method: "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-shared",
    revision: 1,
  };
}

function competingGrant(
  completed: PersistedActiveDecisionRecord,
): PersistedActiveDecisionRecord {
  return Object.freeze({
    ...completed,
    decidedAt: 2_000,
    decisions: Object.freeze({
      analytics: "granted" as const,
      personalization: "granted" as const,
    }),
    expiresAt: 86_402_000,
    method: "accept-all" as const,
    revision: 2,
  });
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
  timeoutMs = 1_000,
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

function accessOf(client: ReturnType<typeof createOpenCookie>) {
  const resource = client
    .getSnapshot()
    .runtime.effectiveAccess.resources.find(
      ({ resourceId }) => resourceId === "analytics-script",
    );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

function effectAccess(effect: ConsentRuntimeTransitionEffect) {
  const resource = effect.runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

interface ExactStoreOptions {
  readonly beforeCompare?: (
    expected: PersistedConsentState | null,
    candidate: PersistedConsentState,
  ) => Promise<void> | void;
}

function exactStore(
  initial: PersistedConsentState,
  options: ExactStoreOptions = {},
): {
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  let durable: PersistedConsentState | null = initial;
  return {
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
        await options.beforeCompare?.(expected, candidate);
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
    },
    stored: () => durable,
  };
}

function isTerminalState(state: PersistedConsentState): boolean {
  return (
    state.pendingGrant === undefined &&
    (state.record?.method === "reject-all" ||
      state.record?.method === "withdrawal")
  );
}

describe("createOpenCookie terminal storage authority", () => {
  it("rebases a later rejection after an older terminal CAS loses to an activated grant", async () => {
    const completed = completedAnalyticsRecord();
    const activated = competingGrant(completed);
    const firstTerminalStarted = deferred();
    const releaseFirstTerminal = deferred();
    let holdFirstTerminal = true;
    const memory = exactStore(
      { record: completed },
      {
        beforeCompare: async (_expected, candidate) => {
          if (holdFirstTerminal && isTerminalState(candidate)) {
            holdFirstTerminal = false;
            firstTerminalStarted.resolve();
            await releaseFirstTerminal.promise;
          }
        },
      },
    );
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await within(client.initialize(), "initialization");
    now = 3_000;

    const firstTerminal = client.rejectAll();
    await within(firstTerminalStarted.promise, "first terminal CAS");
    expect(accessOf(client)).toBe("blocked");

    const stagedGrant: PersistedConsentState = Object.freeze({
      pendingGrant: Object.freeze({
        candidate: activated,
        kind: "decision" as const,
        receiptOccurredAt: 2_000,
        transitionId: "transition-competing-grant",
      }),
      record: completed,
    });
    await expect(
      memory.store.compareAndSet({ record: completed }, stagedGrant),
    ).resolves.toEqual({ status: "written" });
    await expect(
      memory.store.compareAndSet(stagedGrant, { record: activated }),
    ).resolves.toEqual({ status: "written" });

    releaseFirstTerminal.resolve();
    await expect(
      within(firstTerminal, "conflicted first terminal"),
    ).resolves.toMatchObject({
      diagnostics: [
        { code: "denial-persistence-conflict" },
        { code: "denial-clear-failed" },
      ],
      outcome: "degraded",
    });
    expect(memory.stored()).toEqual({ record: activated });

    now = 4_000;
    await expect(
      within(client.rejectAll(), "rebased terminal"),
    ).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        record: {
          method: "reject-all",
          recordId: activated.recordId,
          revision: 3,
        },
      },
    });
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all", revision: 3 },
    });
    expect(accessOf(client)).toBe("blocked");

    const reloaded = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-reload`,
      now: () => 5_000,
      ...runtimePolicy(),
      store: memory.store,
    });
    await within(reloaded.initialize(), "reload");
    expect(accessOf(reloaded)).toBe("blocked");
    expect(reloaded.getSnapshot()).toMatchObject({
      record: { method: "reject-all", revision: 3 },
    });
  });

  it("preserves a grant intent queued behind a parked rejection", async () => {
    const completed = completedAnalyticsRecord();
    const firstTerminalStarted = deferred();
    const releaseFirstTerminal = deferred();
    let holdFirstTerminal = true;
    const memory = exactStore(
      { record: completed },
      {
        beforeCompare: async (_expected, candidate) => {
          if (holdFirstTerminal && isTerminalState(candidate)) {
            holdFirstTerminal = false;
            firstTerminalStarted.resolve();
            await releaseFirstTerminal.promise;
          }
        },
      },
    );
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await within(client.initialize(), "initialization");
    now = 2_000;

    const rejection = client.rejectAll();
    await within(firstTerminalStarted.promise, "parked rejection CAS");
    expect(accessOf(client)).toBe("blocked");

    now = 3_000;
    let laterSettled = false;
    const laterGrant = client.savePreferences(["analytics"]).then((result) => {
      laterSettled = true;
      return result;
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(laterSettled).toBe(false);
    expect(accessOf(client)).toBe("blocked");

    releaseFirstTerminal.resolve();
    const [rejectionResult, grantResult] = await within(
      Promise.all([rejection, laterGrant]),
      "terminal followed by grant",
    );
    expect(rejectionResult).toMatchObject({ outcome: "committed" });
    expect(grantResult).toMatchObject({
      outcome: "committed",
      transition: {
        record: {
          decisions: { analytics: "granted", personalization: "denied" },
          method: "granular",
          revision: 3,
        },
      },
    });
    expect(grantResult.outcome).not.toBe("unchanged");
    expect(memory.stored()).toMatchObject({
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
    expect(accessOf(client)).toBe("allowed");
  });

  it.each(["reject", "withdraw"] as const)(
    "lets %s overtake a grant stage parked before its atomic write",
    async (action) => {
      const completed = completedAnalyticsRecord();
      const grantStageStarted = deferred();
      const releaseGrantStage = deferred();
      const terminalWriteStarted = deferred();
      let holdGrantStage = true;
      const memory = exactStore(
        { record: completed },
        {
          beforeCompare: async (_expected, candidate) => {
            if (
              holdGrantStage &&
              candidate.pendingGrant?.kind === "decision" &&
              candidate.pendingGrant.candidate.method === "accept-all"
            ) {
              holdGrantStage = false;
              grantStageStarted.resolve();
              await releaseGrantStage.promise;
              return;
            }
            if (isTerminalState(candidate)) terminalWriteStarted.resolve();
          },
        },
      );
      let generated = 0;
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => now,
        ...runtimePolicy(),
        store: memory.store,
      });
      await within(client.initialize(), "initialization");
      now = 2_000;

      const grant = client.acceptAll();
      await within(grantStageStarted.promise, "parked grant stage");
      now = 3_000;
      const terminal =
        action === "reject" ? client.rejectAll() : client.withdrawConsent();

      try {
        await vi.waitFor(
          () => {
            expect(accessOf(client)).toBe("blocked");
          },
          { timeout: 300 },
        );
        await within(
          terminalWriteStarted.promise,
          "terminal progress before grant release",
          300,
        );
      } finally {
        releaseGrantStage.resolve();
        await Promise.allSettled([grant, terminal]);
      }
    },
  );

  it("does not let an older reconcile repair restore access after a newer grant is blocked", async () => {
    const completed = completedAnalyticsRecord();
    const memory = exactStore({ record: completed });
    const cancellationReconcileStarted = deferred();
    const releaseCancellationReconcile = deferred();
    const newerGrantBroadcastStarted = deferred();
    const releaseNewerGrantBroadcast = deferred();
    const staleRepairStarted = deferred();
    const releaseStaleRepair = deferred();
    let failBroaderGrantStage = false;
    let holdCancellationReconcile = false;
    let holdNewerGrantBroadcast = false;
    let enforced: "allowed" | "blocked" = "blocked";
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: async (effect) => {
        enforced = effectAccess(effect);
        if (
          holdNewerGrantBroadcast &&
          effect.record.method === "accept-all" &&
          effectAccess(effect) === "allowed"
        ) {
          holdNewerGrantBroadcast = false;
          newerGrantBroadcastStarted.resolve();
          await releaseNewerGrantBroadcast.promise;
          enforced = "allowed";
        }
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: async (effect) => {
        enforced = effectAccess(effect);
        if (!holdCancellationReconcile) return;
        if (
          effect.record.method === "granular" &&
          effectAccess(effect) === "allowed"
        ) {
          cancellationReconcileStarted.resolve();
          await releaseCancellationReconcile.promise;
          return;
        }
        if (
          effect.record.method === "accept-all" &&
          effectAccess(effect) === "allowed"
        ) {
          holdCancellationReconcile = false;
          staleRepairStarted.resolve();
          await releaseStaleRepair.promise;
          enforced = "allowed";
        }
      },
      ...runtimePolicy(),
      store: {
        ...memory.store,
        compareAndSet: (expected, candidate) => {
          if (
            failBroaderGrantStage &&
            candidate.pendingGrant?.kind === "decision" &&
            candidate.pendingGrant.candidate.method === "accept-all"
          ) {
            failBroaderGrantStage = false;
            return Promise.reject(new Error("grant storage unavailable"));
          }
          return memory.store.compareAndSet(expected, candidate);
        },
      },
    });
    await within(client.initialize(), "initialization");
    now = 1_100;
    failBroaderGrantStage = true;
    await expect(
      within(client.acceptAll(), "failed broader grant"),
    ).resolves.toMatchObject({ outcome: "pending" });
    expect(accessOf(client)).toBe("allowed");

    holdCancellationReconcile = true;
    now = 1_200;
    const cancellation = client.savePreferences(["analytics"]);
    let newerGrant: ReturnType<typeof client.acceptAll> | undefined;
    try {
      await within(
        cancellationReconcileStarted.promise,
        "same-choice cancellation reconcile",
      );

      holdNewerGrantBroadcast = true;
      now = 1_300;
      newerGrant = client.acceptAll();
      await within(
        newerGrantBroadcastStarted.promise,
        "newer intended grant broadcast",
      );
      releaseCancellationReconcile.resolve();
      await within(staleRepairStarted.promise, "stale allowed repair");

      now = 2_301;
      releaseNewerGrantBroadcast.resolve();
      const newerResult = await within(newerGrant, "expired newer grant");
      expect(newerResult).toMatchObject({
        diagnostics: [{ code: "grant-expired-before-activation" }],
        outcome: "invalidated",
      });
      expect(accessOf(client)).toBe("blocked");
      expect(enforced).toBe("blocked");

      releaseStaleRepair.resolve();
      await within(cancellation, "stale cancellation repair completion");

      expect(accessOf(client)).toBe("blocked");
      expect(enforced).toBe("blocked");
    } finally {
      releaseCancellationReconcile.resolve();
      releaseNewerGrantBroadcast.resolve();
      releaseStaleRepair.resolve();
      await Promise.allSettled(
        newerGrant === undefined ? [cancellation] : [cancellation, newerGrant],
      );
    }
  });
});
