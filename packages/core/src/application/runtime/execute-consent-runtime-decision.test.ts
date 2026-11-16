import { expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../../index.js";
import {
  executeConsentRuntimeDecision,
  toConsentRecord,
  type ConsentRuntimeTransitionEffect,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../application.js";
import type { ConsentReceipt } from "../../domain.js";
import {
  createAccessEnforcementReconciler,
  projectAccessEnforcementDecisions,
  projectGoogleConsentModeState,
} from "../../infrastructure.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";

function receiptRuntime(purposeIds: readonly string[] = ["analytics"]) {
  const definition = definePolicy(
    completeTestPolicyDefinition({
      purposes: purposeIds.map((id) => ({ id })),
    }),
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
  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function failedRetryRecord(
  mode: "denial" | "narrowing-grant",
  policySnapshot: ReturnType<typeof receiptRuntime>["policySnapshot"],
): PersistedDecisionRecord {
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 2_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions:
      mode === "denial"
        ? { analytics: "denied", personalization: "denied" }
        : { analytics: "granted", personalization: "denied" },
    expiresAt: 10_000,
    method: mode === "denial" ? "reject-all" : "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-1",
    revision: 2,
  };
}

function retryDecision(mode: "denial" | "narrowing-grant") {
  return mode === "denial"
    ? ({
        decidedAt: 3_000,
        expiresAt: 11_000,
        method: "reject-all" as const,
        recordId: "record-1",
      } as const)
    : ({
        decidedAt: 3_000,
        expiresAt: 11_000,
        grantedPurposeIds: ["analytics"],
        method: "granular" as const,
        recordId: "record-1",
      } as const);
}

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function stateRecord(value: PersistedConsentState): PersistedDecisionRecord {
  if (value.record === undefined) {
    throw new Error("Expected an active persisted consent record.");
  }
  return value.record;
}

it("orchestrates policy, persistence, access, signals, enforcement, events, and receipt", async () => {
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

  const order: string[] = [];
  let stored: PersistedDecisionRecord | null = null;
  let receipt: ConsentReceipt | undefined;
  let googleState: unknown;
  let enforcementDecisions: unknown;
  const effects: ConsentRuntimeTransitionEffect[] = [];
  const reconciler = createAccessEnforcementReconciler({
    resources: {
      "analytics-script": {
        block: () => Promise.resolve({ irreversibleEffects: [] }),
        cleanup: () => Promise.resolve({ irreversibleEffects: [] }),
        discover: () => Promise.resolve("blocked"),
        start: () => {
          order.push("start");
          return Promise.resolve({ irreversibleEffects: [] });
        },
        stop: () => Promise.resolve(),
      },
    },
  });

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: (effect) => {
        order.push("signal");
        googleState = projectGoogleConsentModeState(
          effect.runtime.effectiveAccess,
          { analyticsStorageResourceIds: ["analytics-script"] },
        );
        return Promise.resolve();
      },
      commit: (effect) => {
        order.push("commit");
        effects.push(effect);
      },
      notify: (effect) => {
        order.push("notify");
        effects.push(effect);
      },
      receipt: (nextReceipt) => {
        order.push("receipt");
        receipt = nextReceipt;
        return Promise.resolve();
      },
      reconcile: async (effect) => {
        order.push("reconcile");
        enforcementDecisions = projectAccessEnforcementDecisions(
          effect.runtime.effectiveAccess,
        );
        await reconciler.reconcile(
          projectAccessEnforcementDecisions(effect.runtime.effectiveAccess),
        );
      },
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared" as const),
        compareAndSet: (_expected, candidate) => {
          order.push("write");
          stored = stateRecord(candidate);
          return Promise.resolve({ status: "written" });
        },
        read: () => {
          order.push("readback");
          return Promise.resolve(
            stored === null
              ? { status: "missing" as const }
              : { state: state(stored), status: "stored" as const },
          );
        },
      },
    },
    {
      decision: {
        decidedAt: 1_000,
        expiresAt: 2_000,
        method: "accept-all",
        recordId: "record-1",
      },
      now: 1_000,
      policySnapshot,
      resourcePolicy: resources.resourcePolicy,
      transitionId: "transition-1",
    },
  );

  expect(result.outcome).toBe("committed");
  expect(order).toEqual([
    "write",
    "readback",
    "commit",
    "signal",
    "reconcile",
    "start",
    "receipt",
    "notify",
  ]);
  expect(googleState).toEqual({
    adPersonalization: "denied",
    adStorage: "denied",
    adUserData: "denied",
    analyticsStorage: "granted",
  });
  expect(enforcementDecisions).toEqual([
    { access: "allowed", resourceId: "analytics-script" },
  ]);
  expect(effects).toHaveLength(2);
  expect(effects[0]).toBe(effects[1]);
  expect(effects[0]?.events.map((event) => event.type)).toEqual([
    "ConsentRecordCreated",
    "ConsentGranted",
  ]);
  expect(receipt).toMatchObject({
    decidedAt: 1_000,
    idempotencyKey: "transition-1:1",
    occurredAt: 1_000,
    persistenceStatus: "confirmed",
    schemaVersion: 2,
    transitionId: "transition-1",
  });
  expect(stored).toMatchObject({
    decisions: { analytics: "granted" },
    revision: 1,
  });
});

