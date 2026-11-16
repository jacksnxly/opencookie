import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type OpenCookie,
  type OpenCookiePortContext,
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

function grantRecord(
  overrides: Partial<PersistedDecisionRecord> = {},
): PersistedDecisionRecord {
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
    ...overrides,
  } as PersistedDecisionRecord;
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
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
  readonly writes: () => readonly PersistedConsentState[];
} {
  let durable = initial;
  const writes: PersistedConsentState[] = [];
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

function firstWriteFailsStore(initial: PersistedConsentState | null = null): {
  readonly attempts: () => number;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  const memory = exactStateStore(initial);
  let attempts = 0;
  return {
    attempts: () => attempts,
    store: {
      ...memory.store,
      compareAndSet: (expected, candidate) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("first write unavailable"))
          : memory.store.compareAndSet(expected, candidate);
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

describe("createOpenCookie pending grant retry and restoration", () => {
  it("restages a persistence-pending decision with its original identity", async () => {
    const memory = firstWriteFailsStore();
    const broadcast = vi.fn((effect: ConsentRuntimeTransitionEffect) => {
      void effect;
      return Promise.resolve();
    });
    const receipt = vi.fn<
      (_receipt: unknown, _context?: OpenCookiePortContext) => Promise<void>
    >(() => Promise.resolve());
    const ids = vi.fn((kind: "record" | "transition") => `${kind}-restage`);
    let now = 1_000;
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 86_400_000,
      idGenerator: ids,
      now: () => now,
      receipt,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
      transition: {
        record: {
          decidedAt: 1_000,
          recordId: "record-restage",
          revision: 1,
        },
        transitionId: "transition-restage",
      },
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });

    now = 2_000;
    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: {
          decidedAt: 1_000,
          recordId: "record-restage",
          revision: 1,
        },
        transitionId: "transition-restage",
      },
    });

    expect(memory.attempts()).toBe(3);
    expect(memory.stored()).toMatchObject({
      record: { recordId: "record-restage", revision: 1 },
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
    const firstBroadcast = broadcast.mock.calls[0]?.[0];
    const secondBroadcast = broadcast.mock.calls[1]?.[0];
    if (firstBroadcast === undefined || secondBroadcast === undefined) {
      throw new Error("Expected correction and activation broadcasts.");
    }
    expect(accessOf(firstBroadcast)).toBe("blocked");
    expect(accessOf(secondBroadcast)).toBe("allowed");
    expect(receipt.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        occurredAt: 2_000,
        transitionId: "transition-restage",
      }),
    );
    expect(Object.isFrozen(receipt.mock.calls[0]?.[1])).toBe(true);
    expect(ids).toHaveBeenCalledTimes(2);
  });

  it("restages a persistence-pending restoration with one transition identity", async () => {
    const active = grantRecord();
    const memory = firstWriteFailsStore({ record: active });
    const broadcast = vi.fn(() => Promise.resolve());
    const receipt = vi.fn(() => Promise.resolve());
    const idGenerator = vi.fn(() => "transition-restore-restage");
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 86_400_000,
      idGenerator,
      now: () => 2_000,
      receipt,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      grantActivation: "pending",
      pendingGrant: {
        phase: "persistence",
        transitionId: "transition-restore-restage",
      },
      record: { recordId: "record-1", revision: 1 },
    });

    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "committed",
      transition: { transitionId: "transition-restore-restage" },
    });

    expect(memory.attempts()).toBe(3);
    expect(memory.stored()).toEqual({ record: active });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(receipt).not.toHaveBeenCalled();
    expect(idGenerator).toHaveBeenCalledTimes(1);
  });

  it("refreshes only receipt occurrence when retrying an identical pending grant", async () => {
    const memory = exactStateStore();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipts: Array<{
      readonly occurredAt: number;
      readonly transitionId: string;
    }> = [];
    const ids = vi.fn((kind: "record" | "transition") => `${kind}-retry`);
    let allowedCount = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        if (accessOf(effect) === "allowed") {
          allowedCount += 1;
          if (allowedCount === 1) {
            return Promise.reject(new Error("signal unavailable"));
          }
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: ids,
      now: () => now,
      receipt: (receipt) => {
        receipts.push(receipt);
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-signal-broadcast-failed" }],
      outcome: "pending",
      transition: { transitionId: "transition-retry" },
    });
    const staged = memory.stored();
    if (staged?.pendingGrant?.kind !== "decision") {
      throw new Error("Expected a durable decision-pending grant.");
    }
    expect(staged.pendingGrant.receiptOccurredAt).toBe(1_000);

    now = 2_000;
    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        transitionId: "transition-retry",
      },
    });

    const refreshed = memory.writes()[1];
    if (refreshed?.pendingGrant?.kind !== "decision") {
      throw new Error("Expected a refreshed decision-pending grant.");
    }
    expect(refreshed.pendingGrant).toMatchObject({
      receiptOccurredAt: 2_000,
      transitionId: "transition-retry",
    });
    expect(
      persistedConsentStatesEqual(
        { record: staged.pendingGrant.candidate },
        { record: refreshed.pendingGrant.candidate },
      ),
    ).toBe(true);
    expect(memory.stored()).toEqual({
      record: staged.pendingGrant.candidate,
    });
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked", "allowed"]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      occurredAt: 2_000,
      transitionId: "transition-retry",
    });
    expect(ids).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent retries of the same durable transition", async () => {
    const memory = exactStateStore();
    const retryStarted = deferred();
    const releaseRetry = deferred();
    const receipt = vi.fn(() => Promise.resolve());
    let allowedCount = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (accessOf(effect) === "blocked") return Promise.resolve();
        allowedCount += 1;
        if (allowedCount === 1) {
          return Promise.reject(new Error("first attempt failed"));
        }
        retryStarted.resolve();
        return releaseRetry.promise;
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-coalesce`,
      now: () => now,
      receipt,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    await client.acceptAll();

    now = 2_000;
    const firstRetry = client.retryPendingGrant();
    await retryStarted.promise;
    const secondRetry = client.retryPendingGrant();

    try {
      expect(memory.writes()).toHaveLength(2);
      expect(allowedCount).toBe(2);
      expect(receipt).not.toHaveBeenCalled();
    } finally {
      releaseRetry.resolve();
    }

    await expect(Promise.all([firstRetry, secondRetry])).resolves.toMatchObject(
      [{ outcome: "committed" }, { outcome: "committed" }],
    );
    expect(memory.writes()).toHaveLength(3);
    expect(allowedCount).toBe(2);
    expect(receipt).toHaveBeenCalledTimes(1);
  });

  it.each(["first", "replacement"] as const)(
    "resumes the original %s decision-pending transition after reload",
    async (mode) => {
      const base = grantRecord({ decidedAt: 500, expiresAt: 86_400_500 });
      const candidate = grantRecord({
        decidedAt: 1_000,
        decisions: { analytics: "granted", personalization: "denied" },
        expiresAt: 86_401_000,
        method: "granular",
        revision: mode === "first" ? 1 : 2,
      });
      const initial: PersistedConsentState = {
        ...(mode === "replacement" ? { record: base } : {}),
        pendingGrant: {
          candidate,
          kind: "decision",
          receiptOccurredAt: 1_100,
          transitionId: `transition-${mode}-original`,
        },
      };
      const memory = exactStateStore(initial);
      const effects: ConsentRuntimeTransitionEffect[] = [];
      const receipt = vi.fn<
        (_receipt: unknown, _context?: OpenCookiePortContext) => Promise<void>
      >(() => Promise.resolve());
      const idGenerator = vi.fn(() => "must-not-generate");
      let observedSnapshot: OpenCookieSnapshot | undefined;
      const client: OpenCookie = createOpenCookie({
        broadcast: (effect) => {
          effects.push(effect);
          observedSnapshot = client.getSnapshot();
          return Promise.resolve();
        },
        consentDurationMs: 86_400_000,
        idGenerator,
        now: () => 1_500,
        receipt,
        ...runtimePolicy(),
        store: memory.store,
      });

      await expect(client.initialize()).resolves.toMatchObject({
        grantActivation: "active",
        record: { method: "granular", revision: candidate.revision },
      });

      expect(observedSnapshot).toMatchObject({
        grantActivation: "pending",
        pendingGrant: {
          phase: "broadcast",
          transitionId: `transition-${mode}-original`,
        },
        ...(mode === "replacement"
          ? { record: { method: "accept-all", revision: 1 } }
          : {}),
        runtime: {
          effectiveAccess: {
            resources: [{ access: "blocked", resourceId: "analytics-script" }],
          },
        },
      });
      if (mode === "first")
        expect(observedSnapshot).not.toHaveProperty("record");
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        events: [],
        transitionId: `transition-${mode}-original`,
      });
      expect(memory.writes()).toEqual([{ record: candidate }]);
      expect(receipt.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          occurredAt: 1_100,
          transitionId: `transition-${mode}-original`,
        }),
      );
      expect(Object.isFrozen(receipt.mock.calls[0]?.[1])).toBe(true);
      expect(idGenerator).not.toHaveBeenCalled();
    },
  );

  it("preserves completed lineage when a resumed replacement remains pending", async () => {
    const base = grantRecord({ decidedAt: 500, expiresAt: 86_400_500 });
    const candidate = grantRecord({
      decidedAt: 1_000,
      decisions: { analytics: "granted", personalization: "denied" },
      expiresAt: 86_401_000,
      method: "granular",
      revision: 2,
    });
    const memory = exactStateStore({
      pendingGrant: {
        candidate,
        kind: "decision",
        receiptOccurredAt: 1_100,
        transitionId: "transition-replacement",
      },
      record: base,
    });
    let failAllowed = true;
    let now = 1_500;
    let generated = 0;
    const client = createOpenCookie({
      broadcast: (effect) =>
        failAllowed && accessOf(effect) === "allowed"
          ? Promise.reject(new Error("replacement signal unavailable"))
          : Promise.resolve(),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      grantActivation: "pending",
      pendingGrant: { transitionId: "transition-replacement" },
      record: { recordId: base.recordId, revision: 1 },
    });
    failAllowed = false;
    now = 2_000;

    await expect(client.rejectAll()).resolves.toMatchObject({
      effect: {
        record: {
          method: "reject-all",
          recordId: base.recordId,
          revision: 2,
        },
      },
      outcome: "committed",
    });
    expect(memory.stored()).toMatchObject({
      record: {
        method: "reject-all",
        recordId: base.recordId,
        revision: 2,
      },
    });
    expect(memory.stored()).not.toHaveProperty("pendingGrant");
  });

  it("resumes a future-dated pending grant when the local clock is behind", async () => {
    const candidate = grantRecord({
      decidedAt: 2_000,
      expiresAt: 86_402_000,
    });
    const memory = exactStateStore({
      pendingGrant: {
        candidate,
        kind: "decision",
        receiptOccurredAt: 2_100,
        transitionId: "transition-future-pending",
      },
    });
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: () => "must-not-generate",
      now: () => 1_000,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      grantActivation: "active",
      preferencesOpen: false,
      record: { decidedAt: 2_000, revision: 1 },
      runtime: { consentEvaluation: { prompt: false, status: "active" } },
    });
    expect(memory.stored()).toEqual({ record: candidate });

    client.openPreferences();
    await expect(client.rejectAll()).resolves.toMatchObject({
      effect: {
        record: { decidedAt: 2_100, method: "reject-all", revision: 2 },
      },
      outcome: "committed",
    });
  });

  it("stages one restore marker and coalesces initialize with retry", async () => {
    const active = grantRecord();
    const memory = exactStateStore({ record: active });
    const releaseBroadcast = deferred();
    const receipt = vi.fn(() => Promise.resolve());
    let observedSnapshot: OpenCookieSnapshot | undefined;
    const broadcast = vi.fn(() => {
      observedSnapshot = client.getSnapshot();
      return releaseBroadcast.promise;
    });
    const client: OpenCookie = createOpenCookie({
      broadcast,
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "transition" ? "transition-restore" : "unexpected-record",
      now: () => 2_000,
      receipt,
      ...runtimePolicy(),
      store: memory.store,
    });

    const firstInitialization = client.initialize();
    const secondInitialization = client.initialize();
    expect(firstInitialization).toBe(secondInitialization);
    await vi.waitFor(
      () => {
        expect(broadcast).toHaveBeenCalledTimes(1);
      },
      { timeout: 1_000 },
    );
    const concurrentRetry = client.retryPendingGrant();

    try {
      expect(observedSnapshot).toMatchObject({
        grantActivation: "pending",
        pendingGrant: {
          phase: "broadcast",
          transitionId: "transition-restore",
        },
        record: { recordId: "record-1", revision: 1 },
        runtime: {
          effectiveAccess: {
            resources: [{ access: "blocked", resourceId: "analytics-script" }],
          },
        },
      });
      expect(memory.stored()).toEqual({
        pendingGrant: { kind: "restore", transitionId: "transition-restore" },
        record: active,
      });
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(receipt).not.toHaveBeenCalled();
    } finally {
      releaseBroadcast.resolve();
    }

    const [firstSnapshot, secondSnapshot, retryResult] = await Promise.all([
      firstInitialization,
      secondInitialization,
      concurrentRetry,
    ]);
    expect(firstSnapshot).toBe(secondSnapshot);
    expect(firstSnapshot).toMatchObject({
      grantActivation: "active",
      record: { recordId: "record-1", revision: 1 },
    });
    expect(retryResult).toMatchObject({
      outcome: "committed",
      transition: { transitionId: "transition-restore" },
    });
    expect(memory.writes()).toEqual([
      {
        pendingGrant: { kind: "restore", transitionId: "transition-restore" },
        record: active,
      },
      { record: active },
    ]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(receipt).not.toHaveBeenCalled();
  });

  it("retries a failed restore when the user repeats its exact choice", async () => {
    const active = grantRecord();
    const memory = exactStateStore({ record: active });
    const retryStarted = deferred();
    const releaseRetry = deferred();
    let allowedBroadcasts = 0;
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const idGenerator = vi.fn((kind: "record" | "transition") =>
      kind === "transition" ? "transition-restore-choice" : "unexpected-record",
    );
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        if (accessOf(effect) !== "allowed") return Promise.resolve();
        allowedBroadcasts += 1;
        if (allowedBroadcasts === 1) {
          return Promise.reject(new Error("restore signal unavailable"));
        }
        retryStarted.resolve();
        return releaseRetry.promise;
      },
      consentDurationMs: 86_400_000,
      idGenerator,
      now: () => 2_000,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      grantActivation: "pending",
      pendingGrant: {
        phase: "broadcast",
        transitionId: "transition-restore-choice",
      },
    });
    expect(memory.stored()).toEqual({
      pendingGrant: {
        kind: "restore",
        transitionId: "transition-restore-choice",
      },
      record: active,
    });

    const retry = client.acceptAll();
    await retryStarted.promise;
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: {
        transitionId: "transition-restore-choice",
      },
    });
    expect(memory.stored()).toHaveProperty(
      "pendingGrant.transitionId",
      "transition-restore-choice",
    );
    releaseRetry.resolve();

    await expect(retry).resolves.toMatchObject({
      outcome: "committed",
      transition: { transitionId: "transition-restore-choice" },
    });
    expect(memory.stored()).toEqual({ record: active });
    expect(
      effects.filter((effect) => accessOf(effect) === "allowed"),
    ).toHaveLength(2);
    expect(idGenerator).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed restoration context expired during its retry", async () => {
    const active = grantRecord();
    const memory = exactStateStore({
      pendingGrant: {
        kind: "restore",
        transitionId: "transition-restore-context",
      },
      record: active,
    });
    const retryBroadcastStarted = deferred();
    const releaseRetryBroadcast = deferred();
    const firstFailure = new Error("first restoration signal failed");
    let intendedBroadcasts = 0;
    let staleContext: OpenCookiePortContext | undefined;
    let retryContext: OpenCookiePortContext | undefined;
    let staleDuringRetry: Promise<unknown> | undefined;
    const client = createOpenCookie({
      broadcast: (effect, context) => {
        if (
          effect.record.method !== "accept-all" ||
          accessOf(effect) !== "allowed"
        ) {
          return Promise.resolve();
        }
        intendedBroadcasts += 1;
        if (intendedBroadcasts === 1) {
          staleContext = context;
          return Promise.reject(firstFailure);
        }
        retryContext = context;
        staleDuringRetry = staleContext?.rejectAll().then(
          (result) => result,
          (error: unknown) => error,
        );
        retryBroadcastStarted.resolve();
        return releaseRetryBroadcast.promise;
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => "must-not-generate",
      now: () => 2_000,
      ...runtimePolicy(),
      store: memory.store,
    });

    const initialized = await client.initialize();
    if (staleContext === undefined) {
      throw new Error("The failed restoration must expose its port context.");
    }
    const expiredOutside = await staleContext.rejectAll().then(
      (result) => result,
      (error: unknown) => error,
    );
    const retry = client.retryPendingGrant();
    await retryBroadcastStarted.promise;
    if (staleDuringRetry === undefined) {
      throw new Error("The retry must exercise the stale context.");
    }
    const staleRetryOutcome = await staleDuringRetry;
    releaseRetryBroadcast.resolve();
    const retryResult = await retry;

    expect(initialized).toMatchObject({
      grantActivation: "pending",
      pendingGrant: {
        phase: "broadcast",
        transitionId: "transition-restore-context",
      },
    });
    expect(expiredOutside).toEqual(
      new Error("OpenCookie port context is no longer active."),
    );
    expect(staleRetryOutcome).toEqual(
      new Error("OpenCookie port context is no longer active."),
    );
    expect(retryContext).not.toBe(staleContext);
    expect(retryResult).toMatchObject({
      outcome: "committed",
      transition: { transitionId: "transition-restore-context" },
    });
    expect(memory.stored()).toEqual({ record: active });
  });

  it.each([
    ["reject", "awaited"],
    ["withdraw", "awaited"],
    ["reject", "detached"],
    ["withdraw", "detached"],
  ] as const)(
    "settles a %s issued through the initializing restore context when %s",
    async (terminalKind, mode) => {
      const active = grantRecord();
      const memory = exactStateStore({ record: active });
      let terminal:
        | ReturnType<OpenCookiePortContext["rejectAll"]>
        | ReturnType<OpenCookiePortContext["withdrawConsent"]>
        | undefined;
      const client: OpenCookie = createOpenCookie({
        broadcast: async (effect, context) => {
          if (
            effect.record.method === "accept-all" &&
            accessOf(effect) === "allowed" &&
            context !== undefined &&
            terminal === undefined
          ) {
            terminal =
              terminalKind === "reject"
                ? context.rejectAll()
                : context.withdrawConsent();
            if (mode === "awaited") await terminal;
          }
        },
        consentDurationMs: 86_400_000,
        idGenerator: (kind) =>
          kind === "transition" ? "transition-restore" : "unexpected-record",
        now: () => 2_000,
        ...runtimePolicy(),
        store: memory.store,
      });

      const settled = await Promise.race([
        client.initialize().then(() => "initialized" as const),
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => {
            resolve("timed-out");
          }, 200);
        }),
      ]);
      expect(settled).toBe("initialized");
      if (terminal === undefined) {
        throw new Error("The restore broadcast must expose its port context.");
      }
      await expect(terminal).resolves.toMatchObject({ outcome: "committed" });
      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      expect(memory.stored()?.record).toMatchObject({ method: terminalMethod });
      expect(client.getSnapshot().record).toMatchObject({
        method: terminalMethod,
      });
      expect(client.getSnapshot().pendingGrant).toBeUndefined();
    },
  );

  it("expires a detached terminal after the final restore reconcile", async () => {
    const active = grantRecord();
    const memory = exactStateStore({ record: active });
    const terminalInvoked = deferred();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipts: unknown[] = [];
    const transitions = ["transition-restore", "transition-terminal"];
    let terminal: Promise<unknown> | undefined;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "transition"
          ? (transitions.shift() ?? "unexpected-transition")
          : "unexpected-record",
      now: () => 2_000,
      receipt: (value) => {
        receipts.push(value);
        return Promise.resolve();
      },
      reconcile: (effect, context) => {
        effects.push(effect);
        if (
          effect.transitionId === "transition-restore" &&
          accessOf(effect) === "allowed"
        ) {
          queueMicrotask(() => {
            queueMicrotask(() => {
              terminal = context?.rejectAll().then(
                (result) => result,
                (error: unknown) => error,
              );
              terminalInvoked.resolve();
            });
          });
        }
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });

    const initialization = client.initialize();
    await terminalInvoked.promise;
    if (terminal === undefined) {
      throw new Error("Restore reconcile must attempt its detached context.");
    }
    const [snapshot, terminalResult] = await Promise.all([
      initialization,
      terminal,
    ]);

    expect(terminalResult).toEqual(
      new Error("OpenCookie port context is no longer active."),
    );
    expect(snapshot).toMatchObject({
      grantActivation: "active",
      record: { method: "accept-all", recordId: "record-1" },
    });
    expect(memory.stored()).toEqual({ record: active });
    expect(
      effects.some((effect) => effect.record.method === "reject-all"),
    ).toBe(false);
    expect(receipts).toEqual([]);
  });

  it.each(["awaited", "synchronous"] as const)(
    "grants again after an executor withdrawal when %s",
    async (sequencing) => {
      const memory = exactStateStore({ record: grantRecord() });
      let generated = 0;
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String((generated += 1))}`,
        now: () => now,
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();

      now = 1_500;
      const withdrawal = client.withdrawConsent();
      if (sequencing === "awaited") {
        await expect(withdrawal).resolves.toMatchObject({
          outcome: "committed",
        });
        now = 2_000;
      }
      const regrant = client.acceptAll();
      await expect(withdrawal).resolves.toMatchObject({
        outcome: "committed",
      });
      await expect(regrant).resolves.toMatchObject({
        outcome: "committed",
        transition: { record: { method: "accept-all", revision: 3 } },
      });
      expect(memory.stored()).toMatchObject({
        record: {
          decisions: { analytics: "granted", personalization: "granted" },
          method: "accept-all",
          revision: 3,
        },
      });
      expect(memory.stored()?.pendingGrant).toBeUndefined();
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        record: { method: "accept-all", revision: 3 },
        runtime: { consentEvaluation: { status: "active" } },
      });
    },
  );

  it.each([
    ["reject", "accept-all"],
    ["reject", "granular"],
    ["withdraw", "accept-all"],
    ["withdraw", "granular"],
  ] as const)(
    "grants %s terminal then %s after its persistence failed",
    async (terminalKind, grantKind) => {
      const memory = exactStateStore({ record: grantRecord() });
      let failing = true;
      const store: DecisionStore = {
        ...memory.store,
        compareAndSet: (expected, candidate) =>
          failing
            ? Promise.reject(new Error("write unavailable"))
            : memory.store.compareAndSet(expected, candidate),
      };
      let generated = 0;
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String((generated += 1))}`,
        now: () => now,
        ...runtimePolicy(),
        store,
      });
      await client.initialize();

      now = 1_500;
      await expect(
        terminalKind === "reject"
          ? client.rejectAll()
          : client.withdrawConsent(),
      ).resolves.toMatchObject({
        diagnostics: [{ code: "denial-persistence-failed" }],
        outcome: "degraded",
      });
      expect(memory.stored()).toBeNull();
      expect(client.getSnapshot().lastPersistenceStatus).toBe("failed");

      failing = false;
      now = 2_000;
      const grant =
        grantKind === "accept-all"
          ? client.acceptAll()
          : client.savePreferences(["analytics"]);
      await expect(grant).resolves.toMatchObject({
        outcome: "committed",
        transition: { record: { method: grantKind } },
      });
      expect(memory.stored()).toMatchObject({
        record: { method: grantKind },
      });
      expect(memory.stored()?.pendingGrant).toBeUndefined();
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        lastPersistenceStatus: "confirmed",
        record: { method: grantKind },
        runtime: { consentEvaluation: { status: "active" } },
      });
    },
  );

  it.each(["accept-all", "granular"] as const)(
    "replaces a staging-failed grant with %s after a terminal whose persistence failed",
    async (grantKind) => {
      const memory = exactStateStore({ record: grantRecord() });
      let now = 1_000;
      const store: DecisionStore = {
        ...memory.store,
        compareAndSet: (expected, candidate) =>
          now < 2_500
            ? Promise.reject(new Error("write unavailable"))
            : memory.store.compareAndSet(expected, candidate),
      };
      let generated = 0;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String((generated += 1))}`,
        now: () => now,
        ...runtimePolicy(),
        store,
      });
      await client.initialize();

      now = 1_500;
      await expect(client.withdrawConsent()).resolves.toMatchObject({
        outcome: "degraded",
      });
      expect(memory.stored()).toBeNull();
      now = 2_000;
      await expect(
        client.savePreferences(["personalization"]),
      ).resolves.toMatchObject({
        diagnostics: [{ code: "grant-write-failed" }],
        outcome: "pending",
      });
      expect(memory.stored()).toBeNull();
      expect(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      now = 2_500;
      const grant =
        grantKind === "accept-all"
          ? client.acceptAll()
          : client.savePreferences(["analytics"]);
      await expect(grant).resolves.toMatchObject({
        outcome: "committed",
        transition: { record: { method: grantKind, revision: 3 } },
      });
      expect(memory.stored()).toMatchObject({
        record: { method: grantKind, revision: 3 },
      });
      expect(memory.stored()?.pendingGrant).toBeUndefined();
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        lastPersistenceStatus: "confirmed",
        record: { method: grantKind, revision: 3 },
      });
      await expect(client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "not-applicable",
      });
    },
  );

  it.each([
    ["personalization", "analytics"],
    ["analytics", "personalization"],
  ] as const)(
    "stacks a %s grant on a staged %s grant after a terminal that could neither persist nor clear",
    async (secondPurpose, firstPurpose) => {
      const memory = exactStateStore({ record: grantRecord() });
      let now = 1_000;
      const store: DecisionStore = {
        ...memory.store,
        clearIfCurrent: (expected) =>
          now < 2_000
            ? Promise.reject(new Error("clear unavailable"))
            : memory.store.clearIfCurrent(expected),
        compareAndSet: (expected, candidate) =>
          now < 2_000
            ? Promise.reject(new Error("write unavailable"))
            : memory.store.compareAndSet(expected, candidate),
      };
      let generated = 0;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String((generated += 1))}`,
        now: () => now,
        ...runtimePolicy(),
        store,
      });
      await client.initialize();

      now = 1_500;
      await expect(client.rejectAll()).resolves.toMatchObject({
        diagnostics: [
          { code: "denial-persistence-failed" },
          { code: "denial-clear-failed" },
        ],
        outcome: "degraded",
      });
      expect(memory.stored()).toMatchObject({
        record: { method: "accept-all", revision: 1 },
      });

      now = 2_000;
      const first = client.savePreferences([firstPurpose]);
      const second = client.savePreferences([secondPurpose]);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(["committed", "invalidated"]).toContain(firstResult.outcome);
      expect(secondResult).toMatchObject({
        outcome: "committed",
        transition: {
          record: {
            decisions: { [secondPurpose]: "granted" },
            method: "granular",
            recordId: "record-1",
          },
        },
      });
      expect(memory.stored()).toMatchObject({
        record: {
          decisions: { [secondPurpose]: "granted" },
          method: "granular",
          recordId: "record-1",
        },
      });
      expect(memory.stored()?.pendingGrant).toBeUndefined();
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        lastPersistenceStatus: "confirmed",
        record: { method: "granular", recordId: "record-1" },
      });
      await expect(client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "not-applicable",
      });
    },
  );

  it("retries initialization after a transient store read fault", async () => {
    const memory = exactStateStore({ record: grantRecord() });
    let failing = true;
    const store: DecisionStore = {
      ...memory.store,
      read: () =>
        failing
          ? Promise.reject(new Error("storage unavailable"))
          : memory.store.read(),
    };
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      ...runtimePolicy(),
      store,
    });

    await expect(client.initialize()).rejects.toThrow("storage unavailable");
    await expect(client.rejectAll()).rejects.toThrow("storage unavailable");

    failing = false;
    const snapshot = await client.initialize();
    expect(snapshot).toMatchObject({
      readiness: "ready",
      record: { method: "accept-all" },
      runtime: { consentEvaluation: { status: "active" } },
    });
    await expect(client.withdrawConsent()).resolves.toMatchObject({
      outcome: "committed",
    });
  });

  it.each([
    ["awaited", 0],
    ["detached", 0],
    ["awaited", 3],
    ["detached", 3],
  ] as const)(
    "settles a terminal crossing an aftercare boundary with a %s corrective context call after %i microtasks",
    async (contextUse, microtasks) => {
      const memory = exactStateStore({
        record: grantRecord({ expiresAt: 10_000 }),
      });
      const grantReconcileStarted = deferred();
      const releaseGrantReconcile = deferred();
      let armed = false;
      let reconcileParked = false;
      let corrective:
        ReturnType<OpenCookiePortContext["rejectAll"]> | undefined;
      let generated = 0;
      let now = 9_999;
      const client = createOpenCookie({
        broadcast: async (effect, context) => {
          if (
            armed &&
            effect.record.method === "granular" &&
            effect.persistenceStatus === "pending" &&
            context !== undefined &&
            corrective === undefined
          ) {
            corrective = context.rejectAll();
            if (contextUse === "awaited") {
              await corrective.catch(() => undefined);
            } else {
              void corrective.catch(() => undefined);
            }
          }
        },
        consentDurationMs: 9_000,
        idGenerator: (kind) => `${kind}-${String((generated += 1))}`,
        now: () => now,
        reconcile: (effect) => {
          if (
            armed &&
            effect.record.method === "accept-all" &&
            !reconcileParked
          ) {
            reconcileParked = true;
            grantReconcileStarted.resolve();
            return releaseGrantReconcile.promise;
          }
          return Promise.resolve();
        },
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();
      armed = true;
      const settleWithin = async <Result>(
        promise: Promise<Result>,
        label: string,
      ): Promise<Result> => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                reject(new Error(`${label} did not settle within 250ms.`));
              }, 250);
            }),
          ]);
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      };
      const tick = () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

      now = 10_000;
      const activated = client.acceptAll();
      await settleWithin(grantReconcileStarted.promise, "grant reconcile");
      now = 10_010;
      const queuedGrant = client.savePreferences(["analytics"]);
      await tick();
      now = 10_020;
      const withdrawal = client.withdrawConsent();
      await tick();
      now = 10_030;
      releaseGrantReconcile.resolve();
      for (let step = 0; step < microtasks; step += 1) {
        await Promise.resolve();
      }
      const rejection = client.rejectAll();

      const [, , , rejectionResult] = await settleWithin(
        Promise.all([activated, queuedGrant, withdrawal, rejection]),
        "terminals crossing the aftercare boundary",
      );
      expect(rejectionResult).toMatchObject({ outcome: "committed" });
      if (corrective === undefined) {
        throw new Error("The queued grant's corrective port must run.");
      }
      await settleWithin(
        corrective.catch(() => undefined),
        "corrective context terminal",
      );
      expect(memory.stored()?.record).toMatchObject({ method: "reject-all" });
      expect(client.getSnapshot().record).toMatchObject({
        method: "reject-all",
      });
      await expect(
        settleWithin(client.refresh(), "post-terminal refresh"),
      ).resolves.toBeDefined();
    },
  );

  it("restores a stored grant without ever opening preferences", async () => {
    const memory = exactStateStore({ record: grantRecord() });
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-restore-quiet`,
      now: () => 2_000,
      ...runtimePolicy(),
      store: memory.store,
    });
    const openedSnapshots: boolean[] = [];
    client.subscribe(() => {
      openedSnapshots.push(client.getSnapshot().preferencesOpen);
    });

    const snapshot = await client.initialize();

    expect(snapshot).toMatchObject({
      grantActivation: "active",
      preferencesOpen: false,
      record: { method: "accept-all" },
      runtime: { consentEvaluation: { prompt: false, status: "active" } },
    });
    expect(openedSnapshots.every((opened) => !opened)).toBe(true);
    expect(openedSnapshots.length).toBeGreaterThan(0);
  });

  it("resumes an existing restore marker without generating a new transition", async () => {
    const active = grantRecord();
    const memory = exactStateStore({
      pendingGrant: {
        kind: "restore",
        transitionId: "transition-restored-original",
      },
      record: active,
    });
    const idGenerator = vi.fn(() => "must-not-generate");
    const receipt = vi.fn(() => Promise.resolve());
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator,
      now: () => 2_000,
      receipt,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      grantActivation: "active",
    });

    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      events: [],
      transitionId: "transition-restored-original",
    });
    expect(memory.writes()).toEqual([{ record: active }]);
    expect(idGenerator).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });
});
