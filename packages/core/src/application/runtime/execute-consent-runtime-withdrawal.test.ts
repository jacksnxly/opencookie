import { expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../../index.js";
import {
  executeConsentRuntimeWithdrawal,
  toPersistedDecisionRecord,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../application.js";
import { recordConsentDecision, type ConsentReceipt } from "../../domain.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function stateRecord(value: PersistedConsentState): PersistedDecisionRecord {
  if (value.record === undefined) {
    throw new Error("Expected an active persisted consent record.");
  }
  return value.record;
}

function withdrawalRuntime() {
  const definition = definePolicy(
    completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
  );
  if (!definition.ok) throw new Error("Policy must be valid.");
  const policySnapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: definition.policy,
    policyVersion: "policy-1",
  });
  const resources = defineResourcePolicy({
    policy: definition.policy,
    resources: [],
    services: [],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");
  const recorded = recordConsentDecision(
    undefined,
    {
      catalogueDigest: policySnapshot.catalogueDigest,
      decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
      optionalPurposeIds: ["analytics"],
      policyVersion: policySnapshot.policyVersion,
    },
    {
      decidedAt: 1_000,
      expiresAt: 3_000,
      method: "accept-all",
      recordId: "record-1",
    },
  );
  if (!recorded.ok || recorded.outcome !== "changed") {
    throw new Error("Initial decision must be recorded.");
  }
  return {
    currentRecord: recorded.record,
    policySnapshot,
    resourcePolicy: resources.resourcePolicy,
  };
}

it("uses withdrawal time as receipt occurrence without replacing decision time", async () => {
  const definition = definePolicy(
    completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
  );
  if (!definition.ok) throw new Error("Policy must be valid.");
  const policySnapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: definition.policy,
    policyVersion: "policy-1",
  });
  const resources = defineResourcePolicy({
    policy: definition.policy,
    resources: [],
    services: [],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  const recorded = recordConsentDecision(
    undefined,
    {
      catalogueDigest: policySnapshot.catalogueDigest,
      decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
      optionalPurposeIds: ["analytics"],
      policyVersion: policySnapshot.policyVersion,
    },
    {
      decidedAt: 1_000,
      expiresAt: 3_000,
      method: "accept-all",
      recordId: "record-1",
    },
  );
  if (!recorded.ok || recorded.outcome !== "changed") {
    throw new Error("Initial decision must be recorded.");
  }

  let durable: PersistedDecisionRecord | null = toPersistedDecisionRecord(
    recorded.record,
  );
  let receipt: ConsentReceipt | undefined;
  const result = await executeConsentRuntimeWithdrawal(
    {
      broadcast: () => Promise.resolve(),
      commit: () => undefined,
      notify: () => undefined,
      receipt: (nextReceipt) => {
        receipt = nextReceipt;
        return Promise.resolve();
      },
      reconcile: () => Promise.resolve(),
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared" as const),
        compareAndSet: (_expected, candidate) => {
          durable = stateRecord(candidate);
          return Promise.resolve({ status: "written" as const });
        },
        read: () =>
          Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: state(durable), status: "stored" as const },
          ),
      },
    },
    {
      currentRecord: recorded.record,
      now: 2_000,
      policySnapshot,
      resourcePolicy: resources.resourcePolicy,
      transitionId: "transition-withdrawal",
    },
  );

  expect(result.outcome).toBe("committed");
  expect(receipt).toMatchObject({
    decidedAt: 1_000,
    method: "withdrawal",
    occurredAt: 2_000,
    schemaVersion: 2,
  });
});