it.each([
  ["accept-all", "grant-write-conflict"],
  ["reject-all", "denial-persistence-conflict"],
] as const)(
  "does not let a record-A %s retry overwrite record B at the same revision",
  async (method, diagnosticCode) => {
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

    const base: PersistedDecisionRecord = {
      catalogueDigest: policySnapshot.catalogueDigest,
      decidedAt: 1_000,
      decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
      decisions: {
        analytics: method === "accept-all" ? "denied" : "granted",
      },
      expiresAt: 2_000,
      method: method === "accept-all" ? "reject-all" : "accept-all",
      policyVersion: policySnapshot.policyVersion,
      recordId: "record-A",
      revision: 1,
    };
    const concurrent: PersistedDecisionRecord = {
      ...base,
      recordId: "record-B",
    };
    let durable: PersistedDecisionRecord = concurrent;
    let writes = 0;

    const result = await executeConsentRuntimeDecision(
      {
        broadcast: () => Promise.resolve(),
        commit: () => undefined,
        notify: () => undefined,
        receipt: () => Promise.resolve(),
        reconcile: () => Promise.resolve(),
        store: {
          clear: () => Promise.resolve(),
          clearIfCurrent: () => Promise.resolve("conflict" as const),
          compareAndSet: (expected: unknown, candidate) => {
            const legacyRevisionOnlyExpectation =
              typeof expected === "number"
                ? expected
                : expected === null
                  ? null
                  : stateRecord(expected as PersistedConsentState).revision;
            if (durable.revision !== legacyRevisionOnlyExpectation) {
              return Promise.resolve({ status: "conflict" as const });
            }
            writes += 1;
            durable = stateRecord(candidate);
            return Promise.resolve({ status: "written" as const });
          },
          read: () =>
            Promise.resolve({
              state: state(durable),
              status: "stored" as const,
            }),
        },
      },
      {
        currentRecord: toConsentRecord(base),
        decision: {
          decidedAt: 1_500,
          expiresAt: 2_500,
          method,
          recordId: "record-A",
        },
        now: 1_500,
        persistedRecord: toConsentRecord(concurrent),
        policySnapshot,
        resourcePolicy: resources.resourcePolicy,
        transitionId: `transition-${method}`,
      },
    );

    expect(result).toMatchObject({
      diagnostics: [{ code: diagnosticCode }],
      outcome: "degraded",
    });
    expect(writes).toBe(0);
    expect(durable).toBe(concurrent);
  },
);

it.each(["accept-all", "reject-all"] as const)(
  "rejects an unsafe %s decision before any transition effect",
  async (method) => {
    const runtime = receiptRuntime();
    const calls: string[] = [];

    const result = await executeConsentRuntimeDecision(
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
        decision: {
          decidedAt: 1_000.5,
          expiresAt: 2_000,
          method,
          recordId: "record-1",
        },
        now: 1_000.5,
        ...runtime,
        transitionId: `transition-${method}`,
      },
    );

    expect(result).toEqual({
      issues: [{ code: "invalid-timestamp", path: "decidedAt" }],
      outcome: "rejected",
    });
    expect(calls).toEqual([]);
  },
);

