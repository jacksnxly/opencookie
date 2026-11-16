import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type DecisionStoreReadResult,
  type DecisionStoreWriteResult,
  type OpenCookieSnapshot,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../index.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type DefinedResourcePolicy,
  type PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";
import { persistedConsentStatesEqual } from "./persisted-consent-record.js";

type PersistedActiveDecisionRecord = Extract<
  PersistedDecisionRecord,
  { readonly withdrawnAt?: never }
>;

function runtimePolicy(): {
  readonly policySnapshot: PolicySnapshot;
  readonly resourcePolicy: DefinedResourcePolicy;
} {
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

function reconsentActivationPolicy(): {
  readonly current: PolicySnapshot;
  readonly previous: PolicySnapshot;
  readonly resourcePolicy: DefinedResourcePolicy;
} {
  const previousDefinition = definePolicy(
    completeTestPolicyDefinition({
      purposes: [{ disclosure: "Original disclosure", id: "analytics" }],
    }),
  );
  const currentDefinition = definePolicy(
    completeTestPolicyDefinition({
      purposes: [{ disclosure: "Changed disclosure", id: "analytics" }],
    }),
  );
  if (!previousDefinition.ok || !currentDefinition.ok) {
    throw new Error("Policies must be valid.");
  }
  const previous = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: previousDefinition.policy,
    policyVersion: "policy-1",
  });
  const current = createPolicySnapshot({
    catalogueRevision: "catalogue-2",
    policy: currentDefinition.policy,
    policyVersion: "policy-2",
  });
  const resources = defineResourcePolicy({
    policy: currentDefinition.policy,
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
  return { current, previous, resourcePolicy: resources.resourcePolicy };
}

function persistedGrant(
  snapshot: PolicySnapshot,
  expiresAt = 10_000,
): PersistedActiveDecisionRecord {
  return {
    catalogueDigest: snapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted" },
    expiresAt,
    method: "accept-all",
    policyVersion: snapshot.policyVersion,
    recordId: "record-restored",
    revision: 1,
  };
}

function stateEquals(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

interface StoreObservation {
  readonly compareCount: number;
  readonly durable: PersistedConsentState | null;
  readonly readCount: number;
  readonly writes: readonly PersistedConsentState[];
}

interface ControlledStoreOptions {
  readonly compare?: (
    expected: PersistedConsentState | null,
    candidate: PersistedConsentState,
    observation: StoreObservation,
  ) =>
    | DecisionStoreWriteResult
    | Promise<DecisionStoreWriteResult | undefined>
    | undefined;
  readonly read?: (
    observation: StoreObservation,
  ) => DecisionStoreReadResult | Promise<DecisionStoreReadResult> | undefined;
}

function controlledStore(
  initial: PersistedConsentState | null = null,
  options: ControlledStoreOptions = {},
): {
  readonly compareCount: () => number;
  readonly readCount: () => number;
  readonly replace: (state: PersistedConsentState | null) => void;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
  readonly writes: () => readonly PersistedConsentState[];
} {
  let durable = initial;
  let compareCount = 0;
  let readCount = 0;
  const writes: PersistedConsentState[] = [];
  const observation = (): StoreObservation => ({
    compareCount,
    durable,
    readCount,
    writes,
  });

  return {
    compareCount: () => compareCount,
    readCount: () => readCount,
    replace: (state) => {
      durable = state;
    },
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (durable === null) return Promise.resolve("cleared" as const);
        if (!stateEquals(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: async (expected, candidate) => {
        compareCount += 1;
        writes.push(candidate);
        const overridden = await options.compare?.(
          expected,
          candidate,
          observation(),
        );
        if (overridden !== undefined) return overridden;
        if (!stateEquals(durable, expected)) {
          return { status: "conflict" as const };
        }
        durable = candidate;
        return { status: "written" as const };
      },
      read: async () => {
        readCount += 1;
        const overridden = await options.read?.(observation());
        if (overridden !== undefined) return overridden;
        return durable === null
          ? { status: "missing" as const }
          : { state: durable, status: "stored" as const };
      },
    },
    stored: () => durable,
    writes: () => writes,
  };
}

function accessOf(effect: ConsentRuntimeTransitionEffect): string | undefined {
  return effect.runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  )?.access;
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

describe("createOpenCookie pending grant activation barrier", () => {
  it("uses exact pending state as the activation precondition and notifies after independent aftercare", async () => {
    const order: string[] = [];
    const memory = controlledStore(null, {
      compare: (expected, candidate, { compareCount, durable }) => {
        order.push(`cas-${String(compareCount)}`);
        if (compareCount === 2) {
          const staged = memory.writes()[0];
          expect(staged).toBeDefined();
          expect(expected).toEqual(staged);
          expect(stateEquals(expected, staged ?? null)).toBe(true);
          expect(candidate).toEqual({
            record:
              staged?.pendingGrant?.kind === "decision"
                ? staged.pendingGrant.candidate
                : undefined,
          });
        }
        if (!stateEquals(durable, expected)) {
          return { status: "conflict" as const };
        }
        return undefined;
      },
      read: ({ readCount }) => {
        order.push(`read-${String(readCount)}`);
        return undefined;
      },
    });
    const receipts: unknown[] = [];
    const holder: { client?: ReturnType<typeof createOpenCookie> } = {};
    const client = createOpenCookie({
      broadcast: (effect) => {
        order.push("broadcast-intended");
        expect(accessOf(effect)).toBe("allowed");
        expect(effect.events).toEqual([]);
        expect(holder.client?.getSnapshot()).toMatchObject({
          grantActivation: "pending",
          runtime: {
            effectiveAccess: {
              resources: [
                { access: "blocked", resourceId: "analytics-script" },
              ],
            },
          },
        });
        return Promise.resolve();
      },
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_000,
      receipt: (receipt) => {
        order.push("receipt");
        receipts.push(receipt);
        expect(holder.client?.getSnapshot().grantActivation).toBe("active");
        return Promise.resolve();
      },
      reconcile: (effect) => {
        order.push("reconcile-active");
        expect(accessOf(effect)).toBe("allowed");
        expect(holder.client?.getSnapshot().grantActivation).toBe("active");
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    holder.client = client;
    await client.initialize();
    order.length = 0;
    client.subscribe(() => {
      order.push(`notify-${client.getSnapshot().grantActivation}`);
    });

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      effect: {
        events: [{ type: "ConsentRecordCreated" }, { type: "ConsentGranted" }],
        persistenceStatus: "confirmed",
      },
      outcome: "committed",
      transition: { persistenceStatus: "confirmed" },
    });
    expect(order).toEqual([
      "cas-1",
      "read-2",
      "notify-pending",
      "broadcast-intended",
      "read-3",
      "cas-2",
      "read-4",
      "reconcile-active",
      "receipt",
      "notify-active",
    ]);
    expect(memory.stored()).toMatchObject({
      record: {
        method: "accept-all",
        recordId: "record-1",
        revision: 1,
      },
    });
    expect(memory.stored()).not.toHaveProperty("pendingGrant");
    expect(receipts).toEqual([
      expect.objectContaining({
        occurredAt: 1_000,
        persistenceStatus: "confirmed",
        transitionId: "transition-1",
      }),
    ]);
  });

  it("keeps the staged descriptor detached from caller mutations and uses a monotonic fresh time", async () => {
    const runtime = runtimePolicy();
    const mutablePolicy = {
      ...runtime.policySnapshot,
      policy: runtime.policySnapshot.policy,
    } as PolicySnapshot;
    const mutableResources = {
      ...runtime.resourcePolicy,
      purposeIds: [...runtime.resourcePolicy.purposeIds],
      resources: runtime.resourcePolicy.resources,
      services: runtime.resourcePolicy.services,
    } as DefinedResourcePolicy;
    const memory = controlledStore();
    let now = 1_000;
    let intended: ConsentRuntimeTransitionEffect | undefined;
    const client = createOpenCookie({
      broadcast: (effect) => {
        intended = effect;
        expect(Object.isFrozen(effect)).toBe(true);
        expect(Object.isFrozen(effect.runtime)).toBe(true);
        (mutablePolicy as { policyVersion: string }).policyVersion =
          "mutated-policy";
        (
          mutableResources as unknown as { purposeIds: string[] }
        ).purposeIds[0] = "mutated-purpose";
        now = 500;
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-detached`,
      now: () => now,
      policySnapshot: mutablePolicy,
      resourcePolicy: mutableResources,
      store: memory.store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      effect: {
        record: {
          policy: { policyVersion: "policy-1" },
        },
        runtime: {
          consentEvaluation: { status: "active" },
        },
      },
      outcome: "committed",
    });
    expect(intended).toMatchObject({
      record: { policy: { policyVersion: "policy-1" } },
      runtime: {
        accessPolicy: { valid: true },
        consentEvaluation: { status: "active" },
      },
    });
    expect(memory.writes()[0]).toMatchObject({
      pendingGrant: {
        candidate: {
          policyVersion: "policy-1",
          recordId: "record-detached",
        },
        receiptOccurredAt: 1_000,
        transitionId: "transition-detached",
      },
    });
  });

  it("captures the clock function once, preserves its receiver, and ignores replacement after staging", async () => {
    const memory = controlledStore();
    let replacementCalls = 0;
    const options = {
      activationTime: 1_000,
      broadcast: () => {
        options.activationTime = 1_001;
        options.now = () => {
          replacementCalls += 1;
          return Number.NaN;
        };
        return Promise.resolve();
      },
      clockCalls: 0,
      consentDurationMs: 10_000,
      idGenerator: (kind: "record" | "transition") => `${kind}-clock`,
      now() {
        this.clockCalls += 1;
        return this.activationTime;
      },
      ...runtimePolicy(),
      store: memory.store,
    };
    const client = createOpenCookie(options);
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "committed",
    });
    expect(options.clockCalls).toBe(4);
    expect(replacementCalls).toBe(0);
  });

  it("invalidates exactly at expiry, corrects the signal, and never attempts activation", async () => {
    const memory = controlledStore();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const reconcile = vi.fn((effect: ConsentRuntimeTransitionEffect) => {
      expect(effect).toBeDefined();
      return Promise.resolve();
    });
    const receipt = vi.fn(() => Promise.resolve());
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        if (effects.length === 1) now = 2_000;
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-expiry`,
      now: () => now,
      receipt,
      reconcile,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      effect: {
        events: [],
        runtime: {
          effectiveAccess: {
            resources: [{ access: "blocked", resourceId: "analytics-script" }],
          },
        },
      },
      outcome: "invalidated",
    });
    expect(memory.compareCount()).toBe(1);
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const correction = reconcile.mock.calls[0]?.[0];
    expect(correction).toBeDefined();
    if (correction === undefined) throw new Error("Correction must reconcile.");
    expect(accessOf(correction)).toBe("blocked");
    expect(receipt).not.toHaveBeenCalled();
    expect(client.getSnapshot().grantActivation).toBe("pending");
  });

  it("samples fresh time after the activation precondition read crosses expiry", async () => {
    let now = 1_000;
    const memory = controlledStore(null, {
      read: ({ readCount }) => {
        if (readCount === 3) now = 2_000;
        return undefined;
      },
    });
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const reconcile = vi.fn(() => Promise.resolve());
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-expiry-race`,
      now: () => now,
      reconcile,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      effect: { events: [] },
      outcome: "invalidated",
    });
    expect(memory.compareCount()).toBe(1);
    expect(memory.stored()).toHaveProperty("pendingGrant");
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("invalidates an unverifiable editorial catalogue digest before activation", async () => {
    const runtime = runtimePolicy();
    const memory = controlledStore();
    const client = createOpenCookie({
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-catalogue-only`,
      now: () => 1_000,
      policySnapshot: {
        ...runtime.policySnapshot,
        catalogueDigest: "editorial-catalogue-only",
      },
      resourcePolicy: runtime.resourcePolicy,
      store: memory.store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-policy-mismatch-before-activation" }],
      effect: {
        record: {
          policy: { catalogueDigest: "editorial-catalogue-only" },
        },
      },
      outcome: "invalidated",
    });
    expect(memory.compareCount()).toBe(1);
    expect(memory.stored()).toMatchObject({
      pendingGrant: {
        candidate: { catalogueDigest: "editorial-catalogue-only" },
      },
    });
  });

  it("invalidates a captured resource-policy mismatch", async () => {
    const runtime = runtimePolicy();
    const invalidResources = {
      ...runtime.resourcePolicy,
      purposeIds: ["analytics"],
    } as DefinedResourcePolicy;
    const memory = controlledStore();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-policy`,
      now: () => 1_000,
      policySnapshot: {
        ...runtime.policySnapshot,
        catalogueDigest: "editorial-catalogue-only",
      },
      reconcile: () => Promise.resolve(),
      resourcePolicy: invalidResources,
      store: memory.store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-policy-mismatch-before-activation" }],
      effect: { events: [] },
      outcome: "invalidated",
    });
    expect(memory.compareCount()).toBe(1);
    expect(effects).toHaveLength(2);
    expect(effects[1]).toMatchObject({
      events: [],
      record: {
        policy: { catalogueDigest: "editorial-catalogue-only" },
      },
    });
  });

  it("corrects stale A before the intended signal for superseding B", async () => {
    const memory = controlledStore();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const releaseSecond = deferred();
    const order: string[] = [];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        const access = accessOf(effect);
        if (effect.transitionId === "transition-a" && access === "allowed") {
          order.push("A intended");
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        if (effect.transitionId === "transition-a") {
          order.push("A correction");
          return Promise.resolve();
        }
        order.push("B intended");
        secondStarted.resolve();
        return releaseSecond.promise;
      },
      consentDurationMs: 10_000,
      idGenerator: (() => {
        const ids = ["record-1", "transition-a", "transition-b"];
        return () => ids.shift() ?? "unexpected-id";
      })(),
      now: () => now,
      reconcile: (effect) => {
        order.push(
          `${effect.transitionId === "transition-a" ? "A" : "B"} reconcile ${accessOf(effect) ?? "missing"}`,
        );
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const first = client.acceptAll();
    await firstStarted.promise;
    now = 2_000;
    const second = client.savePreferences(["analytics"]);
    await vi.waitFor(() => {
      expect(memory.compareCount()).toBe(2);
    });
    releaseFirst.resolve();
    await secondStarted.promise;

    await expect(first).resolves.toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      effect: { events: [] },
      outcome: "invalidated",
    });
    expect(order).toEqual([
      "A intended",
      "A correction",
      "A reconcile blocked",
      "B intended",
    ]);

    releaseSecond.resolve();
    await expect(second).resolves.toMatchObject({ outcome: "committed" });
    expect(memory.stored()).toMatchObject({
      record: { method: "granular", revision: 1 },
    });
  });

  it("corrects and reconciles independently after a partially applied broadcaster rejects", async () => {
    const memory = controlledStore();
    const order: string[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    let broadcastCount = 0;
    const client = createOpenCookie({
      broadcast: (effect) => {
        broadcastCount += 1;
        order.push(
          broadcastCount === 1
            ? `intended ${accessOf(effect) ?? "missing"}`
            : `correction ${accessOf(effect) ?? "missing"}`,
        );
        return Promise.reject(new Error("partial composite failure"));
      },
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-partial`,
      now: () => 1_000,
      receipt,
      reconcile: (effect) => {
        order.push(`reconcile ${accessOf(effect) ?? "missing"}`);
        return Promise.reject(new Error("blocked enforcement failed"));
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [
        { code: "grant-signal-broadcast-failed" },
        { code: "grant-corrective-signal-failed" },
        { code: "grant-corrective-reconcile-failed" },
      ],
      effect: {
        events: [],
        runtime: {
          effectiveAccess: {
            resources: [{ access: "blocked", resourceId: "analytics-script" }],
          },
        },
        transitionId: "transition-partial",
      },
      outcome: "pending",
    });
    expect(order).toEqual([
      "intended allowed",
      "correction blocked",
      "reconcile blocked",
    ]);
    expect(receipt).not.toHaveBeenCalled();
    expect(memory.stored()).toHaveProperty("pendingGrant");
  });

  it("returns pending and corrects when the activation CAS is ambiguous", async () => {
    const memory = controlledStore(null, {
      compare: (_expected, _candidate, { compareCount }) =>
        compareCount === 2
          ? { status: "readback-mismatch" as const }
          : undefined,
    });
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const reconcile = vi.fn(() => Promise.resolve());
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-ambiguous`,
      now: () => 1_000,
      reconcile,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-activation-unconfirmed" }],
      effect: { events: [] },
      outcome: "pending",
    });
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().grantActivation).toBe("pending");
  });

  it.each(["mismatch", "throwing"] as const)(
    "removes an active grant after a lost %s activation acknowledgement",
    async (mode) => {
      let durable: PersistedConsentState | null = null;
      let compareCount = 0;
      let readCount = 0;
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (durable === null || !stateEquals(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          compareCount += 1;
          if (!stateEquals(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          if (compareCount === 2) {
            if (mode === "throwing") {
              throw new Error("activation acknowledgement unavailable");
            }
            return Promise.resolve({ status: "readback-mismatch" as const });
          }
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          readCount += 1;
          if (mode === "throwing" && compareCount === 2 && readCount === 4) {
            throw new Error("activation recovery read unavailable");
          }
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          );
        },
      };
      const effects: ConsentRuntimeTransitionEffect[] = [];
      const client = createOpenCookie({
        broadcast: (effect) => {
          effects.push(effect);
          return Promise.resolve();
        },
        consentDurationMs: 10_000,
        idGenerator: (kind) => `${kind}-lost-${mode}`,
        now: () => 1_000,
        reconcile: () => Promise.resolve(),
        ...runtimePolicy(),
        store,
      });
      await client.initialize();

      const result = await client.acceptAll();

      expect(result).toMatchObject({
        diagnostics: [{ code: "grant-activation-unconfirmed" }],
        outcome: "pending",
      });
      if (mode === "mismatch") {
        expect(compareCount).toBe(3);
        expect(durable).toMatchObject({
          pendingGrant: { transitionId: "transition-lost-mismatch" },
        });
      } else {
        expect(compareCount).toBe(2);
        expect(durable).toBeNull();
      }
      expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
      expect(client.getSnapshot().grantActivation).toBe("pending");
    },
  );

  it("restages a missing ambiguous activation on the first retry", async () => {
    let durable: PersistedConsentState | null = null;
    let compareCount = 0;
    let now = 1_000;
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (durable === null || !stateEquals(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        compareCount += 1;
        if (!stateEquals(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        if (compareCount === 2) {
          durable = null;
          return Promise.resolve({ status: "readback-mismatch" as const });
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
    };
    const client = createOpenCookie({
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-missing-activation`,
      now: () => now,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-activation-unconfirmed" }],
      outcome: "pending",
    });
    expect(durable).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      pendingGrant: { phase: "persistence" },
    });

    now = 2_000;
    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "committed",
      transition: { transitionId: "transition-missing-activation" },
    });
    expect(durable).toMatchObject({
      record: { method: "accept-all" },
    });
  });

  it.each(["missing", "cleared"] as const)(
    "stages only completed history after %s rollback",
    async (mode) => {
      const policy = runtimePolicy();
      const previous: PersistedActiveDecisionRecord = {
        ...persistedGrant(policy.policySnapshot),
        decisions: { analytics: "granted", personalization: "denied" },
        method: "granular",
      };
      let durable: PersistedConsentState | null = { record: previous };
      let ambiguous = false;
      let invalidRollbackReads = 0;
      const writes: PersistedConsentState[] = [];
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (durable === null || !stateEquals(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          writes.push(candidate);
          if (!stateEquals(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          if (
            ambiguous &&
            expected?.pendingGrant !== undefined &&
            candidate.pendingGrant === undefined
          ) {
            durable = mode === "missing" ? null : candidate;
            return Promise.resolve({ status: "readback-mismatch" as const });
          }
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          if (
            ambiguous &&
            mode === "cleared" &&
            durable?.pendingGrant === undefined &&
            durable?.record?.revision === 2 &&
            invalidRollbackReads < 2
          ) {
            invalidRollbackReads += 1;
            return Promise.resolve({
              reason: "malformed-json" as const,
              status: "invalid" as const,
            });
          }
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          );
        },
      };
      let generated = 0;
      const client = createOpenCookie({
        consentDurationMs: 10_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => 2_000,
        ...policy,
        store,
      });
      await client.initialize();
      ambiguous = true;

      await expect(
        client.savePreferences(["personalization"]),
      ).resolves.toMatchObject({
        diagnostics: [{ code: "grant-activation-unconfirmed" }],
        outcome: "pending",
      });
      expect(durable).toBeNull();
      ambiguous = false;
      const marker = writes.length;

      await expect(client.acceptAll()).resolves.toMatchObject({
        outcome: "committed",
      });
      const restaged = writes
        .slice(marker)
        .find(({ pendingGrant }) => pendingGrant?.kind === "decision");
      expect(restaged).toMatchObject({
        record: {
          decisions: previous.decisions,
          recordId: previous.recordId,
          revision: 1,
        },
        pendingGrant: {
          candidate: { recordId: previous.recordId, revision: 2 },
        },
      });
    },
  );

  it("rereads a conflict raced after the precondition check and diagnoses proven supersession", async () => {
    let durable: PersistedConsentState | null = null;
    let compareCount = 0;
    let readCount = 0;
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: () => Promise.resolve("conflict"),
      compareAndSet: (expected, candidate) => {
        compareCount += 1;
        if (!stateEquals(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        if (compareCount === 1) {
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        }
        const pending = durable?.pendingGrant;
        if (pending?.kind !== "decision") {
          throw new Error("Race fixture requires pending A.");
        }
        durable = {
          pendingGrant: {
            candidate: {
              catalogueDigest: pending.candidate.catalogueDigest,
              ...(pending.candidate.consentId === undefined
                ? {}
                : { consentId: pending.candidate.consentId }),
              decidedAt: pending.candidate.decidedAt + 1,
              decisionSurfaceDigest: pending.candidate.decisionSurfaceDigest,
              decisions: pending.candidate.decisions,
              expiresAt: pending.candidate.expiresAt + 1,
              ...(pending.candidate.locale === undefined
                ? {}
                : { locale: pending.candidate.locale }),
              method: "granular",
              policyVersion: pending.candidate.policyVersion,
              recordId: pending.candidate.recordId,
              revision: pending.candidate.revision,
            },
            kind: "decision",
            receiptOccurredAt: pending.receiptOccurredAt + 1,
            transitionId: "transition-b",
          },
        };
        return Promise.resolve({ status: "conflict" as const });
      },
      read: () => {
        readCount += 1;
        return Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const },
        );
      },
    };
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const reconcile = vi.fn(() => Promise.resolve());
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-a`,
      now: () => 1_000,
      reconcile,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      effect: { events: [] },
      outcome: "invalidated",
    });
    expect(readCount).toBe(6);
    expect(compareCount).toBe(2);
    expect(durable).toMatchObject({
      pendingGrant: { transitionId: "transition-b" },
    });
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["precondition", "known-predecessor"],
    ["post-conflict", "known-predecessor"],
    ["precondition", "unrelated-terminal"],
    ["post-conflict", "unrelated-terminal"],
  ] as const)(
    "%s activation conflict clears %s only when it is unsafe lineage",
    async (racePoint, replacementKind) => {
      const policy = runtimePolicy();
      const previous = {
        ...persistedGrant(policy.policySnapshot),
        decisions: { analytics: "granted", personalization: "denied" },
        method: "granular",
      } as PersistedDecisionRecord;
      const predecessor: PersistedConsentState = { record: previous };
      const terminal = {
        record: {
          ...previous,
          decidedAt: 1_500,
          decisions: { analytics: "denied", personalization: "denied" },
          method: "reject-all",
          revision: 2,
        },
      } as PersistedConsentState;
      const replacement =
        replacementKind === "known-predecessor" ? predecessor : terminal;
      let durable: PersistedConsentState | null = predecessor;
      let racing = false;
      let racingReads = 0;
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (durable === null || !stateEquals(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          if (!stateEquals(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          if (
            racing &&
            racePoint === "post-conflict" &&
            expected?.pendingGrant !== undefined &&
            candidate.pendingGrant === undefined
          ) {
            durable = replacement;
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          if (racing) {
            racingReads += 1;
            if (racePoint === "precondition" && racingReads === 2) {
              durable = replacement;
            }
          }
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          );
        },
      };
      let generated = 0;
      const effects: ConsentRuntimeTransitionEffect[] = [];
      const client = createOpenCookie({
        broadcast: (effect) => {
          effects.push(effect);
          return Promise.resolve();
        },
        consentDurationMs: 10_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => 2_000,
        reconcile: () => Promise.resolve(),
        ...policy,
        store,
      });
      await client.initialize();
      effects.length = 0;
      racing = true;

      const result = await client.savePreferences(["personalization"]);

      expect(result).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      const correction = effects.at(-1);
      expect(correction && accessOf(correction)).toBe("blocked");
      if (replacementKind === "known-predecessor") {
        expect(durable).toBeNull();
      } else {
        expect(durable).toEqual(terminal);
        racing = false;
        await expect(client.acceptAll()).resolves.toMatchObject({
          outcome: "committed",
          transition: {
            record: { method: "accept-all", revision: 3 },
          },
        });
        expect(durable).toMatchObject({
          record: { method: "accept-all", revision: 3 },
        });
      }
    },
  );

  it.each(["grant", "terminal", "withdraw"] as const)(
    "adopts exact unrelated pending lineage before a later %s",
    async (action) => {
      const policy = runtimePolicy();
      const previous: PersistedActiveDecisionRecord = {
        ...persistedGrant(policy.policySnapshot),
        decisions: { analytics: "granted", personalization: "denied" },
        method: "granular",
      };
      const externalRecord: PersistedActiveDecisionRecord = {
        ...previous,
        decidedAt: 40_000,
        decisions: { analytics: "denied", personalization: "granted" },
        expiresAt: 140_000,
        recordId: "record-external",
        revision: 7,
      };
      const externalPending: PersistedConsentState = {
        pendingGrant: {
          candidate: {
            ...externalRecord,
            decidedAt: 50_000,
            decisions: { analytics: "granted", personalization: "granted" },
            expiresAt: 150_000,
            method: "accept-all",
            revision: 8,
          },
          kind: "decision",
          receiptOccurredAt: 50_000,
          transitionId: "transition-external",
        },
        record: externalRecord,
      };
      let durable: PersistedConsentState | null = { record: previous };
      let racing = false;
      let racingReads = 0;
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (durable === null || !stateEquals(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          if (!stateEquals(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          if (racing && ++racingReads === 2) durable = externalPending;
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          );
        },
      };
      let generated = 0;
      const client = createOpenCookie({
        consentDurationMs: 100_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => 2_000,
        ...policy,
        store,
      });
      await client.initialize();
      racing = true;

      await expect(
        client.savePreferences(["personalization"]),
      ).resolves.toMatchObject({ outcome: "invalidated" });
      expect(durable).toEqual(externalPending);
      racing = false;

      const result = await (action === "grant"
        ? client.savePreferences(["analytics"])
        : action === "terminal"
          ? client.rejectAll()
          : client.withdrawConsent());

      expect(result).toMatchObject({
        outcome: "committed",
        transition: {
          record:
            action === "withdraw"
              ? {
                  decidedAt: 40_000,
                  recordId: externalRecord.recordId,
                  revision: 8,
                  withdrawnAt: 50_000,
                }
              : {
                  decidedAt: 50_000,
                  recordId: externalRecord.recordId,
                  revision: 8,
                },
        },
      });
      expect(durable).toMatchObject({
        record:
          action === "withdraw"
            ? {
                decidedAt: 40_000,
                recordId: externalRecord.recordId,
                revision: 8,
                withdrawnAt: 50_000,
              }
            : {
                decidedAt: 50_000,
                recordId: externalRecord.recordId,
                revision: 8,
              },
      });
    },
  );

  it.each(["grant", "terminal", "withdraw"] as const)(
    "adopts an exact first-intent pending identity before a later %s",
    async (action) => {
      const policy = runtimePolicy();
      const externalCandidate: PersistedDecisionRecord = {
        catalogueDigest: policy.policySnapshot.catalogueDigest,
        decidedAt: 40_000,
        decisionSurfaceDigest: policy.policySnapshot.decisionSurfaceDigest,
        decisions: { analytics: "denied", personalization: "granted" },
        expiresAt: 140_000,
        method: "granular",
        policyVersion: policy.policySnapshot.policyVersion,
        recordId: "record-external-first",
        revision: 1,
      };
      const externalPending: PersistedConsentState = {
        pendingGrant: {
          candidate: externalCandidate,
          kind: "decision",
          receiptOccurredAt: 50_000,
          transitionId: "transition-external-first",
        },
      };
      let raceReadback = true;
      const memory = controlledStore(null, {
        read: ({ readCount }) => {
          if (raceReadback && readCount === 2) {
            raceReadback = false;
            memory.replace(externalPending);
          }
          return undefined;
        },
      });
      let generated = 0;
      const client = createOpenCookie({
        consentDurationMs: 100_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => 2_000,
        ...policy,
        store: memory.store,
      });
      await client.initialize();

      await expect(client.acceptAll()).resolves.toMatchObject({
        outcome: "pending",
      });
      expect(memory.stored()).toEqual(externalPending);

      const result = await (action === "grant"
        ? client.savePreferences(["analytics"])
        : action === "terminal"
          ? client.rejectAll()
          : client.withdrawConsent());

      expect(result).toMatchObject({
        outcome: "committed",
        transition: {
          record: {
            decidedAt: 50_000,
            recordId: externalCandidate.recordId,
            revision: 1,
          },
        },
      });
      expect(memory.stored()).toMatchObject({
        record: {
          decidedAt: 50_000,
          recordId: externalCandidate.recordId,
          revision: 1,
        },
      });
      expect(memory.stored()).not.toHaveProperty("pendingGrant");
    },
  );

  it.each(["precondition-read", "post-conflict-read"] as const)(
    "converges an exact active candidate observed on the %s without a blocked correction",
    async (racePoint) => {
      let durable: PersistedConsentState | null = null;
      let compareCount = 0;
      let readCount = 0;
      const activateCompetingWriter = (): void => {
        const pending = durable?.pendingGrant;
        if (pending?.kind !== "decision") {
          throw new Error("Exact activation race requires pending A.");
        }
        durable = { record: pending.candidate };
      };
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: () => Promise.resolve("conflict"),
        compareAndSet: (expected, candidate) => {
          compareCount += 1;
          if (!stateEquals(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          if (compareCount === 1) {
            durable = candidate;
            return Promise.resolve({ status: "written" as const });
          }
          if (racePoint === "post-conflict-read") {
            durable = candidate;
            return Promise.resolve({ status: "conflict" as const });
          }
          throw new Error("Precondition convergence must not attempt a CAS.");
        },
        read: () => {
          readCount += 1;
          if (readCount === 3 && racePoint === "precondition-read") {
            activateCompetingWriter();
          }
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          );
        },
      };
      const effects: ConsentRuntimeTransitionEffect[] = [];
      const receipt = vi.fn(() => Promise.resolve());
      const reconcile = vi.fn(() => Promise.resolve());
      const client = createOpenCookie({
        broadcast: (effect) => {
          effects.push(effect);
          return Promise.resolve();
        },
        consentDurationMs: 10_000,
        idGenerator: (kind) => `${kind}-exact-active`,
        now: () => 1_000,
        receipt,
        reconcile,
        ...runtimePolicy(),
        store,
      });
      await client.initialize();

      const result = await client.acceptAll();

      expect(result).toMatchObject({
        effect: { persistenceStatus: "confirmed" },
        outcome: "committed",
      });
      expect(compareCount).toBe(racePoint === "precondition-read" ? 1 : 2);
      expect(readCount).toBe(racePoint === "precondition-read" ? 3 : 4);
      expect(effects.map(accessOf)).toEqual(["allowed"]);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(receipt).toHaveBeenCalledTimes(1);
      expect(client.getSnapshot().grantActivation).toBe("active");
      expect(durable).not.toHaveProperty("pendingGrant");
    },
  );

  it.each(["expired", "invalid"] as const)(
    "rolls back a precondition-active grant when its first clock is %s",
    async (mode) => {
      let durable: PersistedConsentState | null = null;
      let compareCount = 0;
      let readCount = 0;
      let now = 1_000;
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          if (durable === null || !stateEquals(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          compareCount += 1;
          if (!stateEquals(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          readCount += 1;
          if (readCount === 3) {
            const pending = durable?.pendingGrant;
            if (pending?.kind !== "decision") {
              throw new Error("Precondition race requires pending state.");
            }
            durable = { record: pending.candidate };
            now = mode === "expired" ? 2_000 : Number.POSITIVE_INFINITY;
          }
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          );
        },
      };
      const effects: ConsentRuntimeTransitionEffect[] = [];
      const receipt = vi.fn(() => Promise.resolve());
      const reconcile = vi.fn(() => Promise.resolve());
      const client = createOpenCookie({
        broadcast: (effect) => {
          effects.push(effect);
          return Promise.resolve();
        },
        consentDurationMs: 1_000,
        idGenerator: (kind) => `${kind}-precondition-${mode}`,
        now: () => now,
        receipt,
        reconcile,
        ...runtimePolicy(),
        store,
      });
      await client.initialize();

      const decision = client.acceptAll();
      if (mode === "invalid") {
        await expect(decision).rejects.toThrow(
          "Current time must be a finite safe integer.",
        );
      } else {
        await expect(decision).resolves.toMatchObject({
          diagnostics: [{ code: "grant-expired-before-activation" }],
          outcome: "invalidated",
        });
      }

      expect(compareCount).toBe(2);
      expect(readCount).toBe(5);
      expect(durable).toMatchObject({
        pendingGrant: { transitionId: `transition-precondition-${mode}` },
      });
      expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(receipt).not.toHaveBeenCalled();
      expect(client.getSnapshot().grantActivation).toBe("pending");
    },
  );

  it("revalidates expiry after a conflict reread observes the exact active candidate", async () => {
    let durable: PersistedConsentState | null = null;
    let compareCount = 0;
    let readCount = 0;
    let now = 1_000;
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: () => Promise.resolve("conflict"),
      compareAndSet: (expected, candidate) => {
        compareCount += 1;
        if (!stateEquals(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        if (compareCount === 1) {
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        }
        durable = candidate;
        if (compareCount === 2) {
          now = 2_000;
          return Promise.resolve({ status: "conflict" as const });
        }
        return Promise.resolve({ status: "written" as const });
      },
      read: () => {
        readCount += 1;
        return Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const },
        );
      },
    };
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    const reconcile = vi.fn(() => Promise.resolve());
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-conflict-expiry`,
      now: () => now,
      receipt,
      reconcile,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      effect: { events: [] },
      outcome: "invalidated",
    });
    expect(compareCount).toBe(3);
    expect(readCount).toBe(6);
    expect(durable).toMatchObject({
      pendingGrant: { transitionId: "transition-conflict-expiry" },
    });
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(receipt).not.toHaveBeenCalled();
    expect(client.getSnapshot().grantActivation).toBe("pending");
  });

  it("revalidates expiry after a successful activation write and readback", async () => {
    const activationStarted = deferred();
    const releaseActivation = deferred();
    let now = 1_000;
    const memory = controlledStore(null, {
      compare: async (_expected, _candidate, { compareCount }) => {
        if (compareCount !== 2) return undefined;
        activationStarted.resolve();
        await releaseActivation.promise;
        return undefined;
      },
    });
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    const reconcile = vi.fn(() => Promise.resolve());
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-written-expiry`,
      now: () => now,
      receipt,
      reconcile,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const decision = client.acceptAll();
    await activationStarted.promise;
    now = 2_000;
    releaseActivation.resolve();

    const result = await decision;

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      effect: { events: [] },
      outcome: "invalidated",
    });
    expect(memory.compareCount()).toBe(3);
    expect(memory.stored()).toMatchObject({
      pendingGrant: { transitionId: "transition-written-expiry" },
    });
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(receipt).not.toHaveBeenCalled();
    expect(client.getSnapshot().grantActivation).toBe("pending");
  });

  it("broadcasts blocked access before activation rollback settles", async () => {
    const activationStarted = deferred();
    const releaseActivation = deferred();
    const rollbackStarted = deferred();
    const releaseRollback = deferred();
    let now = 1_000;
    const memory = controlledStore(null, {
      compare: async (_expected, _candidate, { compareCount }) => {
        if (compareCount === 2) {
          activationStarted.resolve();
          await releaseActivation.promise;
        }
        if (compareCount === 3) {
          rollbackStarted.resolve();
          await releaseRollback.promise;
        }
        return undefined;
      },
    });
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-held-rollback`,
      now: () => now,
      reconcile: () => Promise.resolve(),
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const decision = client.acceptAll();
    await activationStarted.promise;
    now = 2_000;
    releaseActivation.resolve();
    await rollbackStarted.promise;

    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      runtime: {
        effectiveAccess: {
          resources: [{ access: "blocked", resourceId: "analytics-script" }],
        },
      },
    });

    releaseRollback.resolve();
    await expect(decision).resolves.toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      outcome: "invalidated",
    });
    expect(memory.stored()).toMatchObject({
      pendingGrant: { transitionId: "transition-held-rollback" },
    });
  });

  it("starts activation rollback while blocked broadcast is pending", async () => {
    const activationStarted = deferred();
    const releaseActivation = deferred();
    const blockedStarted = deferred();
    const releaseBlocked = deferred();
    const rollbackStarted = deferred();
    let now = 1_000;
    const memory = controlledStore(null, {
      compare: async (_expected, _candidate, { compareCount }) => {
        if (compareCount === 2) {
          activationStarted.resolve();
          await releaseActivation.promise;
        }
        if (compareCount === 3) rollbackStarted.resolve();
        return undefined;
      },
    });
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (accessOf(effect) === "blocked") {
          blockedStarted.resolve();
          return releaseBlocked.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-concurrent-rollback`,
      now: () => now,
      reconcile: () => Promise.resolve(),
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const decision = client.acceptAll();
    await activationStarted.promise;
    now = 2_000;
    releaseActivation.resolve();
    await blockedStarted.promise;
    await rollbackStarted.promise;
    await vi.waitFor(() => {
      expect(memory.stored()).toMatchObject({
        pendingGrant: { transitionId: "transition-concurrent-rollback" },
      });
    });

    releaseBlocked.resolve();
    await expect(decision).resolves.toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      outcome: "invalidated",
    });
  });

  it("rebases a terminal after rollback adopts an unrelated durable lineage", async () => {
    const activationStarted = deferred();
    const releaseActivation = deferred();
    const rollbackReadStarted = deferred();
    const releaseRollbackRead = deferred();
    const terminalReadFailed = deferred();
    const policy = runtimePolicy();
    const external: PersistedDecisionRecord = {
      catalogueDigest: policy.policySnapshot.catalogueDigest,
      decidedAt: 1_500,
      decisionSurfaceDigest: policy.policySnapshot.decisionSurfaceDigest,
      decisions: { analytics: "granted", personalization: "denied" },
      expiresAt: 20_000,
      method: "granular",
      policyVersion: policy.policySnapshot.policyVersion,
      recordId: "record-external",
      revision: 7,
    };
    let holdAuthoritativeRead = false;
    let authoritativeReadHeld = false;
    let now = 1_000;
    const memory = controlledStore(null, {
      compare: async (_expected, _candidate, { compareCount }) => {
        if (compareCount === 2) {
          activationStarted.resolve();
          await releaseActivation.promise;
        }
        if (compareCount === 3) {
          memory.replace({ record: external });
          holdAuthoritativeRead = true;
          return { status: "conflict" as const };
        }
        return undefined;
      },
      read: () => {
        if (holdAuthoritativeRead) {
          holdAuthoritativeRead = false;
          authoritativeReadHeld = true;
          rollbackReadStarted.resolve();
          return releaseRollbackRead.promise.then(() => {
            authoritativeReadHeld = false;
            return { state: { record: external }, status: "stored" as const };
          });
        }
        if (authoritativeReadHeld) {
          terminalReadFailed.resolve();
          return Promise.reject(new Error("transient terminal read failure"));
        }
        return undefined;
      },
    });
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    const grant = client.acceptAll();
    await activationStarted.promise;
    now = 11_000;
    releaseActivation.resolve();
    await rollbackReadStarted.promise;

    const terminal = client.rejectAll();
    await terminalReadFailed.promise;
    releaseRollbackRead.resolve();
    const [grantResult, terminalResult] = await Promise.all([grant, terminal]);

    expect(grantResult).toMatchObject({ outcome: "invalidated" });
    expect(terminalResult).toMatchObject({ outcome: "committed" });
    expect(memory.stored()).toMatchObject({
      record: {
        decisions: { analytics: "denied", personalization: "denied" },
        method: "reject-all",
        recordId: "record-external",
        revision: 8,
      },
    });
    const reloaded = createOpenCookie({
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-reload`,
      now: () => now,
      ...policy,
      store: memory.store,
    });
    await reloaded.initialize();
    expect(reloaded.getSnapshot().runtime.effectiveAccess.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          access: "blocked",
          resourceId: "analytics-script",
        }),
      ]),
    );
  });

  it("restores exact pending state when the final activation clock is invalid", async () => {
    let now = 1_000;
    const memory = controlledStore(null, {
      read: ({ compareCount, readCount }) => {
        if (compareCount === 2 && readCount === 4) {
          now = Number.POSITIVE_INFINITY;
        }
        return undefined;
      },
    });
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    const reconcile = vi.fn(() => Promise.resolve());
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-invalid-final-clock`,
      now: () => now,
      receipt,
      reconcile,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    await expect(client.acceptAll()).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );

    const staged = memory.writes()[0];
    expect(staged).toHaveProperty("pendingGrant");
    expect(memory.stored()).toEqual(staged);
    expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(receipt).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: {
        transitionId: "transition-invalid-final-clock",
      },
      runtime: {
        effectiveAccess: {
          resources: [{ access: "blocked", resourceId: "analytics-script" }],
        },
      },
    });
  });

  it.each(["missing", "invalid", "mismatched", "throwing"] as const)(
    "never publishes active after a written activation has a %s readback",
    async (mode) => {
      const memory = controlledStore(null, {
        read: ({ compareCount, durable, readCount }) => {
          if (compareCount !== 2 || readCount !== 4) return undefined;
          if (mode === "throwing") throw new Error("readback unavailable");
          if (mode === "missing") return { status: "missing" as const };
          if (mode === "invalid") {
            return {
              reason: "malformed-json" as const,
              status: "invalid" as const,
            };
          }
          const staged = memory.writes()[0];
          if (staged === undefined || durable === null) {
            throw new Error("Activation fixture must retain staged state.");
          }
          return {
            state: staged,
            status: "stored" as const,
          };
        },
      });
      const effects: ConsentRuntimeTransitionEffect[] = [];
      let notificationCount = 0;
      const client = createOpenCookie({
        broadcast: (effect) => {
          effects.push(effect);
          return Promise.resolve();
        },
        consentDurationMs: 10_000,
        idGenerator: (kind) => `${kind}-${mode}`,
        now: () => 1_000,
        reconcile: () => Promise.resolve(),
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();
      client.subscribe(() => {
        notificationCount += 1;
      });
      const result = await client.acceptAll();

      expect(result).toMatchObject({
        diagnostics: [{ code: "grant-activation-unconfirmed" }],
        effect: { events: [] },
        outcome: "pending",
      });
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "pending",
        runtime: {
          effectiveAccess: {
            resources: [{ access: "blocked", resourceId: "analytics-script" }],
          },
        },
      });
      expect(notificationCount).toBe(1);
      expect(memory.compareCount()).toBe(3);
      expect(memory.stored()).toMatchObject({
        pendingGrant: { transitionId: `transition-${mode}` },
      });
      expect(effects.map(accessOf)).toEqual(["allowed", "blocked"]);
    },
  );

  it("activates once, diagnoses reconcile before receipt, and still issues the final notification", async () => {
    const memory = controlledStore();
    const order: string[] = [];
    const holder: { client?: ReturnType<typeof createOpenCookie> } = {};
    const client = createOpenCookie({
      broadcast: () => Promise.resolve(),
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-aftercare`,
      now: () => 1_000,
      receipt: () => {
        order.push("receipt");
        expect(holder.client?.getSnapshot().grantActivation).toBe("active");
        return Promise.reject(new Error("receipt unavailable"));
      },
      reconcile: () => {
        order.push("reconcile");
        expect(holder.client?.getSnapshot().grantActivation).toBe("active");
        return Promise.reject(new Error("enforcement unavailable"));
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    holder.client = client;
    await client.initialize();
    client.subscribe(() => {
      order.push(`notify-${client.getSnapshot().grantActivation}`);
    });

    const result = await client.acceptAll();

    expect(result).toMatchObject({
      diagnostics: [
        { code: "grant-reconcile-failed" },
        { code: "grant-receipt-failed" },
      ],
      effect: { persistenceStatus: "confirmed" },
      outcome: "degraded",
    });
    expect(order).toEqual([
      "notify-pending",
      "reconcile",
      "receipt",
      "notify-active",
    ]);
    expect(client.getSnapshot().grantActivation).toBe("active");
    expect(memory.compareCount()).toBe(2);
    expect(memory.stored()).not.toHaveProperty("pendingGrant");
  });

  it("snapshots a hostile activation readback once before proving the active state", async () => {
    let ownKeyReads = 0;
    const memory = controlledStore(null, {
      read: ({ compareCount, durable }) => {
        if (compareCount !== 2 || durable === null) return undefined;
        const proxied = new Proxy(durable, {
          ownKeys: (target) => {
            ownKeyReads += 1;
            return Reflect.ownKeys(target);
          },
        });
        return { state: proxied, status: "stored" as const };
      },
    });
    const client = createOpenCookie({
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-proxy`,
      now: () => 1_000,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "committed",
    });
    expect(ownKeyReads).toBe(1);
  });

  it("keeps preferences open when restored activation completes in the background", async () => {
    const policy = runtimePolicy();
    const memory = controlledStore({
      record: {
        ...persistedGrant(policy.policySnapshot),
        decisions: { analytics: "granted", personalization: "denied" },
      },
    });
    const broadcastStarted = deferred();
    const releaseBroadcast = deferred();
    const client = createOpenCookie({
      broadcast: () => {
        broadcastStarted.resolve();
        return releaseBroadcast.promise;
      },
      consentDurationMs: 9_000,
      idGenerator: (kind) => `${kind}-background-restore`,
      now: () => 2_000,
      reconcile: () => Promise.resolve(),
      ...policy,
      store: memory.store,
    });

    const initialization = client.initialize();
    await broadcastStarted.promise;
    client.openPreferences();
    expect(client.getSnapshot().preferencesOpen).toBe(true);

    releaseBroadcast.resolve();
    await initialization;

    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      preferencesOpen: true,
    });
  });

  it("does not restore a verified historical grant when every grant requires reconsent", async () => {
    const policy = reconsentActivationPolicy();
    const historical = persistedGrant(policy.previous);
    const memory = controlledStore({ record: historical });
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 9_000,
      idGenerator: (kind) => `${kind}-historical-activation`,
      now: () => 2_000,
      policyHistory: [policy.current, policy.previous],
      policySnapshot: policy.current,
      reconcile: () => Promise.resolve(),
      resourcePolicy: policy.resourcePolicy,
      store: memory.store,
    });

    const restored = await client.initialize();

    expect(restored).toMatchObject({
      grantActivation: "not-applicable",
      runtime: {
        accessConsent: { status: "requires-reconsent" },
        consentEvaluation: { status: "invalid" },
        policyReconciliation: { status: "requires-reconsent" },
      },
    });
    expect(effects).toHaveLength(0);
    expect(memory.stored()).toEqual({ record: historical });
  });

  it("does not activate a pending historical grant when every grant is unresolved", async () => {
    const policy = reconsentActivationPolicy();
    const historical = persistedGrant(policy.previous);
    const transitionId = "transition-all-unresolved";
    const durableState = {
      pendingGrant: {
        kind: "restore",
        transitionId,
      },
      record: historical,
    } as const;
    const durableBytes = JSON.stringify(durableState);
    const memory = controlledStore(durableState);
    const client = createOpenCookie({
      consentDurationMs: 9_000,
      idGenerator: (kind) => `${kind}-all-unresolved`,
      now: () => 2_000,
      policyHistory: [policy.current, policy.previous],
      policySnapshot: policy.current,
      resourcePolicy: policy.resourcePolicy,
      store: memory.store,
    });
    const publications: OpenCookieSnapshot[] = [];
    const unsubscribe = client.subscribe(() => {
      publications.push(client.getSnapshot());
    });

    const restored = await client.initialize();
    unsubscribe();

    expect(restored).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "broadcast", transitionId },
      preferencesOpen: true,
      record: { recordId: historical.recordId },
      runtime: {
        accessConsent: {
          decisions: [{ decision: "unresolved", purposeId: "analytics" }],
          status: "requires-reconsent",
        },
        policyReconciliation: {
          prompt: true,
          status: "requires-reconsent",
        },
      },
    });
    expect(JSON.stringify(memory.stored())).toBe(durableBytes);
    expect(
      publications.map((published) => ({
        grantActivation: published.grantActivation,
        policyReconciliationPrompt:
          published.runtime.policyReconciliation?.prompt,
        policyReconciliationStatus:
          published.runtime.policyReconciliation?.status,
        preferencesOpen: published.preferencesOpen,
        recordId: published.record?.recordId,
      })),
    ).toEqual([
      {
        grantActivation: "pending",
        policyReconciliationPrompt: undefined,
        policyReconciliationStatus: undefined,
        preferencesOpen: false,
        recordId: historical.recordId,
      },
      {
        grantActivation: "pending",
        policyReconciliationPrompt: true,
        policyReconciliationStatus: "requires-reconsent",
        preferencesOpen: true,
        recordId: historical.recordId,
      },
    ]);
  });

  it.each(["invalid", "expired", "withdrawn"] as const)(
    "does not activate a %s restored record",
    async (status) => {
      const policy = reconsentActivationPolicy();
      const grant = persistedGrant(
        policy.previous,
        status === "expired" ? 1_500 : 10_000,
      );
      const record: PersistedDecisionRecord =
        status === "withdrawn"
          ? {
              ...grant,
              decisions: { analytics: "denied" },
              method: "withdrawal",
              withdrawnAt: 1_500,
            }
          : grant;
      const memory = controlledStore({ record });
      let broadcasts = 0;
      const client = createOpenCookie({
        broadcast: () => {
          broadcasts += 1;
          return Promise.resolve();
        },
        consentDurationMs: 9_000,
        idGenerator: (kind) => `${kind}-${status}`,
        now: () => 2_000,
        policyHistory:
          status === "invalid"
            ? [policy.current]
            : [policy.current, policy.previous],
        policySnapshot: policy.current,
        resourcePolicy: policy.resourcePolicy,
        store: memory.store,
      });

      const restored = await client.initialize();

      expect(restored.grantActivation).toBe("not-applicable");
      expect(restored.runtime.policyReconciliation?.status).toBe(status);
      expect(broadcasts).toBe(0);
      expect(memory.compareCount()).toBe(0);
      expect(memory.stored()).toEqual({ record });
    },
  );
});