it.each([
  ["unsafe withdrawal", {}, 2_000.5, "invalid-withdrawal-time", "withdrawnAt"],
  [
    "unsafe current decision",
    { decidedAt: 1_000.5 },
    2_000,
    "invalid-current-record",
    "current.decidedAt",
  ],
  [
    "unsafe current expiry",
    { expiresAt: 3_000.5 },
    2_000,
    "invalid-current-record",
    "current.expiresAt",
  ],
  [
    "non-positive current interval",
    { expiresAt: 1_000 },
    2_000,
    "invalid-current-record",
    "current.expiresAt",
  ],
  [
    "forged current method",
    { method: "forged" },
    2_000,
    "invalid-current-record",
    "current.method",
  ],
] as const)(
  "rejects an %s before any transition effect",
  async (_case, currentOverrides, now, code, path) => {
    const definition = definePolicy(
      completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
    );
    if (!definition.ok) throw new Error("Policy must be valid.");
    const policySnapshot = createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: definition.policy,
      policyVersion: "policy-1",
    });
    const resources = defineResourcePolicy({
      policy: definition.policy,
      resources: [],
      services: [],
    });
    if (!resources.ok) throw new Error("Resource policy must be valid.");
    const recorded = recordConsentDecision(
      undefined,
      {
        catalogueDigest: policySnapshot.catalogueDigest,
        decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
        optionalPurposeIds: ["analytics"],
        policyVersion: policySnapshot.policyVersion,
      },
      {
        decidedAt: 1_000,
        expiresAt: 3_000,
        method: "accept-all",
        recordId: "record-1",
      },
    );
    if (!recorded.ok || recorded.outcome !== "changed") {
      throw new Error("Initial decision must be recorded.");
    }
    const calls: string[] = [];

    const result = await executeConsentRuntimeWithdrawal(
      {
        broadcast: () => {
          calls.push("broadcast");
          return Promise.resolve();
        },
        commit: () => {
          calls.push("commit");
        },
        notify: () => {
          calls.push("notify");
        },
        receipt: () => {
          calls.push("receipt");
          return Promise.resolve();
        },
        reconcile: () => {
          calls.push("reconcile");
          return Promise.resolve();
        },
        store: {
          clear: () => {
            calls.push("clear");
            return Promise.resolve();
          },
          clearIfCurrent: () => {
            calls.push("clear-if-current");
            return Promise.resolve("cleared" as const);
          },
          compareAndSet: () => {
            calls.push("write");
            return Promise.resolve({ status: "written" as const });
          },
          read: () => {
            calls.push("read");
            return Promise.resolve({ status: "missing" as const });
          },
        },
      },
      {
        currentRecord: {
          ...recorded.record,
          ...currentOverrides,
        } as unknown as typeof recorded.record,
        now,
        policySnapshot,
        resourcePolicy: resources.resourcePolicy,
        transitionId: "transition-withdrawal-invalid",
      },
    );

    expect(result).toEqual({
      issues: [{ code, path }],
      outcome: "rejected",
    });
    expect(calls).toEqual([]);
  },
);

it("uses the detached current record through every withdrawal effect", async () => {
  const definition = definePolicy(
    completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
  );
  if (!definition.ok) throw new Error("Policy must be valid.");
  const policySnapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: definition.policy,
    policyVersion: "policy-1",
  });
  const resources = defineResourcePolicy({
    policy: definition.policy,
    resources: [],
    services: [],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");
  const recorded = recordConsentDecision(
    undefined,
    {
      catalogueDigest: policySnapshot.catalogueDigest,
      decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
      optionalPurposeIds: ["analytics"],
      policyVersion: policySnapshot.policyVersion,
    },
    {
      decidedAt: 1_000,
      expiresAt: 3_000,
      method: "accept-all",
      recordId: "record-1",
    },
  );
  if (!recorded.ok || recorded.outcome !== "changed") {
    throw new Error("Initial decision must be recorded.");
  }
  const decisions = recorded.record.decisions.map((decision) => ({
    ...decision,
  }));
  let mapCalls = 0;
  Object.defineProperty(decisions, "map", {
    value: () => {
      mapCalls += 1;
      return [...decisions];
    },
  });
  const currentRecord = { ...recorded.record, decisions };
  let durable: PersistedDecisionRecord | null = toPersistedDecisionRecord(
    recorded.record,
  );

  const result = await executeConsentRuntimeWithdrawal(
    {
      broadcast: () => Promise.resolve(),
      commit: () => undefined,
      notify: () => undefined,
      receipt: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared" as const),
        compareAndSet: (_expected, candidate) => {
          durable = stateRecord(candidate);
          return Promise.resolve({ status: "written" as const });
        },
        read: () =>
          Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: state(durable), status: "stored" as const },
          ),
      },
    },
    {
      currentRecord,
      now: 2_000,
      policySnapshot,
      resourcePolicy: resources.resourcePolicy,
      transitionId: "transition-detached-withdrawal",
    },
  );

  expect(result).toMatchObject({
    effect: {
      events: [{ type: "ConsentWithdrawn" }],
      record: {
        decisions: [{ purposeId: "analytics", value: "denied" }],
        method: "withdrawal",
      },
    },
    outcome: "committed",
  });
  expect(durable).toMatchObject({
    decisions: { analytics: "denied" },
    method: "withdrawal",
  });
  expect(mapCalls).toBe(0);
});