it("rejects a non-positive current decision interval before any transition effect", async () => {
  const runtime = receiptRuntime();
  const currentRecord = toConsentRecord({
    catalogueDigest: runtime.policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: runtime.policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted" },
    expiresAt: 1_000,
    method: "accept-all",
    policyVersion: runtime.policySnapshot.policyVersion,
    recordId: "record-1",
    revision: 1,
  });
  const calls: string[] = [];
  const asyncEffect = () => {
    calls.push("effect");
    return Promise.resolve();
  };
  const syncEffect = () => {
    calls.push("effect");
  };

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: asyncEffect,
      commit: syncEffect,
      notify: syncEffect,
      receipt: asyncEffect,
      reconcile: asyncEffect,
      store: {
        clear: asyncEffect,
        clearIfCurrent: () => {
          calls.push("effect");
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: () => {
          calls.push("effect");
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          calls.push("effect");
          return Promise.resolve({ status: "missing" as const });
        },
      },
    },
    {
      currentRecord,
      decision: {
        decidedAt: 1_500,
        expiresAt: 2_500,
        method: "reject-all",
      },
      now: 1_500,
      ...runtime,
      transitionId: "transition-invalid-current-interval",
    },
  );

  expect(result).toEqual({
    issues: [{ code: "invalid-current-record", path: "current.expiresAt" }],
    outcome: "rejected",
  });
  expect(calls).toEqual([]);
});

it("rejects a malformed current decision before persistence or integration effects", async () => {
  const runtime = receiptRuntime();
  const currentRecord = {
    ...toConsentRecord({
      catalogueDigest: runtime.policySnapshot.catalogueDigest,
      decidedAt: 1_000,
      decisionSurfaceDigest: runtime.policySnapshot.decisionSurfaceDigest,
      decisions: { analytics: "denied" },
      expiresAt: 2_000,
      method: "reject-all",
      policyVersion: runtime.policySnapshot.policyVersion,
      recordId: "record-1",
      revision: 1,
    }),
    decisions: [{ purposeId: "analytics", value: "forged" }],
  } as unknown as ReturnType<typeof toConsentRecord>;
  const calls: string[] = [];
  let durable: PersistedDecisionRecord | null = null;
  const asyncEffect = (label: string) => () => {
    calls.push(label);
    return Promise.resolve();
  };
  const syncEffect = (label: string) => () => {
    calls.push(label);
  };

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: asyncEffect("broadcast"),
      commit: syncEffect("commit"),
      notify: syncEffect("notify"),
      receipt: asyncEffect("receipt"),
      reconcile: asyncEffect("reconcile"),
      store: {
        clear: asyncEffect("clear"),
        clearIfCurrent: () => {
          calls.push("clear-if-current");
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (_expected, candidate) => {
          calls.push("write");
          durable = stateRecord(candidate);
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          calls.push("read");
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: state(durable), status: "stored" as const },
          );
        },
      },
    },
    {
      currentRecord,
      decision: {
        decidedAt: 1_500,
        expiresAt: 2_500,
        method: "accept-all",
      },
      now: 1_500,
      ...runtime,
      transitionId: "transition-malformed-current",
    },
  );

  expect(result).toEqual({
    issues: [{ code: "invalid-current-record", path: "current.decisions" }],
    outcome: "rejected",
  });
  expect(calls).toEqual([]);
  expect(durable).toBeNull();
});

it("rejects an accessor-backed current revision before any runtime effect", async () => {
  const runtime = receiptRuntime();
  const base = toConsentRecord({
    catalogueDigest: runtime.policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: runtime.policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted" },
    expiresAt: 2_000,
    method: "accept-all",
    policyVersion: runtime.policySnapshot.policyVersion,
    recordId: "record-1",
    revision: Number.MAX_SAFE_INTEGER - 1,
  });
  let revisionReads = 0;
  const currentRecord = { ...base };
  Object.defineProperty(currentRecord, "revision", {
    enumerable: true,
    get: () => {
      revisionReads += 1;
      return revisionReads <= 2
        ? Number.MAX_SAFE_INTEGER - 1
        : Number.MAX_SAFE_INTEGER;
    },
  });
  const calls: string[] = [];
  const asyncEffect = (label: string) => () => {
    calls.push(label);
    return Promise.resolve();
  };

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: asyncEffect("broadcast"),
      commit: () => calls.push("commit"),
      notify: () => calls.push("notify"),
      receipt: asyncEffect("receipt"),
      reconcile: asyncEffect("reconcile"),
      store: {
        clear: asyncEffect("clear"),
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
      currentRecord,
      decision: {
        decidedAt: 1_500,
        expiresAt: 2_500,
        method: "reject-all",
      },
      now: 1_500,
      ...runtime,
      transitionId: "transition-accessor-current",
    },
  );

  expect(result).toEqual({
    issues: [{ code: "invalid-current-record", path: "current.revision" }],
    outcome: "rejected",
  });
  expect(calls).toEqual([]);
  expect(revisionReads).toBe(0);
});

