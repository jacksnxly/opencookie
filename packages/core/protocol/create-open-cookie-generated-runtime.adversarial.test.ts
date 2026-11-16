import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type DecisionStore,
  type PersistedConsentState,
} from "../src/index.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../src/domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../src/testing/policy-test-fixtures.test-helper.js";
import { persistedConsentStatesEqual } from "../src/application/runtime/persisted-consent-record.js";

function runtimePolicy(purposeIds: readonly string[]) {
  const catalogue = definePolicy(
    completeTestPolicyDefinition({
      purposes: purposeIds.map((id) => ({ id })),
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

describe("generated consent runtime adversarial interleavings", () => {
  it("commits activation state atomically with its durable activation write", async () => {
    const { policySnapshot, resourcePolicy } = runtimePolicy(["analytics"]);
    let durable: PersistedConsentState | null = null;
    let compareCount = 0;
    const writes: Array<{
      readonly candidate: string | null;
      readonly expected: string | null;
    }> = [];
    const activationEntered = deferred();
    const releaseActivation = deferred();
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (durable !== null && !statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: async (expected, candidate) => {
        compareCount += 1;
        writes.push({
          candidate:
            candidate.pendingGrant?.kind ?? candidate.record?.method ?? null,
          expected:
            expected?.pendingGrant?.kind ?? expected?.record?.method ?? null,
        });
        if (compareCount === 2) {
          activationEntered.resolve();
          await releaseActivation.promise;
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
    const ids = ["record-1", "transition-grant", "transition-withdraw"];
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected",
      now: () => now,
      policySnapshot,
      resourcePolicy,
      store,
    });
    await client.initialize();

    const grant = client.acceptAll();
    await activationEntered.promise;
    now = 2_000;
    const withdrawal = client.withdrawConsent();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    releaseActivation.resolve();

    const [grantResult, withdrawalResult] = await Promise.all([
      grant,
      withdrawal,
    ]);

    expect(grantResult.outcome).toBe("committed");
    expect(withdrawalResult.outcome).toBe("committed");
    expect(durable?.record?.method).toBe("withdrawal");
    expect(client.getSnapshot().record?.method).toBe("withdrawal");
    expect(client.getSnapshot().grantActivation).toBe("not-applicable");
    expect(writes).toEqual([
      { candidate: "decision", expected: null },
      { candidate: "accept-all", expected: "decision" },
      { candidate: "withdrawal", expected: "accept-all" },
    ]);
  });

  it("excludes a settled failed attempt from later terminal lineage", async () => {
    const { policySnapshot, resourcePolicy } = runtimePolicy([
      "analytics",
      "personalization",
    ]);
    let durable: PersistedConsentState | null = null;
    let failFirstWrite = true;
    let failedStage: PersistedConsentState | undefined;
    let phase = "A";
    let recordAllocations = 0;
    const clears: string[] = [];
    const writes: Array<{
      readonly expected: string | null;
      readonly phase: string;
      readonly recordId: string | undefined;
    }> = [];
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        clears.push(
          expected.pendingGrant?.transitionId ??
            expected.record?.method ??
            "empty",
        );
        if (durable !== null && !statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: async (expected, candidate) => {
        writes.push({
          expected:
            expected?.pendingGrant?.transitionId ??
            expected?.record?.method ??
            null,
          phase,
          recordId:
            candidate.pendingGrant?.candidate.recordId ??
            candidate.record?.recordId,
        });
        if (failFirstWrite) {
          failFirstWrite = false;
          failedStage = candidate;
          throw new Error("first write unavailable");
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
    const releaseB = deferred();
    const startedB = deferred();
    const transitions = [
      "transition-A",
      "transition-T1",
      "transition-B",
      "transition-T2",
    ];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.transitionId === "transition-B" &&
          effect.runtime.effectiveAccess.resources.some(
            (resource) => resource.access === "allowed",
          )
        ) {
          startedB.resolve();
          return releaseB.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => {
        if (kind === "record") {
          recordAllocations += 1;
          if (recordAllocations > 1) {
            throw new Error("A reserved attempt must retain its record ID.");
          }
          return "record-1";
        }
        return transitions.shift() ?? "unexpected-transition";
      },
      now: () => now,
      policySnapshot,
      resourcePolicy,
      store,
    });
    await client.initialize();

    await client.acceptAll();
    phase = "T1";
    now = 2_000;
    await client.rejectAll();
    phase = "B";
    now = 3_000;
    const b = client.acceptAll();
    await startedB.promise;
    if (failedStage === undefined) {
      throw new Error("Expected the failed staged state to be captured.");
    }
    durable = failedStage;
    phase = "T2";
    now = 4_000;
    const t2Promise = client.withdrawConsent();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    releaseB.resolve();
    await Promise.all([b, t2Promise]);

    const t2Writes = writes.filter((write) => write.phase === "T2");
    expect(recordAllocations).toBe(1);
    expect(
      writes
        .filter((write) => write.phase === "T1" || write.phase === "T2")
        .every((write) => write.recordId === "record-1"),
    ).toBe(true);
    expect(t2Writes.some((write) => write.expected === "transition-A")).toBe(
      false,
    );
    expect(clears).toContain("transition-A");
  });

  it.each(["rejectAll", "withdrawConsent"] as const)(
    "leaves %s final when retry already owns the state lane",
    async (terminalIntent) => {
      const { policySnapshot, resourcePolicy } = runtimePolicy(["analytics"]);
      let durable: PersistedConsentState | null = null;
      let failFirstWrite = true;
      let holdRetryRead = false;
      const retryReadEntered = deferred();
      const releaseRetryRead = deferred();
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (durable !== null && !statesEqual(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          if (failFirstWrite) {
            failFirstWrite = false;
            return Promise.reject(new Error("first write unavailable"));
          }
          if (!statesEqual(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        },
        read: async () => {
          if (holdRetryRead) {
            holdRetryRead = false;
            retryReadEntered.resolve();
            await releaseRetryRead.promise;
          }
          return durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const };
        },
      };
      const ids = [
        "record-retry-race",
        "transition-grant",
        "transition-terminal",
      ];
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected",
        now: () => now,
        policySnapshot,
        resourcePolicy,
        store,
      });
      await client.initialize();
      await expect(client.acceptAll()).resolves.toMatchObject({
        outcome: "pending",
        transition: { transitionId: "transition-grant" },
      });

      holdRetryRead = true;
      now = 2_000;
      const retry = client.retryPendingGrant();
      await retryReadEntered.promise;
      const terminalPromise =
        terminalIntent === "rejectAll"
          ? client.rejectAll()
          : client.withdrawConsent();
      await Promise.resolve();
      releaseRetryRead.resolve();
      const [retryResult, terminal] = await Promise.all([
        retry,
        terminalPromise,
      ]);

      expect(terminal.outcome).toBe("committed");
      expect(durable?.record?.method).toBe("reject-all");
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all" },
      });
      expect(client.getSnapshot().pendingGrant).toBeUndefined();
      expect(["invalidated", "not-applicable"]).toContain(retryResult.outcome);
    },
  );

  it.each(["rejectAll", "withdrawConsent"] as const)(
    "does not restage after %s already owns the state lane",
    async (terminalIntent) => {
      const { policySnapshot, resourcePolicy } = runtimePolicy(["analytics"]);
      let durable: PersistedConsentState | null = null;
      let failFirstWrite = true;
      let observeRetryRead = false;
      let retryReadCount = 0;
      const terminalWriteEntered = deferred();
      const releaseTerminalWrite = deferred();
      const releaseRetryRead = deferred();
      const terminalWritten = deferred();
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (durable !== null && !statesEqual(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: async (expected, candidate) => {
          if (failFirstWrite) {
            failFirstWrite = false;
            throw new Error("first write unavailable");
          }
          if (candidate.record?.method === "reject-all") {
            terminalWriteEntered.resolve();
            await releaseTerminalWrite.promise;
          }
          if (!statesEqual(durable, expected)) {
            return { status: "conflict" as const };
          }
          durable = candidate;
          if (candidate.record?.method === "reject-all") {
            terminalWritten.resolve();
          }
          return { status: "written" as const };
        },
        read: async () => {
          if (observeRetryRead) {
            retryReadCount += 1;
            await releaseRetryRead.promise;
          }
          return durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const };
        },
      };
      const ids = [
        "record-retry-race",
        "transition-grant",
        "transition-terminal",
      ];
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected",
        now: () => now,
        policySnapshot,
        resourcePolicy,
        store,
      });
      await client.initialize();
      await expect(client.acceptAll()).resolves.toMatchObject({
        outcome: "pending",
        transition: { transitionId: "transition-grant" },
      });

      now = 2_000;
      const terminalPromise =
        terminalIntent === "rejectAll"
          ? client.rejectAll()
          : client.withdrawConsent();
      await terminalWriteEntered.promise;
      observeRetryRead = true;
      const retry = client.retryPendingGrant();
      releaseTerminalWrite.resolve();
      await terminalWritten.promise;
      releaseRetryRead.resolve();
      const [retryResult, terminal] = await Promise.all([
        retry,
        terminalPromise,
      ]);

      expect(terminal.outcome).toBe("committed");
      expect(durable?.record?.method).toBe("reject-all");
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all" },
      });
      expect(client.getSnapshot().pendingGrant).toBeUndefined();
      expect(["invalidated", "not-applicable"]).toContain(retryResult.outcome);
      expect(retryReadCount).toBe(0);
    },
  );
});