it("captures withdrawal runtime time once across every effect", async () => {
  const runtime = withdrawalRuntime();
  const calls: string[] = [];
  let durable: PersistedDecisionRecord | null = toPersistedDecisionRecord(
    runtime.currentRecord,
  );
  let receipt: ConsentReceipt | undefined;
  let nowReads = 0;
  const command = {
    ...runtime,
    now: 0,
    transitionId: "transition-captured-withdrawal-now",
  };
  Object.defineProperty(command, "now", {
    get: () => {
      nowReads += 1;
      if (nowReads === 1) return 2_000;
      throw new Error("withdrawal time was read twice");
    },
  });

  const result = await executeConsentRuntimeWithdrawal(
    {
      broadcast: () => {
        calls.push("broadcast");
        return Promise.resolve();
      },
      commit: () => {
        calls.push("commit");
      },
      notify: () => {
        calls.push("notify");
      },
      receipt: (nextReceipt) => {
        calls.push("receipt");
        receipt = nextReceipt;
        return Promise.resolve();
      },
      reconcile: () => {
        calls.push("reconcile");
        return Promise.resolve();
      },
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared" as const),
        compareAndSet: (_expected, candidate) => {
          calls.push("write");
          durable = stateRecord(candidate);
          return Promise.resolve({ status: "written" as const });
        },
        read: () =>
          Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: state(durable), status: "stored" as const },
          ),
      },
    },
    command,
  );

  expect(result.outcome).toBe("committed");
  expect(nowReads).toBe(1);
  expect(calls).toEqual([
    "commit",
    "broadcast",
    "reconcile",
    "write",
    "receipt",
    "notify",
  ]);
  expect(receipt).toMatchObject({ occurredAt: 2_000 });
});

it("rejects one unsafe captured withdrawal time before any effect", async () => {
  const runtime = withdrawalRuntime();
  const calls: string[] = [];
  let nowReads = 0;
  const command = {
    ...runtime,
    now: 0,
    transitionId: "transition-unsafe-withdrawal-now",
  };
  Object.defineProperty(command, "now", {
    get: () => {
      nowReads += 1;
      return nowReads === 1 ? Number.MAX_SAFE_INTEGER + 1 : 2_000;
    },
  });

  const result = await executeConsentRuntimeWithdrawal(
    {
      broadcast: () => {
        calls.push("broadcast");
        return Promise.resolve();
      },
      commit: () => {
        calls.push("commit");
      },
      notify: () => {
        calls.push("notify");
      },
      receipt: () => {
        calls.push("receipt");
        return Promise.resolve();
      },
      reconcile: () => {
        calls.push("reconcile");
        return Promise.resolve();
      },
      store: {
        clear: () => {
          calls.push("clear");
          return Promise.resolve();
        },
        clearIfCurrent: () => {
          calls.push("clear-if-current");
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: () => {
          calls.push("write");
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          calls.push("read");
          return Promise.resolve({ status: "missing" as const });
        },
      },
    },
    command,
  );

  expect(result).toEqual({
    issues: [{ code: "invalid-withdrawal-time", path: "withdrawnAt" }],
    outcome: "rejected",
  });
  expect(nowReads).toBe(1);
  expect(calls).toEqual([]);
});