it("rejects an accessor-backed decision command before persistence", async () => {
  const runtime = receiptRuntime();
  const calls: string[] = [];
  let durable: PersistedDecisionRecord | null = null;
  let decidedAtReads = 0;
  const decision = {
    decidedAt: 0,
    expiresAt: 3_000,
    method: "accept-all" as const,
    recordId: "record-1",
  };
  Object.defineProperty(decision, "decidedAt", {
    get: () => {
      decidedAtReads += 1;
      return decidedAtReads === 1 ? 1_000 : 1_000.5;
    },
  });

  let result:
    Awaited<ReturnType<typeof executeConsentRuntimeDecision>> | undefined;
  let thrown: unknown;
  try {
    result = await executeConsentRuntimeDecision(
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
          compareAndSet: (_expected, candidate) => {
            calls.push("write");
            durable = stateRecord(candidate);
            return Promise.resolve({ status: "written" as const });
          },
          read: () => {
            calls.push("read");
            return Promise.resolve(
              durable === null
                ? { status: "missing" as const }
                : { state: state(durable), status: "stored" as const },
            );
          },
        },
      },
      {
        decision,
        now: 2_000,
        ...runtime,
        transitionId: "transition-accessor-decision-command",
      },
    );
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeUndefined();
  expect(result).toEqual({
    issues: [{ code: "invalid-timestamp", path: "decidedAt" }],
    outcome: "rejected",
  });
  expect(decidedAtReads).toBe(0);
  expect(calls).toEqual([]);
});

it.each([
  ["accept-all", 1_000.5, "now must be a finite safe integer."],
  ["accept-all", 999, "now must be greater than or equal to decidedAt."],
  ["reject-all", 1_000.5, "now must be a finite safe integer."],
  ["reject-all", 999, "now must be greater than or equal to decidedAt."],
] as const)(
  "rejects a %s decision with invalid runtime time %s before any transition effect",
  async (method, now, message) => {
    const runtime = receiptRuntime();
    const calls: string[] = [];

    await expect(
      executeConsentRuntimeDecision(
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
          decision: {
            decidedAt: 1_000,
            expiresAt: 2_000,
            method,
            recordId: "record-1",
          },
          now,
          ...runtime,
          transitionId: `transition-${method}`,
        },
      ),
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
  },
);

it("captures decision runtime time once across persistence and effects", async () => {
  const runtime = receiptRuntime();
  const calls: string[] = [];
  let durable: PersistedDecisionRecord | null = null;
  let receipt: ConsentReceipt | undefined;
  let nowReads = 0;
  const command = {
    decision: {
      decidedAt: 1_000,
      expiresAt: 2_000,
      method: "accept-all" as const,
      recordId: "record-1",
    },
    now: 0,
    ...runtime,
    transitionId: "transition-captured-now",
  };
  Object.defineProperty(command, "now", {
    get: () => {
      nowReads += 1;
      if (nowReads === 1) return 1_000;
      throw new Error("runtime time was read twice");
    },
  });

  const result = await executeConsentRuntimeDecision(
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
        read: () => {
          calls.push("read");
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: state(durable), status: "stored" as const },
          );
        },
      },
    },
    command,
  );

  expect(result.outcome).toBe("committed");
  expect(nowReads).toBe(1);
  expect(calls).toEqual([
    "write",
    "read",
    "commit",
    "broadcast",
    "reconcile",
    "receipt",
    "notify",
  ]);
  expect(receipt).toMatchObject({ occurredAt: 1_000 });
});

