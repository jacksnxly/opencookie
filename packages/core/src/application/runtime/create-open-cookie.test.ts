import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type DecisionStore,
  type OpenCookieSnapshot,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../index.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";

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

function activeGrantRecord(): PersistedDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "granted" },
    expiresAt: 86_401_000,
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-1",
    revision: 1,
    method: "accept-all",
  };
}

function sameRecord(
  left: PersistedDecisionRecord | null,
  right: PersistedDecisionRecord | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function stateRecord(
  state: PersistedConsentState | null,
): PersistedDecisionRecord | null {
  if (state === null) return null;
  if (state.record === undefined) throw new Error("fixture requires a record");
  return state.record;
}

function memoryStore(initial: PersistedDecisionRecord | null = null): {
  readonly readCount: () => number;
  readonly store: DecisionStore;
  readonly stored: () => PersistedDecisionRecord | null;
} {
  let record = initial;
  let reads = 0;
  return {
    readCount: () => reads,
    store: {
      clear: () => {
        record = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (record === null) return Promise.resolve("cleared" as const);
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve("conflict" as const);
        }
        record = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve({ status: "conflict" });
        }
        record = stateRecord(candidate);
        return Promise.resolve({ status: "written" });
      },
      read: () => {
        reads += 1;
        return Promise.resolve(
          record === null
            ? { status: "missing" as const }
            : { state: state(record), status: "stored" as const },
        );
      },
    },
    stored: () => record,
  };
}

function restorableMemoryStore(initial: PersistedDecisionRecord): {
  readonly store: DecisionStore;
  readonly stored: () => PersistedDecisionRecord | null;
} {
  let durable: PersistedConsentState | null = state(initial);
  const sameState = (
    left: PersistedConsentState | null,
    right: PersistedConsentState | null,
  ) => JSON.stringify(left) === JSON.stringify(right);
  return {
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (!sameState(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        if (!sameState(durable, expected)) {
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
    stored: () => (durable?.record ? durable.record : null),
  };
}

describe("createOpenCookie", () => {
  it("exposes one detached validated policy snapshot to every runtime projection", () => {
    const memory = memoryStore();
    const runtime = runtimePolicy();
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtime,
      store: memory.store,
    });

    const captured = client.getSnapshot().policySnapshot;
    expect(captured).toEqual(runtime.policySnapshot);
    expect(captured).not.toBe(runtime.policySnapshot);
    expect(client.getServerSnapshot().policySnapshot).toBe(captured);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  // @covers PP-19 REQ-HEADLESS-API: state is inspectable deterministically with an injected clock and id source.
  it("exposes a deterministic first-visit server snapshot without touching storage", () => {
    const memory = memoryStore();
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtimePolicy(),
      store: memory.store,
    });

    expect(client.getServerSnapshot()).toBe(client.getSnapshot());
    expect(client.getServerSnapshot()).toMatchObject({
      preferencesOpen: true,
      readiness: "uninitialized",
      runtime: {
        consentEvaluation: {
          prompt: true,
          status: "first-visit",
        },
      },
    });
    expect(memory.readCount()).toBe(0);
  });

  it("returns a fresh withdrawal without reading time, allocating identifiers, or signaling", async () => {
    const memory = memoryStore();
    const unexpected = () => {
      throw new Error(
        "fresh withdrawal crossed a terminal side-effect boundary",
      );
    };
    const client = createOpenCookie({
      broadcast: unexpected,
      consentDurationMs: 86_400_000,
      idGenerator: unexpected,
      now: unexpected,
      receipt: unexpected,
      reconcile: unexpected,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.withdrawConsent()).resolves.toMatchObject({
      outcome: "not-applicable",
    });
    expect(memory.readCount()).toBe(1);
  });

  it("initializes once, remains an external store, and publishes one subscriber update", async () => {
    const memory = memoryStore();
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtimePolicy(),
      store: memory.store,
    });
    let updates = 0;
    const unsubscribe = client.subscribe(() => {
      updates += 1;
    });

    const first = await client.initialize();
    const second = await client.initialize();

    expect(first).toBe(second);
    expect(first.readiness).toBe("ready");
    expect(memory.readCount()).toBe(1);
    expect(updates).toBe(1);
    unsubscribe();
  });

  it("publishes an unchanged decision so an open dialog can still be dismissed", async () => {
    const memory = memoryStore(activeGrantRecord());
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    client.openPreferences();
    expect(client.getSnapshot().preferencesOpen).toBe(true);

    let updates = 0;
    const unsubscribe = client.subscribe(() => {
      updates += 1;
    });
    const result = await client.acceptAll();

    expect(result.outcome).toBe("unchanged");
    expect(updates).toBe(1);
    expect(client.getSnapshot().preferencesOpen).toBe(false);
    unsubscribe();
  });

  it("keeps preferences operable when restored consent is ahead of the local clock", async () => {
    const memory = restorableMemoryStore({
      ...activeGrantRecord(),
      decidedAt: 2_000,
      expiresAt: 86_402_000,
    });
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      preferencesOpen: false,
      readiness: "ready",
      runtime: {
        consentEvaluation: { prompt: false, status: "active" },
        policyReconciliation: { prompt: false, status: "current" },
      },
    });

    client.openPreferences();
    client.closePreferences();
    expect(client.getSnapshot().preferencesOpen).toBe(false);

    client.openPreferences();
    await expect(client.rejectAll()).resolves.toMatchObject({
      effect: {
        record: { decidedAt: 2_000, method: "reject-all", revision: 2 },
      },
      outcome: "committed",
    });
    expect(memory.stored()).toMatchObject({
      decidedAt: 2_000,
      method: "reject-all",
      revision: 2,
    });
    expect(client.getSnapshot().preferencesOpen).toBe(false);
  });

  it("restores an expired grant as expired without staging a restoration", async () => {
    const memory = memoryStore({
      ...activeGrantRecord(),
      decidedAt: 1_000,
      expiresAt: 1_010,
    });
    const broadcasts: string[] = [];
    const client = createOpenCookie({
      broadcast: (effect) => {
        broadcasts.push(
          `${effect.record.method}:${effect.runtime.consentEvaluation.status}`,
        );
        return Promise.resolve();
      },
      consentDurationMs: 10,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_011,
      ...runtimePolicy(),
      store: memory.store,
    });

    const snapshot = await client.initialize();

    expect(snapshot).toMatchObject({
      grantActivation: "not-applicable",
      readiness: "ready",
      record: { method: "accept-all", revision: 1 },
      runtime: { consentEvaluation: { prompt: true, status: "expired" } },
    });
    expect(snapshot.pendingGrant).toBeUndefined();
    expect(memory.stored()).toMatchObject({
      method: "accept-all",
      revision: 1,
    });
    expect(memory.readCount()).toBe(1);
    expect(broadcasts).toEqual([]);
    expect(
      snapshot.runtime.effectiveAccess.resources.every(
        ({ access }) => access === "blocked",
      ),
    ).toBe(true);
  });

  it("drives a denial through the serialized terminal lifecycle", async () => {
    const memory = memoryStore();
    const order: string[] = [];
    const generated = ["record-1", "transition-reject"];
    const client = createOpenCookie({
      broadcast: (effect) => {
        order.push(`signal:${effect.record.method}`);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => generated.shift() ?? "unexpected-id",
      now: () => 1_000 + order.length,
      receipt: (receipt) => {
        order.push(`receipt:${receipt.method}`);
        return Promise.resolve();
      },
      reconcile: (effect) => {
        order.push(`reconcile:${effect.record.method}`);
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    await expect(client.rejectAll()).resolves.toMatchObject({
      outcome: "committed",
    });

    expect(memory.stored()).toMatchObject({
      decisions: { analytics: "denied", personalization: "denied" },
      method: "reject-all",
      revision: 1,
    });
    expect(order).toEqual([
      "signal:reject-all",
      "reconcile:reject-all",
      "receipt:reject-all",
    ]);
  });

  it("withdraws an existing grant through persistence, signals, enforcement, events, and receipts", async () => {
    const memory = memoryStore(activeGrantRecord());
    const generated = ["transition-withdraw"];
    const effects: string[][] = [];
    const receipts: string[] = [];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect.events.map((event) => event.type));
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => generated.shift() ?? "unexpected-id",
      now: () => now,
      receipt: (receipt) => {
        receipts.push(receipt.method);
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    now = 1_500;
    client.openPreferences();
    await expect(client.withdrawConsent()).resolves.toMatchObject({
      outcome: "committed",
    });

    expect(memory.stored()).toMatchObject({
      decisions: { analytics: "denied", personalization: "denied" },
      method: "withdrawal",
      revision: 2,
      withdrawnAt: 1_500,
    });
    expect(client.getSnapshot()).toMatchObject({
      preferencesOpen: false,
      record: { method: "withdrawal" },
      runtime: { consentEvaluation: { status: "withdrawn" } },
    });
    expect(effects).toEqual([["ConsentWithdrawn"]]);
    expect(receipts).toEqual(["withdrawal"]);
  });

  it.each([
    ["Error", new Error("cleanup failed")],
    ["undefined", undefined],
  ] as const)(
    "persists a withdrawal and reports an %s enforcement rejection",
    async (_reasonKind, failure) => {
      const memory = memoryStore(activeGrantRecord());
      const generated = ["transition-withdraw"];
      const receipts: string[] = [];
      const notifications: Array<OpenCookieSnapshot["lastPersistenceStatus"]> =
        [];
      let rejectReconcile = false;
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: () => generated.shift() ?? "unexpected-id",
        now: () => now,
        receipt: (receipt) => {
          receipts.push(receipt.method);
          return Promise.resolve();
        },
        reconcile: () => {
          if (rejectReconcile) {
            // This regression deliberately exercises arbitrary rejection values.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject(failure);
          }
          return Promise.resolve();
        },
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();
      client.subscribe(() => {
        notifications.push(client.getSnapshot().lastPersistenceStatus);
      });
      rejectReconcile = true;
      now = 1_500;

      await expect(client.withdrawConsent()).resolves.toMatchObject({
        diagnostics: [{ code: "denial-reconcile-failed" }],
        outcome: "degraded",
        transition: { persistenceStatus: "confirmed" },
      });
      expect(memory.stored()).toMatchObject({
        method: "withdrawal",
        withdrawnAt: 1_500,
      });
      expect(receipts).toEqual(["withdrawal"]);
      expect(notifications).toEqual(["pending", "confirmed"]);
    },
  );

  it("clears an older grant after denial persistence fails and retries the same denial", async () => {
    let record: PersistedDecisionRecord | null = activeGrantRecord();
    let failNextWrite = false;
    const expectedRecords: Array<PersistedDecisionRecord | null> = [];
    const store = {
      clear: () => {
        record = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected: PersistedConsentState) => {
        if (record === null) return Promise.resolve("cleared" as const);
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve("conflict" as const);
        }
        record = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (
        expected: PersistedConsentState | null,
        candidate: PersistedConsentState,
      ) => {
        expectedRecords.push(stateRecord(expected));
        if (failNextWrite) {
          failNextWrite = false;
          return Promise.reject(new Error("quota exceeded"));
        }
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve({ status: "conflict" as const });
        }
        record = stateRecord(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          record === null
            ? { status: "missing" as const }
            : { state: state(record), status: "stored" as const },
        ),
    };
    const generated = ["transition-reject-failed", "transition-reject-retry"];
    const options = {
      consentDurationMs: 86_400_000,
      idGenerator: () => generated.shift() ?? "unexpected-id",
      now: () => 1_000,
      ...runtimePolicy(),
      store,
    };
    const client = createOpenCookie(options);
    await client.initialize();
    failNextWrite = true;

    await expect(client.rejectAll()).resolves.toMatchObject({
      diagnostics: [{ code: "denial-persistence-failed" }],
      outcome: "degraded",
      transition: { persistenceStatus: "failed" },
    });
    expect(record).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "failed",
      preferencesOpen: true,
      record: {
        decisions: [
          { purposeId: "analytics", value: "denied" },
          { purposeId: "personalization", value: "denied" },
        ],
      },
    });

    const reloaded = createOpenCookie({
      ...options,
      idGenerator: (kind) => `reload-${kind}`,
    });
    await expect(reloaded.initialize()).resolves.toMatchObject({
      runtime: { consentEvaluation: { status: "first-visit" } },
    });

    await expect(client.rejectAll()).resolves.toMatchObject({
      outcome: "committed",
      transition: { persistenceStatus: "confirmed" },
    });
    expect(record).toMatchObject({ method: "reject-all", revision: 2 });
    expect(
      expectedRecords
        .slice(-2)
        .map((expected) =>
          expected === null
            ? null
            : { recordId: expected.recordId, revision: expected.revision },
        ),
    ).toEqual([{ recordId: "record-1", revision: 1 }, null]);
  });

  it("keeps a failed first grant pending at persistence", async () => {
    let record: PersistedDecisionRecord | null = null;
    let failNextWrite = true;
    const expectedRecords: Array<PersistedDecisionRecord | null> = [];
    const store = {
      clear: () => {
        record = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected: PersistedConsentState) => {
        if (record === null) return Promise.resolve("cleared" as const);
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve("conflict" as const);
        }
        record = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (
        expected: PersistedConsentState | null,
        candidate: PersistedConsentState,
      ) => {
        expectedRecords.push(stateRecord(expected));
        if (failNextWrite) {
          failNextWrite = false;
          return Promise.reject(new Error("quota exceeded"));
        }
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve({ status: "conflict" as const });
        }
        record = stateRecord(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          record === null
            ? { status: "missing" as const }
            : { state: state(record), status: "stored" as const },
        ),
    };
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
      transition: { persistenceStatus: "pending" },
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence", transitionId: "transition-1" },
    });
    expect(expectedRecords).toEqual([null]);
    expect(record).toBeNull();
  });

  it("keeps a failed replacement pending under conservative access", async () => {
    let record: PersistedDecisionRecord | null = activeGrantRecord();
    let failNextWrite = false;
    let writes = 0;
    const store = {
      clear: () => {
        record = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected: PersistedConsentState) => {
        if (record === null) return Promise.resolve("cleared" as const);
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve("conflict" as const);
        }
        record = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (
        expected: PersistedConsentState | null,
        candidate: PersistedConsentState,
      ) => {
        writes += 1;
        if (failNextWrite) {
          failNextWrite = false;
          return Promise.reject(new Error("quota exceeded"));
        }
        if (!sameRecord(record, stateRecord(expected))) {
          return Promise.resolve({ status: "conflict" as const });
        }
        record = stateRecord(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          record === null
            ? { status: "missing" as const }
            : { state: state(record), status: "stored" as const },
        ),
    };
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();
    const writesBeforeReplacement = writes;
    failNextWrite = true;

    await expect(client.savePreferences(["analytics"])).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
      transition: { persistenceStatus: "pending" },
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: {
        grantedPurposeIds: ["analytics"],
        phase: "persistence",
        transitionId: "transition-1",
      },
      record: {
        decisions: [
          { purposeId: "analytics", value: "granted" },
          { purposeId: "personalization", value: "granted" },
        ],
        recordId: "record-1",
        revision: 1,
      },
    });
    expect(writes - writesBeforeReplacement).toBe(1);
    expect(record).toBeNull();
  });

  it("keeps a denial visibly incomplete and retries it without duplicating record creation", async () => {
    let stored: PersistedDecisionRecord | null = null;
    let failWrite = true;
    let failClear = true;
    const eventBatches: Array<
      Array<{ readonly revision: number; readonly type: string }>
    > = [];
    const expectedRecords: Array<PersistedDecisionRecord | null> = [];
    const generated = [
      "record-1",
      "transition-denial-failed",
      "transition-denial-retry",
    ];
    const client = createOpenCookie({
      broadcast: (effect) => {
        eventBatches.push(
          effect.events.map((event) => ({
            revision: event.revision,
            type: event.type,
          })),
        );
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => generated.shift() ?? "unexpected-id",
      now: () => 1_000,
      ...runtimePolicy(),
      store: {
        clear: () => {
          if (failClear) return Promise.reject(new Error("clear denied"));
          stored = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (failClear) return Promise.reject(new Error("clear denied"));
          if (stored === null) return Promise.resolve("cleared" as const);
          if (!sameRecord(stored, stateRecord(expected))) {
            return Promise.resolve("conflict" as const);
          }
          stored = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          expectedRecords.push(stateRecord(expected));
          if (failWrite) return Promise.reject(new Error("quota exceeded"));
          if (!sameRecord(stored, stateRecord(expected))) {
            return Promise.resolve({ status: "conflict" as const });
          }
          stored = stateRecord(candidate);
          return Promise.resolve({ status: "written" as const });
        },
        read: () =>
          Promise.resolve(
            stored === null
              ? { status: "missing" as const }
              : { state: state(stored), status: "stored" as const },
          ),
      },
    });
    await client.initialize();

    await expect(client.rejectAll()).resolves.toMatchObject({
      diagnostics: [
        { code: "denial-persistence-failed" },
        { code: "denial-clear-failed" },
      ],
      outcome: "degraded",
    });
    expect(client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "failed",
      preferencesOpen: true,
      record: {
        decisions: [
          { purposeId: "analytics", value: "denied" },
          { purposeId: "personalization", value: "denied" },
        ],
        recordId: "record-1",
        revision: 1,
      },
      runtime: {
        effectiveAccess: {
          resources: [{ access: "blocked", resourceId: "analytics-script" }],
        },
      },
    });

    failWrite = false;
    failClear = false;
    await expect(client.rejectAll()).resolves.toMatchObject({
      effect: { events: [] },
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: { recordId: "record-1", revision: 1 },
      },
    });
    expect(stored).toMatchObject({ recordId: "record-1", revision: 1 });
    expect(expectedRecords).toEqual([null, null]);
    expect(eventBatches).toEqual([
      [
        { revision: 1, type: "ConsentRecordCreated" },
        { revision: 1, type: "ConsentDenied" },
      ],
      [],
    ]);
    expect(client.getSnapshot().preferencesOpen).toBe(false);
  });

  it("does not emit committed events for a persistence-pending grant", async () => {
    let stored: PersistedDecisionRecord | null = null;
    const eventBatches: Array<
      Array<{ readonly revision: number; readonly type: string }>
    > = [];
    const expectedRecords: Array<PersistedDecisionRecord | null> = [];
    const generated = ["record-1", "transition-grant-failed"];
    const client = createOpenCookie({
      broadcast: (effect) => {
        eventBatches.push(
          effect.events.map((event) => ({
            revision: event.revision,
            type: event.type,
          })),
        );
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => generated.shift() ?? "unexpected-id",
      now: () => 1_000,
      ...runtimePolicy(),
      store: {
        clear: () => {
          stored = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (stored === null) return Promise.resolve("cleared" as const);
          if (!sameRecord(stored, stateRecord(expected))) {
            return Promise.resolve("conflict" as const);
          }
          stored = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected) => {
          expectedRecords.push(stateRecord(expected));
          return Promise.reject(new Error("quota exceeded"));
        },
        read: () =>
          Promise.resolve(
            stored === null
              ? { status: "missing" as const }
              : { state: state(stored), status: "stored" as const },
          ),
      },
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      effect: { events: [] },
      outcome: "pending",
      transition: { persistenceStatus: "pending" },
    });

    expect(expectedRecords).toEqual([null]);
    expect(eventBatches).toEqual([[]]);
    expect(stored).toBeNull();
  });

  it("validates time, duration, and generated identifiers before persistence", async () => {
    const memory = memoryStore();
    expect(() =>
      createOpenCookie({
        consentDurationMs: 0,
        idGenerator: () => "id",
        now: () => 1_000,
        ...runtimePolicy(),
        store: memory.store,
      }),
    ).toThrow("positive safe integer");

    const client = createOpenCookie({
      consentDurationMs: 1_000,
      idGenerator: () => " ",
      now: () => Number.NaN,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    await expect(client.acceptAll()).rejects.toThrow("finite safe integer");
    expect(memory.stored()).toBeNull();
  });
});