it("uses one captured retry occurrence across effects and receipt", async () => {
  const runtime = receiptRuntime(["analytics", "personalization"]);
  const current = failedRetryRecord("denial", runtime.policySnapshot);
  const calls: string[] = [];
  let durable: PersistedDecisionRecord | null = null;
  let receipt: ConsentReceipt | undefined;
  let nowReads = 0;
  const nowValues = [3_000, Number.MAX_SAFE_INTEGER + 1, 3_000] as const;
  const command = {
    currentRecord: toConsentRecord(current),
    decision: retryDecision("denial"),
    now: 0,
    persistedRecord: null,
    ...runtime,
    transitionId: "transition-changing-retry-now",
  };
  Object.defineProperty(command, "now", {
    get: () => {
      const value = nowValues[nowReads];
      nowReads += 1;
      if (value === undefined) throw new Error("runtime time was over-read");
      return value;
    },
  });

  const result = await executeConsentRuntimeDecision(
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
  expect(receipt).toMatchObject({ occurredAt: 3_000 });
});

it("rejects one unsafe captured decision time before any effect", async () => {
  const runtime = receiptRuntime();
  const calls: string[] = [];
  let nowReads = 0;
  const command = {
    decision: {
      decidedAt: 1_000,
      expiresAt: 2_000,
      method: "accept-all" as const,
      recordId: "record-1",
    },
    now: 0,
    ...runtime,
    transitionId: "transition-unsafe-captured-now",
  };
  Object.defineProperty(command, "now", {
    get: () => {
      nowReads += 1;
      return nowReads === 1 ? Number.MAX_SAFE_INTEGER + 1 : 1_000;
    },
  });

  await expect(
    executeConsentRuntimeDecision(
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
    ),
  ).rejects.toThrow("now must be a finite safe integer.");
  expect(nowReads).toBe(1);
  expect(calls).toEqual([]);
});

it.each(["denial", "narrowing-grant"] as const)(
  "uses the new attempt time for a confirmed %s persistence retry receipt",
  async (mode) => {
    const runtime = receiptRuntime(["analytics", "personalization"]);
    const current = failedRetryRecord(mode, runtime.policySnapshot);
    let durable: PersistedDecisionRecord | null = null;
    let receipt: ConsentReceipt | undefined;

    const result = await executeConsentRuntimeDecision(
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
          clear: () => {
            durable = null;
            return Promise.resolve();
          },
          clearIfCurrent: () => {
            durable = null;
            return Promise.resolve("cleared" as const);
          },
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
        currentRecord: toConsentRecord(current),
        decision: retryDecision(mode),
        now: 3_000,
        persistedRecord: null,
        ...runtime,
        transitionId: `transition-${mode}-retry`,
      },
    );

    expect(result).toMatchObject({
      effect: { events: [] },
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: { revision: 2 },
      },
    });
    expect(receipt).toMatchObject({
      decidedAt: 2_000,
      idempotencyKey: `transition-${mode}-retry:2`,
      occurredAt: 3_000,
      persistenceStatus: "confirmed",
      revision: 2,
      schemaVersion: 2,
      transitionId: `transition-${mode}-retry`,
    });
  },
);

it.each([
  ["denial", 2_000.5, "now must be a finite safe integer."],
  ["denial", 1_999, "now must be greater than or equal to decidedAt."],
  ["narrowing-grant", 2_000.5, "now must be a finite safe integer."],
  ["narrowing-grant", 1_999, "now must be greater than or equal to decidedAt."],
] as const)(
  "rejects a %s persistence retry occurrence %s before any transition effect",
  async (mode, now, message) => {
    const runtime = receiptRuntime(["analytics", "personalization"]);
    const current = failedRetryRecord(mode, runtime.policySnapshot);
    const calls: string[] = [];

    await expect(
      executeConsentRuntimeDecision(
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
          currentRecord: toConsentRecord(current),
          decision: retryDecision(mode),
          now,
          persistedRecord: null,
          ...runtime,
          transitionId: `transition-${mode}-retry`,
        },
      ),
    ).rejects.toThrow(message);
    expect(calls).toEqual([]);
  },
);
