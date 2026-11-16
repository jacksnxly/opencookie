import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type OpenCookiePortContext,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../index.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";
import { persistedConsentStatesEqual } from "./persisted-consent-record.js";

type PersistedActiveDecisionRecord = Extract<
  PersistedDecisionRecord,
  { readonly withdrawnAt?: never }
>;

function mixedRuntimePolicy() {
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
      {
        access: "optional",
        id: "personalization-script",
        purposeIds: ["personalization"],
        serviceId: "personalization-service",
      },
    ],
    services: [{ id: "metrics" }, { id: "personalization-service" }],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");
  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function changingPolicySnapshot(
  policyVersion: string,
  analyticsDisclosure: string,
): PolicySnapshot {
  const catalogue = definePolicy(
    completeTestPolicyDefinition({
      purposes: [
        { disclosure: analyticsDisclosure, id: "analytics" },
        { dependsOn: ["analytics"], id: "ads" },
        { id: "personalization" },
      ],
    }),
  );
  if (!catalogue.ok) throw new Error("Policy must be valid.");
  return createPolicySnapshot({
    catalogueRevision: `catalogue-${policyVersion}`,
    policy: catalogue.policy,
    policyVersion,
  });
}

function changingResourcePolicy(snapshot: PolicySnapshot) {
  const resources = defineResourcePolicy({
    policy: snapshot.policy,
    resources: [
      {
        access: "optional",
        id: "ads-script",
        purposeIds: ["ads"],
        serviceId: "ads-service",
      },
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics"],
        serviceId: "analytics-service",
      },
      {
        access: "optional",
        id: "personalization-script",
        purposeIds: ["personalization"],
        serviceId: "personalization-service",
      },
    ],
    services: [
      { id: "ads-service" },
      { id: "analytics-service" },
      { id: "personalization-service" },
    ],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");
  return resources.resourcePolicy;
}

function historicalChangingGrant(
  snapshot: PolicySnapshot,
): PersistedDecisionRecord {
  return {
    catalogueDigest: snapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
    decisions: {
      ads: "granted",
      analytics: "granted",
      personalization: "granted",
    },
    expiresAt: 10_000,
    method: "granular",
    policyVersion: snapshot.policyVersion,
    recordId: "record-historical",
    revision: 1,
  };
}

function initialRecord(
  policy: ReturnType<typeof mixedRuntimePolicy>["policySnapshot"],
): PersistedActiveDecisionRecord {
  return {
    catalogueDigest: policy.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policy.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "denied" },
    expiresAt: 86_401_000,
    method: "granular",
    policyVersion: policy.policyVersion,
    recordId: "record-1",
    revision: 1,
  };
}

function same(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function recoverableStore(initial: PersistedConsentState | null): {
  readonly allowClears: () => void;
  readonly allowWrites: () => void;
  readonly denyClears: () => void;
  readonly denyWrites: () => void;
  readonly replace: (state: PersistedConsentState | null) => void;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  let durable: PersistedConsentState | null = initial;
  let clearsAllowed = true;
  let writesAllowed = true;
  return {
    allowClears: () => {
      clearsAllowed = true;
    },
    allowWrites: () => {
      writesAllowed = true;
    },
    denyClears: () => {
      clearsAllowed = false;
    },
    denyWrites: () => {
      writesAllowed = false;
    },
    replace: (state) => {
      durable = state;
    },
    store: {
      clear: () => {
        if (!clearsAllowed) {
          return Promise.reject(new Error("decision clear unavailable"));
        }
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (!clearsAllowed) {
          return Promise.reject(new Error("conditional clear unavailable"));
        }
        if (durable === null) return Promise.resolve("cleared" as const);
        if (!same(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        if (!writesAllowed) {
          return Promise.reject(new Error("decision storage unavailable"));
        }
        if (!same(durable, expected)) {
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
  };
}

function recoverableReadStore(initial: PersistedConsentState | null): {
  readonly beforeNextCompare: (operation: () => void) => void;
  readonly failReads: () => void;
  readonly recoverReads: () => void;
  readonly replace: (state: PersistedConsentState | null) => void;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
  readonly writeCount: () => number;
  readonly writtenStates: () => readonly PersistedConsentState[];
} {
  let durable = initial;
  let readable = true;
  let writes = 0;
  let beforeCompare: (() => void) | undefined;
  const writtenStates: PersistedConsentState[] = [];
  return {
    beforeNextCompare: (operation) => {
      beforeCompare = operation;
    },
    failReads: () => {
      readable = false;
    },
    recoverReads: () => {
      readable = true;
    },
    replace: (state) => {
      durable = state;
    },
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (!readable) return Promise.resolve("readback-mismatch" as const);
        if (durable === null) return Promise.resolve("cleared" as const);
        if (!same(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        if (!readable) {
          return Promise.resolve({ status: "readback-mismatch" as const });
        }
        const operation = beforeCompare;
        beforeCompare = undefined;
        operation?.();
        if (!same(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        writes += 1;
        durable = candidate;
        writtenStates.push(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          !readable
            ? { reason: "read-failed" as const, status: "invalid" as const }
            : durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
        ),
    },
    stored: () => durable,
    writeCount: () => writes,
    writtenStates: () => writtenStates,
  };
}

function decisions(effect: ConsentRuntimeTransitionEffect) {
  return Object.fromEntries(
    effect.record.decisions.map((decision) => [
      decision.purposeId,
      decision.value,
    ]),
  );
}

function access(effect: ConsentRuntimeTransitionEffect) {
  return Object.fromEntries(
    effect.runtime.effectiveAccess.resources.map((resource) => [
      resource.resourceId,
      resource.access,
    ]),
  );
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("createOpenCookie persistence failure correction", () => {
  it("publishes narrowing before failed-stage cleanup settles", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    let failWrite = false;
    let holdCleanup = false;
    let notifications = 0;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-held-cleanup`,
      now: () => 2_000,
      reconcile: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: async (expected) => {
          if (holdCleanup) {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
          return clearIfCurrent(expected);
        },
        compareAndSet: (expected, candidate) =>
          failWrite
            ? Promise.reject(new Error("decision storage unavailable"))
            : memory.store.compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    effects.length = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    failWrite = true;
    holdCleanup = true;

    const decision = client.savePreferences(["personalization"]);
    await cleanupStarted.promise;

    expect(
      client
        .getSnapshot()
        .runtime.effectiveAccess.resources.map(
          ({ access: resourceAccess, resourceId }) => [
            resourceId,
            resourceAccess,
          ],
        ),
    ).toEqual([
      ["analytics-script", "blocked"],
      ["personalization-script", "blocked"],
    ]);
    expect(notifications).toBe(1);
    expect(effects.map(access)).toEqual([
      {
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      },
    ]);

    releaseCleanup.resolve();
    await expect(decision).resolves.toMatchObject({ outcome: "pending" });
    expect(effects.map(access)).toEqual([
      {
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      },
      {
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      },
    ]);
  });

  it("starts failed-stage cleanup while blocked broadcast is pending", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    const blockedStarted = deferred();
    const releaseBlocked = deferred();
    const cleanupStarted = deferred();
    let failWrite = false;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (access(effect)["analytics-script"] === "blocked") {
          blockedStarted.resolve();
          return releaseBlocked.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-concurrent-cleanup`,
      now: () => 2_000,
      reconcile: () => Promise.resolve(),
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: (expected) => {
          cleanupStarted.resolve();
          return clearIfCurrent(expected);
        },
        compareAndSet: (expected, candidate) =>
          failWrite
            ? Promise.reject(new Error("decision storage unavailable"))
            : memory.store.compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    failWrite = true;

    const decision = client.savePreferences(["personalization"]);
    await blockedStarted.promise;
    await cleanupStarted.promise;
    await vi.waitFor(() => {
      expect(memory.stored()).toBeNull();
    });

    releaseBlocked.resolve();
    await expect(decision).resolves.toMatchObject({ outcome: "pending" });
  });

  it("applies mixed narrowing before returning a persistence-pending result", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const calls: string[] = [];
    let rejectBroadcast = false;
    const broadcast = vi.fn((effect: ConsentRuntimeTransitionEffect) => {
      calls.push(`broadcast:${JSON.stringify(decisions(effect))}`);
      return rejectBroadcast
        ? Promise.reject(new Error("signal unavailable"))
        : Promise.resolve();
    });
    const reconcile = vi.fn((effect: ConsentRuntimeTransitionEffect) => {
      calls.push(`reconcile:${JSON.stringify(decisions(effect))}`);
      return Promise.resolve();
    });
    const receipt = vi.fn(() => Promise.resolve());
    let transition = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record" ? "record-1" : `transition-${String(++transition)}`,
      now: () => now,
      receipt,
      reconcile,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    calls.length = 0;
    receipt.mockClear();
    memory.denyWrites();
    rejectBroadcast = true;
    now = 2_000;

    const result = await client.savePreferences(["personalization"]);
    if (result.outcome !== "pending") {
      throw new Error("Mixed decision must remain retryable.");
    }

    expect(result).toMatchObject({
      effect: {
        events: [],
        persistenceStatus: "pending",
        record: {
          decisions: [
            { purposeId: "analytics", value: "denied" },
            { purposeId: "personalization", value: "denied" },
          ],
          method: "reject-all",
        },
      },
      outcome: "pending",
      transition: {
        persistenceStatus: "pending",
        record: {
          decisions: [
            { purposeId: "analytics", value: "denied" },
            { purposeId: "personalization", value: "granted" },
          ],
        },
      },
    });
    const diagnosticCodes = result.diagnostics?.map(({ code }) => code) ?? [];
    expect(diagnosticCodes).toContain("grant-write-failed");
    expect(diagnosticCodes).toContain("grant-corrective-signal-failed");
    expect(calls).toEqual([
      'broadcast:{"analytics":"denied","personalization":"denied"}',
      'reconcile:{"analytics":"denied","personalization":"denied"}',
    ]);
    expect(memory.stored()).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: {
        grantedPurposeIds: ["personalization"],
        phase: "persistence",
      },
      preferencesOpen: true,
      record: {
        decisions: [
          { purposeId: "analytics", value: "granted" },
          { purposeId: "personalization", value: "denied" },
        ],
        revision: 1,
      },
      runtime: {
        effectiveAccess: {
          resources: [
            { access: "blocked", resourceId: "analytics-script" },
            { access: "blocked", resourceId: "personalization-script" },
          ],
        },
      },
    });
    expect(receipt).not.toHaveBeenCalled();
  });

  it("projects a second failed intent from current safe access", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const receipt = vi.fn(() => Promise.resolve());
    let transition = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record" ? "record-1" : `transition-${String(++transition)}`,
      now: () => now,
      receipt,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    receipt.mockClear();
    memory.denyWrites();
    now = 2_000;
    await client.savePreferences(["personalization"]);
    now = 3_000;

    const second = await client.acceptAll();
    if (second.outcome !== "pending") {
      throw new Error("Second intent must remain retryable.");
    }

    expect(second).toMatchObject({
      effect: {
        events: [],
        record: {
          decisions: [
            { purposeId: "analytics", value: "denied" },
            { purposeId: "personalization", value: "denied" },
          ],
          method: "reject-all",
        },
      },
      outcome: "pending",
      transition: {
        record: {
          decisions: [
            { purposeId: "analytics", value: "granted" },
            { purposeId: "personalization", value: "granted" },
          ],
          revision: 2,
        },
      },
    });
    expect(access(second.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(receipt).not.toHaveBeenCalled();
  });

  it.each(["reject", "withdraw"] as const)(
    "preserves completed record lineage when failed cleanup is followed by %s",
    async (action) => {
      const policy = mixedRuntimePolicy();
      const previous = initialRecord(policy.policySnapshot);
      const memory = recoverableStore({ record: previous });
      let generated = 0;
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => now,
        ...policy,
        store: memory.store,
      });
      await client.initialize();
      memory.denyWrites();
      now = 2_000;

      await expect(
        client.savePreferences(["personalization"]),
      ).resolves.toMatchObject({ outcome: "pending" });
      expect(memory.stored()).toBeNull();
      memory.allowWrites();
      now = 3_000;

      const terminal =
        action === "reject" ? client.rejectAll() : client.withdrawConsent();
      const method = action === "reject" ? "reject-all" : "withdrawal";
      await expect(terminal).resolves.toMatchObject({
        effect: {
          record: {
            method,
            recordId: previous.recordId,
            revision: 2,
          },
        },
        outcome: "committed",
      });
      expect(memory.stored()).toMatchObject({
        record: {
          method,
          recordId: previous.recordId,
          revision: 2,
        },
      });
    },
  );

  it("cannot restore policy-blocked access when a reconsent write fails", async () => {
    const previous = changingPolicySnapshot(
      "policy-1",
      "Original analytics disclosure.",
    );
    const current = changingPolicySnapshot(
      "policy-2",
      "Changed analytics disclosure.",
    );
    const memory = recoverableStore({
      record: historicalChangingGrant(previous),
    });
    let now = 2_000;
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 8_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      policyHistory: [current, previous],
      policySnapshot: current,
      resourcePolicy: changingResourcePolicy(current),
      store: memory.store,
    });
    await client.initialize();
    expect(
      Object.fromEntries(
        client
          .getSnapshot()
          .runtime.effectiveAccess.resources.map((resource) => [
            resource.resourceId,
            resource.access,
          ]),
      ),
    ).toEqual({
      "ads-script": "blocked",
      "analytics-script": "blocked",
      "personalization-script": "allowed",
    });
    memory.denyWrites();
    now = 3_000;

    const pending = await client.acceptAll();
    if (pending.outcome !== "pending") {
      throw new Error("Failed reconsent must remain retryable.");
    }

    expect(access(pending.effect)).toEqual({
      "ads-script": "blocked",
      "analytics-script": "blocked",
      "personalization-script": "allowed",
    });
    expect(
      client.getSnapshot().runtime.effectiveAccess.resources,
    ).toMatchObject([
      { access: "blocked", resourceId: "ads-script" },
      { access: "blocked", resourceId: "analytics-script" },
      { access: "allowed", resourceId: "personalization-script" },
    ]);
    expect(memory.stored()).toBeNull();
  });

  it("retries only the withheld widening under the original identity", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const reconciled: Array<{
      readonly access: ReturnType<typeof access>;
      readonly stored: PersistedConsentState | null;
    }> = [];
    const receipt = vi.fn(() => Promise.resolve());
    let transition = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record" ? "record-1" : `transition-${String(++transition)}`,
      now: () => now,
      receipt,
      reconcile: (effect) => {
        reconciled.push({ access: access(effect), stored: memory.stored() });
        return Promise.resolve();
      },
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    reconciled.length = 0;
    receipt.mockClear();
    memory.denyWrites();
    now = 2_000;
    const pending = await client.savePreferences(["personalization"]);
    if (pending.outcome !== "pending") {
      throw new Error("Mixed decision must remain retryable.");
    }
    const pendingTransitionId = pending.transition.transitionId;
    expect(memory.stored()).toBeNull();
    reconciled.length = 0;
    memory.allowWrites();
    now = 3_000;

    const retried = await client.retryPendingGrant();

    expect(retried).toMatchObject({
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: {
          decisions: { analytics: "denied", personalization: "granted" },
        },
        transitionId: pendingTransitionId,
      },
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.access).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "allowed",
    });
    expect(reconciled[0]?.stored?.record?.decisions).toEqual({
      analytics: "denied",
      personalization: "granted",
    });
    expect(memory.stored()?.record?.decisions).toEqual({
      analytics: "denied",
      personalization: "granted",
    });
    expect(receipt).toHaveBeenCalledTimes(1);
  });

  it("persists on the first retry after an unreadable missing store recovers", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableReadStore(null);
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.failReads();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [
        { code: "grant-readback-mismatch" },
        { code: "grant-clear-unconfirmed" },
      ],
      outcome: "pending",
    });
    expect(memory.stored()).toBeNull();
    expect(memory.writeCount()).toBe(0);
    memory.recoverReads();

    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: { method: "accept-all" },
      },
    });
    expect(memory.writeCount()).toBe(2);
    expect(memory.writtenStates()).toMatchObject([
      {
        pendingGrant: {
          candidate: { method: "accept-all" },
          kind: "decision",
        },
      },
      { record: { method: "accept-all" } },
    ]);
    expect(memory.writtenStates()[0]?.record).toBeUndefined();
    expect(memory.writtenStates()[1]?.pendingGrant).toBeUndefined();
    expect(memory.stored()).toMatchObject({
      record: { method: "accept-all" },
    });
  });

  it("does not overwrite a hidden record when an unreadable store recovers", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableReadStore(null);
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.failReads();
    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "pending",
    });
    const hidden = { record: initialRecord(policy.policySnapshot) };
    memory.replace(hidden);
    memory.recoverReads();

    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "pending",
    });
    expect(memory.writeCount()).toBe(0);
    expect(memory.stored()).toEqual(hidden);
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });
  });

  it("does not overwrite a writer racing the recovered missing read", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableReadStore(null);
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.failReads();
    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "pending",
    });
    const hidden = { record: initialRecord(policy.policySnapshot) };
    let raced = false;
    memory.recoverReads();
    memory.beforeNextCompare(() => {
      raced = true;
      memory.replace(hidden);
    });

    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "pending",
    });
    expect(raced).toBe(true);
    expect(memory.writeCount()).toBe(0);
    expect(memory.stored()).toEqual(hidden);
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });
  });

  it.each(["broadcast", "reconcile"] as const)(
    "exposes one active port context throughout a failed-stage %s correction",
    async (terminalPort) => {
      const policy = mixedRuntimePolicy();
      const memory = recoverableStore(null);
      memory.denyWrites();
      const ids = ["record-1", "transition-grant", "transition-terminal"];
      const correctionContexts: OpenCookiePortContext[] = [];
      let terminal: ReturnType<OpenCookiePortContext["rejectAll"]> | undefined;
      const useContext = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
        context: OpenCookiePortContext | undefined,
      ): Promise<void> => {
        if (
          effect.transitionId !== "transition-grant" ||
          effect.persistenceStatus !== "pending"
        ) {
          return;
        }
        if (context === undefined) {
          throw new Error(
            "Failed-stage correction must expose its port context.",
          );
        }
        correctionContexts.push(context);
        if (port !== terminalPort) return;
        memory.allowWrites();
        terminal = context.rejectAll();
        await terminal;
      };
      const client = createOpenCookie({
        broadcast: (effect, context) =>
          useContext("broadcast", effect, context),
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected-id",
        now: () => 1_000,
        reconcile: (effect, context) =>
          useContext("reconcile", effect, context),
        ...policy,
        store: memory.store,
      });
      await client.initialize();

      const grant = await client.acceptAll();
      if (terminal === undefined) {
        throw new Error("The corrective context must reserve reject-all.");
      }
      const terminalResult = await terminal;

      expect(grant).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      expect(terminalResult).toMatchObject({ outcome: "committed" });
      expect(correctionContexts.length).toBeGreaterThan(0);
      expect(
        correctionContexts.every(
          (context) => context === correctionContexts[0],
        ),
      ).toBe(true);
      expect(memory.stored()?.record).toMatchObject({
        method: "reject-all",
        revision: 1,
      });
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all", revision: 1 },
      });
      expect(client.getSnapshot().pendingGrant).toBeUndefined();
    },
  );

  it("expires a corrective context when clock reprojection throws", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore(null);
    const effects: ConsentRuntimeTransitionEffect[] = [];
    let now = 1_000;
    let generated = 0;
    let staleContext: OpenCookiePortContext | undefined;
    const client = createOpenCookie({
      broadcast: (effect, context) => {
        effects.push(effect);
        if (
          effect.persistenceStatus === "pending" &&
          access(effect)["analytics-script"] === "blocked"
        ) {
          staleContext = context;
          now = Number.POSITIVE_INFINITY;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.denyWrites();

    await expect(client.acceptAll()).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );
    if (staleContext === undefined) {
      throw new Error("Corrective broadcast must expose its port context.");
    }
    now = 2_000;
    memory.allowWrites();
    const effectCount = effects.length;

    await expect(staleContext.rejectAll()).rejects.toThrow(
      "OpenCookie port context is no longer active.",
    );
    expect(effects).toHaveLength(effectCount);
    expect(memory.stored()).toBeNull();
  });

  it("does not reconcile retained access after a corrective withdrawal", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const effects: Array<{
      readonly access: ReturnType<typeof access>;
      readonly method: string;
      readonly port: "broadcast" | "reconcile";
      readonly transitionId: string;
    }> = [];
    const transitionIds = [
      "transition-restore",
      "transition-grant",
      "transition-withdrawal",
    ];
    let terminal:
      ReturnType<OpenCookiePortContext["withdrawConsent"]> | undefined;
    const observe = async (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
      context: OpenCookiePortContext | undefined,
    ): Promise<void> => {
      effects.push({
        access: access(effect),
        method: effect.record.method,
        port,
        transitionId: effect.transitionId,
      });
      if (
        port !== "broadcast" ||
        effect.transitionId !== "transition-grant" ||
        effect.persistenceStatus !== "pending"
      ) {
        return;
      }
      if (context === undefined) {
        throw new Error("Corrective withdrawal requires a port context.");
      }
      memory.allowWrites();
      terminal = context.withdrawConsent();
      await terminal;
    };
    const client = createOpenCookie({
      broadcast: (effect, context) => observe("broadcast", effect, context),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record"
          ? "record-1"
          : (transitionIds.shift() ?? "unexpected-transition"),
      now: () => 2_000,
      reconcile: (effect, context) => observe("reconcile", effect, context),
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    effects.length = 0;
    memory.denyWrites();

    const grant = await client.acceptAll();
    if (terminal === undefined) {
      throw new Error("Corrective broadcast must reserve withdrawal.");
    }
    const terminalResult = await terminal;

    expect(grant).toMatchObject({ outcome: "invalidated" });
    expect(terminalResult).toMatchObject({ outcome: "committed" });
    const withdrawalIndex = effects.findIndex(
      ({ method }) => method === "withdrawal",
    );
    expect(withdrawalIndex).toBeGreaterThanOrEqual(0);
    expect(effects.slice(withdrawalIndex)).toEqual(
      effects.slice(withdrawalIndex).map((effect) => ({
        ...effect,
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        method: "withdrawal",
        transitionId: "transition-withdrawal",
      })),
    );
    expect(effects.at(-1)).toMatchObject({
      access: {
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      },
      method: "withdrawal",
    });
    expect(client.getSnapshot().record?.method).toBe("withdrawal");
  });

  it.each(["terminal", "distinct-grant"] as const)(
    "invalidates a failed-stage result superseded by a %s",
    async (replacement) => {
      const policy = mixedRuntimePolicy();
      const memory = recoverableStore(null);
      memory.denyWrites();
      const correctionStarted = deferred();
      const releaseCorrection = deferred();
      const ids = ["record-1", "transition-a", "transition-b"];
      const client = createOpenCookie({
        broadcast: async (effect) => {
          if (
            effect.transitionId === "transition-a" &&
            effect.persistenceStatus === "pending"
          ) {
            correctionStarted.resolve();
            await releaseCorrection.promise;
          }
        },
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected-id",
        now: () => 1_000,
        ...policy,
        store: memory.store,
      });
      await client.initialize();

      const first = client.acceptAll();
      await correctionStarted.promise;
      memory.allowWrites();
      const second =
        replacement === "terminal"
          ? client.rejectAll()
          : client.savePreferences(["analytics"]);
      await vi.waitFor(() => {
        const snapshot = client.getSnapshot();
        if (replacement === "terminal") {
          expect(snapshot.record?.method).toBe("reject-all");
        } else {
          expect(snapshot.pendingGrant?.transitionId).toBe("transition-b");
        }
      });
      releaseCorrection.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      expect(secondResult).toMatchObject({ outcome: "committed" });
      expect(client.getSnapshot().pendingGrant).toBeUndefined();
      expect(client.getSnapshot().record?.method).toBe(
        replacement === "terminal" ? "reject-all" : "granular",
      );
    },
  );

  it("expires retained access while the widening remains pending", async () => {
    const policy = mixedRuntimePolicy();
    const record = {
      ...initialRecord(policy.policySnapshot),
      expiresAt: 2_000,
    };
    const memory = recoverableStore({ record });
    const reconciled: ConsentRuntimeTransitionEffect[] = [];
    let transition = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record" ? "record-1" : `transition-${String(++transition)}`,
      now: () => now,
      reconcile: (effect) => {
        reconciled.push(effect);
        return Promise.resolve();
      },
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    reconciled.length = 0;
    memory.denyWrites();
    now = 1_500;

    const pending = await client.acceptAll();
    if (pending.outcome !== "pending") {
      throw new Error("Failed widening must remain pending.");
    }

    expect(pending).toMatchObject({
      effect: {
        record: {
          decisions: [
            { purposeId: "analytics", value: "granted" },
            { purposeId: "personalization", value: "denied" },
          ],
          expiresAt: 2_000,
          method: "granular",
        },
      },
      outcome: "pending",
    });
    expect(access(pending.effect)).toEqual({
      "analytics-script": "allowed",
      "personalization-script": "blocked",
    });
    now = 2_500;

    await client.refresh();

    expect(client.getSnapshot()).toMatchObject({
      pendingGrant: { phase: "persistence" },
      runtime: {
        effectiveAccess: {
          resources: [
            { access: "blocked", resourceId: "analytics-script" },
            { access: "blocked", resourceId: "personalization-script" },
          ],
        },
      },
    });
    const expiryReconciliation = reconciled.at(-1);
    if (expiryReconciliation === undefined) {
      throw new Error("Expected expiry reconciliation.");
    }
    expect(decisions(expiryReconciliation)).toEqual({
      analytics: "granted",
      personalization: "denied",
    });
    expect(access(expiryReconciliation)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
  });

  it("cannot reinstall an expired conservative effect while retrying", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
    });
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    let now = 1_000;
    let generated = 0;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      receipt,
      reconcile: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.denyWrites();
    now = 1_500;
    const pending = await client.acceptAll();
    if (pending.outcome !== "pending") {
      throw new Error("Failed widening must remain retryable.");
    }
    const transitionId = pending.transition.transitionId;
    now = 2_600;
    await client.refresh();
    effects.length = 0;
    const published: ReturnType<typeof access>[] = [];
    const unsubscribe = client.subscribe(() => {
      published.push(
        Object.fromEntries(
          client
            .getSnapshot()
            .runtime.effectiveAccess.resources.map((resource) => [
              resource.resourceId,
              resource.access,
            ]),
        ),
      );
    });
    memory.allowWrites();

    const retry = await client.retryPendingGrant();
    unsubscribe();

    expect(retry).toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      effect: {
        runtime: {
          effectiveAccess: {
            resources: [
              { access: "blocked", resourceId: "analytics-script" },
              { access: "blocked", resourceId: "personalization-script" },
            ],
          },
        },
      },
      outcome: "invalidated",
      transition: { transitionId },
    });
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.map(access)).toEqual(
      effects.map(() => ({
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      })),
    );
    expect(published.length).toBeGreaterThan(0);
    expect(published).toEqual(
      published.map(() => ({
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      })),
    );
    expect(
      Object.fromEntries(
        client
          .getSnapshot()
          .runtime.effectiveAccess.resources.map((resource) => [
            resource.resourceId,
            resource.access,
          ]),
      ),
    ).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(memory.stored()?.pendingGrant).toMatchObject({
      candidate: { expiresAt: 2_500 },
      transitionId,
    });
    expect(receipt).not.toHaveBeenCalled();
  });

  it("reconciles expired retained access when persistence retry still fails", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
    });
    const effects: Array<{
      readonly access: ReturnType<typeof access>;
      readonly port: "broadcast" | "reconcile";
    }> = [];
    const receipt = vi.fn(() => Promise.resolve());
    let now = 1_000;
    let generated = 0;
    const observe = (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
    ): Promise<void> => {
      effects.push({ access: access(effect), port });
      return Promise.resolve();
    };
    const client = createOpenCookie({
      broadcast: (effect) => observe("broadcast", effect),
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      receipt,
      reconcile: (effect) => observe("reconcile", effect),
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.denyWrites();
    now = 1_500;
    const pending = await client.acceptAll();
    if (pending.outcome !== "pending") {
      throw new Error("Failed widening must remain retryable.");
    }
    expect(access(pending.effect)).toEqual({
      "analytics-script": "allowed",
      "personalization-script": "blocked",
    });
    effects.length = 0;
    now = 2_600;

    const retry = await client.retryPendingGrant();

    expect(retry).toMatchObject({ outcome: "pending" });
    if (!("effect" in retry)) {
      throw new Error("Expired retry must expose its corrective effect.");
    }
    expect(access(retry.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(effects).toEqual([
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "broadcast",
      },
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "reconcile",
      },
    ]);
    expect(
      client.getSnapshot().runtime.effectiveAccess.resources,
    ).toMatchObject([
      { access: "blocked", resourceId: "analytics-script" },
      { access: "blocked", resourceId: "personalization-script" },
    ]);
    expect(receipt).not.toHaveBeenCalled();
  });

  it("retries exact stale-grant cleanup after storage clearing recovers", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    let clearAttempts = 0;
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: (expected) => {
          clearAttempts += 1;
          return clearIfCurrent(expected);
        },
      },
    });
    await client.initialize();
    memory.denyWrites();
    memory.denyClears();

    const first = await client.savePreferences(["personalization"]);
    if (first.outcome !== "pending") {
      throw new Error("Failed replacement must remain retryable.");
    }
    expect(access(first.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(memory.stored()?.record?.decisions).toEqual({
      analytics: "granted",
      personalization: "denied",
    });
    expect(clearAttempts).toBe(2);
    clearAttempts = 0;
    memory.allowClears();

    const retry = await client.retryPendingGrant();

    expect(retry).toMatchObject({ outcome: "pending" });
    expect(clearAttempts).toBe(2);
    expect(memory.stored()).toBeNull();
  });

  it("samples expiry after a failed persistence await before correction", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
    });
    const compareAndSet = memory.store.compareAndSet;
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    let holdWrite = false;
    let now = 1_000;
    let generated = 0;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      ...policy,
      store: {
        ...memory.store,
        compareAndSet: (expected, candidate) => {
          if (!holdWrite) return compareAndSet(expected, candidate);
          writeStarted.resolve();
          return releaseWrite.promise.then(() =>
            Promise.reject(new Error("decision storage unavailable")),
          );
        },
      },
    });
    await client.initialize();
    effects.length = 0;
    holdWrite = true;
    now = 1_500;
    const decision = client.acceptAll();
    await writeStarted.promise;
    now = 2_600;
    releaseWrite.resolve();

    const pending = await decision;
    if (pending.outcome !== "pending") {
      throw new Error("Failed widening must remain retryable.");
    }

    expect(access(pending.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.map(access)).toEqual(
      effects.map(() => ({
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      })),
    );
  });

  it("installs blocked access when the clock fails after persistence", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const compareAndSet = memory.store.compareAndSet;
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    let holdWrite = false;
    let now = 1_000;
    let generated = 0;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      ...policy,
      store: {
        ...memory.store,
        compareAndSet: async (expected, candidate) => {
          if (!holdWrite) return compareAndSet(expected, candidate);
          writeStarted.resolve();
          await releaseWrite.promise;
          throw new Error("decision storage unavailable");
        },
      },
    });
    await client.initialize();
    effects.length = 0;
    holdWrite = true;
    const decision = client.savePreferences(["personalization"]);
    await writeStarted.promise;
    now = Number.POSITIVE_INFINITY;
    releaseWrite.resolve();

    await expect(decision).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );
    expect(memory.stored()).toBeNull();
    expect(
      client
        .getSnapshot()
        .runtime.effectiveAccess.resources.map(
          ({ access: resourceAccess, resourceId }) => [
            resourceId,
            resourceAccess,
          ],
        ),
    ).toEqual([
      ["analytics-script", "blocked"],
      ["personalization-script", "blocked"],
    ]);
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.map(access)).toEqual(
      effects.map(() => ({
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      })),
    );
  });

  it("signals blocked access when the first post-stage clock read fails", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const effects: Array<{
      readonly access: ReturnType<typeof access>;
      readonly context: OpenCookiePortContext | undefined;
      readonly port: "broadcast" | "reconcile";
    }> = [];
    const receipt = vi.fn(() => Promise.resolve());
    let armed = false;
    let armedReads = 0;
    let generated = 0;
    let staleContext: OpenCookiePortContext | undefined;
    const observe = (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ) => {
      effects.push({ access: access(effect), context, port });
      staleContext ??= context;
      return Promise.resolve();
    };
    const client = createOpenCookie({
      broadcast: (effect, context) => observe("broadcast", effect, context),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => {
        if (armed && ++armedReads === 2) return Number.POSITIVE_INFINITY;
        return 2_000;
      },
      receipt,
      reconcile: (effect, context) => observe("reconcile", effect, context),
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    effects.length = 0;
    receipt.mockClear();
    armed = true;

    await expect(client.savePreferences(["personalization"])).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );

    expect(
      effects.map(({ access: observed, port }) => ({
        access: observed,
        port,
      })),
    ).toEqual([
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "broadcast",
      },
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "reconcile",
      },
    ]);
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "broadcast" },
      runtime: {
        effectiveAccess: {
          resources: [
            { access: "blocked", resourceId: "analytics-script" },
            { access: "blocked", resourceId: "personalization-script" },
          ],
        },
      },
    });
    expect(memory.stored()).toHaveProperty("pendingGrant");
    expect(receipt).not.toHaveBeenCalled();
    if (staleContext === undefined) {
      throw new Error("Blocked correction must expose a bounded context.");
    }
    await expect(staleContext.rejectAll()).rejects.toThrow(
      "OpenCookie port context is no longer active.",
    );
  });

  it.each(["broadcast", "reconcile"] as const)(
    "refreshes retained access while corrective %s is pending",
    async (heldPort) => {
      const policy = mixedRuntimePolicy();
      const memory = recoverableStore({
        record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
      });
      const portStarted = deferred();
      const releasePort = deferred();
      const effects: Array<{
        readonly access: ReturnType<typeof access>;
        readonly port: "broadcast" | "reconcile";
      }> = [];
      const receipt = vi.fn(() => Promise.resolve());
      let holdCorrection = false;
      let now = 1_000;
      let generated = 0;
      const observe = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ): Promise<void> => {
        effects.push({ access: access(effect), port });
        if (
          holdCorrection &&
          port === heldPort &&
          access(effect)["analytics-script"] === "allowed"
        ) {
          portStarted.resolve();
          await releasePort.promise;
        }
      };
      const client = createOpenCookie({
        broadcast: (effect) => observe("broadcast", effect),
        consentDurationMs: 1_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => now,
        receipt,
        reconcile: (effect) => observe("reconcile", effect),
        ...policy,
        store: memory.store,
      });
      await client.initialize();
      effects.length = 0;
      memory.denyWrites();
      holdCorrection = true;
      now = 1_500;
      const decision = client.acceptAll();
      await portStarted.promise;
      now = 2_500;
      releasePort.resolve();

      const pending = await decision;

      expect(pending).toMatchObject({ outcome: "pending" });
      if (!("effect" in pending)) {
        throw new Error("Failed correction must expose its pending effect.");
      }
      expect(effects).toEqual([
        {
          access: {
            "analytics-script": "allowed",
            "personalization-script": "blocked",
          },
          port: "broadcast",
        },
        ...(heldPort === "reconcile"
          ? [
              {
                access: {
                  "analytics-script": "allowed",
                  "personalization-script": "blocked",
                },
                port: "reconcile" as const,
              },
            ]
          : []),
        {
          access: {
            "analytics-script": "blocked",
            "personalization-script": "blocked",
          },
          port: "broadcast",
        },
        {
          access: {
            "analytics-script": "blocked",
            "personalization-script": "blocked",
          },
          port: "reconcile",
        },
      ]);
      expect(access(pending.effect)).toEqual({
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      });
      expect(
        client
          .getSnapshot()
          .runtime.effectiveAccess.resources.map(
            ({ access: resourceAccess, resourceId }) => [
              resourceId,
              resourceAccess,
            ],
          ),
      ).toEqual([
        ["analytics-script", "blocked"],
        ["personalization-script", "blocked"],
      ]);
      expect(receipt).not.toHaveBeenCalled();
    },
  );

  it("replays expired blocking after failed-stage cleanup settles", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    const compareAndSet = memory.store.compareAndSet;
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const portsFinished = deferred();
    const effects: Array<{
      readonly access: ReturnType<typeof access>;
      readonly context: OpenCookiePortContext | undefined;
      readonly port: "broadcast" | "reconcile";
    }> = [];
    let now = 1_000;
    let generated = 0;
    let failWrite = false;
    const observe = (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ): Promise<void> => {
      effects.push({ access: access(effect), context, port });
      if (
        port === "reconcile" &&
        access(effect)["analytics-script"] === "allowed"
      ) {
        portsFinished.resolve();
      }
      return Promise.resolve();
    };
    const client = createOpenCookie({
      broadcast: (effect, context) => observe("broadcast", effect, context),
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect, context) => observe("reconcile", effect, context),
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: async (expected) => {
          if (failWrite) {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
          return clearIfCurrent(expected);
        },
        compareAndSet: (expected, candidate) =>
          failWrite
            ? Promise.reject(new Error("decision storage unavailable"))
            : compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    effects.length = 0;
    failWrite = true;
    now = 1_500;

    const decision = client.acceptAll();
    await cleanupStarted.promise;
    await portsFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    now = 2_500;
    releaseCleanup.resolve();

    const pending = await decision;
    expect(pending).toMatchObject({ outcome: "pending" });
    if (!("effect" in pending)) {
      throw new Error("Failed correction must expose its pending effect.");
    }
    const allowed = {
      "analytics-script": "allowed",
      "personalization-script": "blocked",
    };
    const blocked = {
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    };
    expect(
      effects.map(({ access: observed, port }) => ({
        access: observed,
        port,
      })),
    ).toEqual([
      { access: allowed, port: "broadcast" },
      { access: allowed, port: "reconcile" },
      { access: blocked, port: "broadcast" },
      { access: blocked, port: "reconcile" },
    ]);
    expect(
      effects.slice(0, 2).every(({ context }) => context !== undefined),
    ).toBe(true);
    expect(effects.slice(2).every(({ context }) => context === undefined)).toBe(
      true,
    );
    expect(access(pending.effect)).toEqual(blocked);
    expect(
      Object.fromEntries(
        client
          .getSnapshot()
          .runtime.effectiveAccess.resources.map(
            ({ access: resourceAccess, resourceId }) => [
              resourceId,
              resourceAccess,
            ],
          ),
      ),
    ).toEqual(blocked);
  });

  it("replays blocked access when the clock fails after cleanup settles", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    const compareAndSet = memory.store.compareAndSet;
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const portsFinished = deferred();
    const effects: Array<{
      readonly access: ReturnType<typeof access>;
      readonly context: OpenCookiePortContext | undefined;
      readonly port: "broadcast" | "reconcile";
    }> = [];
    let now = 1_500;
    let failWrite = false;
    let generated = 0;
    const observe = (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ) => {
      effects.push({ access: access(effect), context, port });
      if (
        port === "reconcile" &&
        access(effect)["analytics-script"] === "allowed"
      ) {
        portsFinished.resolve();
      }
      return Promise.resolve();
    };
    const client = createOpenCookie({
      broadcast: (effect, context) => observe("broadcast", effect, context),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect, context) => observe("reconcile", effect, context),
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: async (expected) => {
          if (failWrite) {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
          return clearIfCurrent(expected);
        },
        compareAndSet: (expected, candidate) =>
          failWrite
            ? Promise.reject(new Error("decision storage unavailable"))
            : compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    effects.length = 0;
    failWrite = true;

    const decision = client.acceptAll();
    await cleanupStarted.promise;
    await portsFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    now = Number.POSITIVE_INFINITY;
    releaseCleanup.resolve();

    await expect(decision).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );
    const allowed = {
      "analytics-script": "allowed",
      "personalization-script": "blocked",
    };
    const blocked = {
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    };
    expect(
      effects.map(({ access: observed, port }) => ({
        access: observed,
        port,
      })),
    ).toEqual([
      { access: allowed, port: "broadcast" },
      { access: allowed, port: "reconcile" },
      { access: blocked, port: "broadcast" },
      { access: blocked, port: "reconcile" },
    ]);
    expect(
      effects.slice(0, 2).every(({ context }) => context !== undefined),
    ).toBe(true);
    expect(effects.slice(2).every(({ context }) => context === undefined)).toBe(
      true,
    );
    expect(client.getSnapshot().runtime.effectiveAccess.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          access: "blocked",
          resourceId: "analytics-script",
        }),
      ]),
    );
  });

  it("allows a terminal to complete from a closed expiry replay", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    const compareAndSet = memory.store.compareAndSet;
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const portsFinished = deferred();
    const effects: Array<{
      readonly context: OpenCookiePortContext | undefined;
      readonly port: "broadcast" | "reconcile";
      readonly transitionId: string;
    }> = [];
    let now = 1_000;
    let generated = 0;
    let failWrite = false;
    let terminal:
      ReturnType<ReturnType<typeof createOpenCookie>["rejectAll"]> | undefined;
    const observe = async (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ): Promise<void> => {
      effects.push({ context, port, transitionId: effect.transitionId });
      const observed = access(effect);
      if (port === "reconcile" && observed["analytics-script"] === "allowed") {
        portsFinished.resolve();
      }
      if (
        port === "broadcast" &&
        context === undefined &&
        observed["analytics-script"] === "blocked" &&
        effect.record.method !== "reject-all"
      ) {
        terminal = client.rejectAll();
        await terminal;
      }
    };
    const client = createOpenCookie({
      broadcast: (effect, context) => observe("broadcast", effect, context),
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect, context) => observe("reconcile", effect, context),
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: async (expected) => {
          if (failWrite) {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
          return clearIfCurrent(expected);
        },
        compareAndSet: (expected, candidate) =>
          failWrite
            ? Promise.reject(new Error("decision storage unavailable"))
            : compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    effects.length = 0;
    failWrite = true;
    now = 1_500;

    const decision = client.acceptAll();
    await cleanupStarted.promise;
    await portsFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const pendingTransitionId = client.getSnapshot().pendingGrant?.transitionId;
    expect(pendingTransitionId).toBeDefined();
    now = 2_500;
    failWrite = false;
    releaseCleanup.resolve();

    await expect(decision).resolves.toMatchObject({ outcome: "invalidated" });
    if (terminal === undefined) {
      throw new Error("Closed replay did not start the terminal decision.");
    }
    await expect(terminal).resolves.toMatchObject({
      effect: { record: { method: "reject-all", revision: 2 } },
      outcome: "committed",
    });
    const pendingEffects = effects.filter(
      ({ transitionId }) => transitionId === pendingTransitionId,
    );
    const anyContext: unknown = expect.any(Object);
    expect(
      pendingEffects.map(({ context, port }) => ({ context, port })),
    ).toEqual([
      { context: anyContext, port: "broadcast" },
      { context: anyContext, port: "reconcile" },
      { context: undefined, port: "broadcast" },
      { context: anyContext, port: "broadcast" },
      { context: anyContext, port: "reconcile" },
    ]);
    for (const { context } of pendingEffects.slice(-2)) {
      if (context === undefined) {
        throw new Error("Reservation correction must expose a closed context.");
      }
      await expect(context.rejectAll()).rejects.toThrow(
        "OpenCookie port context is no longer active.",
      );
      await expect(context.withdrawConsent()).rejects.toThrow(
        "OpenCookie port context is no longer active.",
      );
    }
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all", revision: 2 },
    });
  });

  it("invalidates a closed-replay retry after a terminal reserves authority", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    const compareAndSet = memory.store.compareAndSet;
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const portsFinished = deferred();
    const terminalWriteStarted = deferred();
    const releaseTerminalWrite = deferred();
    let now = 1_000;
    let generated = 0;
    let failWrite = false;
    let nested:
      | Awaited<
          ReturnType<ReturnType<typeof createOpenCookie>["retryPendingGrant"]>
        >
      | undefined;
    let terminal:
      ReturnType<ReturnType<typeof createOpenCookie>["rejectAll"]> | undefined;
    const observe = async (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ): Promise<void> => {
      const observed = access(effect);
      if (port === "reconcile" && observed["analytics-script"] === "allowed") {
        portsFinished.resolve();
      }
      if (
        port === "broadcast" &&
        context === undefined &&
        observed["analytics-script"] === "blocked" &&
        effect.record.method !== "reject-all"
      ) {
        terminal = client.rejectAll();
        await terminalWriteStarted.promise;
        nested = await client.retryPendingGrant();
        releaseTerminalWrite.resolve();
        await terminal;
      }
    };
    const client = createOpenCookie({
      broadcast: (effect, context) => observe("broadcast", effect, context),
      consentDurationMs: 10_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect, context) => observe("reconcile", effect, context),
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: async (expected) => {
          if (failWrite) {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
          return clearIfCurrent(expected);
        },
        compareAndSet: async (expected, candidate) => {
          if (failWrite) {
            throw new Error("decision storage unavailable");
          }
          if (candidate.record?.method === "reject-all") {
            terminalWriteStarted.resolve();
            await releaseTerminalWrite.promise;
          }
          return compareAndSet(expected, candidate);
        },
      },
    });
    await client.initialize();
    failWrite = true;
    now = 1_500;

    const decision = client.acceptAll();
    await cleanupStarted.promise;
    await portsFinished.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    now = 2_500;
    failWrite = false;
    releaseCleanup.resolve();

    await expect(decision).resolves.toMatchObject({ outcome: "invalidated" });
    expect(nested).toMatchObject({ outcome: "not-applicable" });
    if (terminal === undefined) {
      throw new Error("Closed replay did not start the terminal decision.");
    }
    await expect(terminal).resolves.toMatchObject({ outcome: "committed" });
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all", revision: 2 },
    });
  });

  it.each(["same-intent", "retry"] as const)(
    "settles a %s request from a closed expiry replay",
    async (action) => {
      const policy = mixedRuntimePolicy();
      const memory = recoverableStore({
        record: { ...initialRecord(policy.policySnapshot), expiresAt: 2_000 },
      });
      const clearIfCurrent = memory.store.clearIfCurrent;
      const compareAndSet = memory.store.compareAndSet;
      const cleanupStarted = deferred();
      const releaseCleanup = deferred();
      const portsFinished = deferred();
      const effects: Array<{
        readonly access: ReturnType<typeof access>;
        readonly context: OpenCookiePortContext | undefined;
        readonly port: "broadcast" | "reconcile";
      }> = [];
      const receipt = vi.fn(() => Promise.resolve());
      let now = 1_000;
      let generated = 0;
      let failWrite = false;
      let nested:
        | ReturnType<ReturnType<typeof createOpenCookie>["acceptAll"]>
        | ReturnType<ReturnType<typeof createOpenCookie>["retryPendingGrant"]>
        | undefined;
      const observe = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
        context?: OpenCookiePortContext,
      ): Promise<void> => {
        const observed = access(effect);
        effects.push({ access: observed, context, port });
        if (
          port === "reconcile" &&
          observed["analytics-script"] === "allowed"
        ) {
          portsFinished.resolve();
        }
        if (
          port === "broadcast" &&
          context === undefined &&
          observed["analytics-script"] === "blocked"
        ) {
          nested =
            action === "same-intent"
              ? client.acceptAll()
              : client.retryPendingGrant();
          await nested;
        }
      };
      const client = createOpenCookie({
        broadcast: (effect, context) => observe("broadcast", effect, context),
        consentDurationMs: 10_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => now,
        receipt,
        reconcile: (effect, context) => observe("reconcile", effect, context),
        ...policy,
        store: {
          ...memory.store,
          clearIfCurrent: async (expected) => {
            if (failWrite) {
              cleanupStarted.resolve();
              await releaseCleanup.promise;
            }
            return clearIfCurrent(expected);
          },
          compareAndSet: (expected, candidate) =>
            failWrite
              ? Promise.reject(new Error("decision storage unavailable"))
              : compareAndSet(expected, candidate),
        },
      });
      await client.initialize();
      effects.length = 0;
      receipt.mockClear();
      failWrite = true;
      now = 1_500;

      const decision = client.acceptAll();
      await cleanupStarted.promise;
      await portsFinished.promise;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      now = 2_500;
      releaseCleanup.resolve();

      const outer = await decision;
      expect(outer).toMatchObject({ outcome: "pending" });
      if (nested === undefined) {
        throw new Error("Closed replay did not start the nested request.");
      }
      const inner = await nested;
      expect(inner).toMatchObject({ outcome: "pending" });
      if (!("transition" in outer) || !("transition" in inner)) {
        throw new Error("Pending requests must preserve transition identity.");
      }
      expect(inner.transition.transitionId).toBe(outer.transition.transitionId);
      const anyContext: unknown = expect.any(Object);
      expect(
        effects.map(({ access: observed, context, port }) => ({
          access: observed,
          context,
          port,
        })),
      ).toEqual([
        {
          access: {
            "analytics-script": "allowed",
            "personalization-script": "blocked",
          },
          context: anyContext,
          port: "broadcast",
        },
        {
          access: {
            "analytics-script": "allowed",
            "personalization-script": "blocked",
          },
          context: anyContext,
          port: "reconcile",
        },
        {
          access: {
            "analytics-script": "blocked",
            "personalization-script": "blocked",
          },
          context: undefined,
          port: "broadcast",
        },
        {
          access: {
            "analytics-script": "blocked",
            "personalization-script": "blocked",
          },
          context: undefined,
          port: "reconcile",
        },
      ]);
      expect(receipt).not.toHaveBeenCalled();
    },
  );

  it("never starts an allowed port after successful persistence crosses expiry", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore(null);
    const compareAndSet = memory.store.compareAndSet;
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const effects: ConsentRuntimeTransitionEffect[] = [];
    const receipt = vi.fn(() => Promise.resolve());
    let holdWrite = false;
    let now = 1_000;
    let generated = 0;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      receipt,
      reconcile: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      ...policy,
      store: {
        ...memory.store,
        compareAndSet: async (expected, candidate) => {
          if (!holdWrite) return compareAndSet(expected, candidate);
          writeStarted.resolve();
          await releaseWrite.promise;
          return compareAndSet(expected, candidate);
        },
      },
    });
    await client.initialize();
    holdWrite = true;
    const decision = client.acceptAll();
    await writeStarted.promise;
    now = 2_500;
    releaseWrite.resolve();

    const result = await decision;

    expect(result).toMatchObject({
      diagnostics: [{ code: "grant-expired-before-activation" }],
      outcome: "invalidated",
    });
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.map(access)).toEqual(
      effects.map(() => ({
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      })),
    );
    expect(receipt).not.toHaveBeenCalled();
  });

  it("cleans the exact active predecessor reached through pending lineage", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore(null);
    const compareAndSet = memory.store.compareAndSet;
    const receipt = vi.fn(() => Promise.resolve());
    const ids = ["record-a", "transition-a", "transition-b"];
    let failedFrom: PersistedConsentState | null = null;
    let rejectFirstIntended = true;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          rejectFirstIntended &&
          effect.transitionId === "transition-a" &&
          access(effect)["analytics-script"] === "allowed"
        ) {
          rejectFirstIntended = false;
          return Promise.reject(new Error("initial signal unavailable"));
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => 1_000,
      receipt,
      ...policy,
      store: {
        ...memory.store,
        compareAndSet: (expected, candidate) =>
          failedFrom !== null &&
          same(expected, failedFrom) &&
          candidate.pendingGrant?.transitionId === "transition-b"
            ? Promise.reject(new Error("active predecessor write failed"))
            : compareAndSet(expected, candidate),
      },
    });
    await client.initialize();
    const first = await client.acceptAll();
    expect(first).toMatchObject({ outcome: "pending" });
    const firstPending = memory.stored()?.pendingGrant;
    if (firstPending?.kind !== "decision") {
      throw new Error("First grant must remain durably pending.");
    }
    failedFrom = { record: firstPending.candidate };
    memory.replace(failedFrom);

    const second = await client.savePreferences(["analytics"]);
    if (second.outcome !== "pending") {
      throw new Error("Failed replacement must remain retryable.");
    }

    expect(access(second.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(memory.stored()).toBeNull();
    expect(receipt).not.toHaveBeenCalled();
  });

  it("clears a known unsafe predecessor when write and recovery reads fail", async () => {
    const policy = mixedRuntimePolicy();
    const durable = {
      ...initialRecord(policy.policySnapshot),
      decisions: { analytics: "granted", personalization: "granted" },
      method: "accept-all",
    } as PersistedDecisionRecord;
    const memory = recoverableStore({ record: durable });
    const read = memory.store.read;
    let readsFail = false;
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: {
        ...memory.store,
        read: () =>
          readsFail
            ? Promise.reject(new Error("decision read unavailable"))
            : read(),
      },
    });
    await client.initialize();
    memory.denyWrites();
    readsFail = true;

    const pending = await client.savePreferences(["analytics"]);

    expect(pending).toMatchObject({ outcome: "pending" });
    if (!("effect" in pending)) {
      throw new Error("Failed narrowing must expose its pending effect.");
    }
    expect(access(pending.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(memory.stored()).toBeNull();
    readsFail = false;
    const reloaded = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-reload`,
      now: () => 3_000,
      ...policy,
      store: memory.store,
    });
    await reloaded.initialize();
    expect(
      reloaded.getSnapshot().runtime.effectiveAccess.resources,
    ).toMatchObject([
      { access: "blocked", resourceId: "analytics-script" },
      { access: "blocked", resourceId: "personalization-script" },
    ]);
  });

  it("clears unsafe retry lineage when the recovery read fails", async () => {
    const policy = mixedRuntimePolicy();
    const durable = {
      ...initialRecord(policy.policySnapshot),
      decisions: { analytics: "granted", personalization: "granted" },
      method: "accept-all",
    } as PersistedDecisionRecord;
    const memory = recoverableStore({ record: durable });
    const read = memory.store.read;
    let readsFail = false;
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: {
        ...memory.store,
        read: () =>
          readsFail
            ? Promise.reject(new Error("decision read unavailable"))
            : read(),
      },
    });
    await client.initialize();
    memory.denyWrites();
    memory.denyClears();
    const first = await client.savePreferences(["analytics"]);
    expect(first).toMatchObject({ outcome: "pending" });
    expect(memory.stored()?.record?.decisions).toEqual({
      analytics: "granted",
      personalization: "granted",
    });
    memory.allowClears();
    readsFail = true;

    const retry = await client.retryPendingGrant();

    expect(retry).toMatchObject({
      diagnostics: [{ code: "grant-readback-invalid" }],
      outcome: "pending",
    });
    if (!("effect" in retry)) {
      throw new Error("Failed retry must expose its corrective effect.");
    }
    expect(access(retry.effect)).toEqual({
      "analytics-script": "allowed",
      "personalization-script": "blocked",
    });
    expect(memory.stored()).toBeNull();
    readsFail = false;
    const reloaded = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-reload`,
      now: () => 3_000,
      ...policy,
      store: memory.store,
    });
    await reloaded.initialize();
    expect(
      reloaded.getSnapshot().runtime.effectiveAccess.resources,
    ).toMatchObject([
      { access: "blocked", resourceId: "analytics-script" },
      { access: "blocked", resourceId: "personalization-script" },
    ]);
  });

  it("orders an external terminal after tracked failed-stage correction", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: { ...initialRecord(policy.policySnapshot), expiresAt: 3_000 },
    });
    const correctionStarted = deferred();
    const releaseCorrection = deferred();
    const effects: Array<{
      readonly access: ReturnType<typeof access>;
      readonly port: "broadcast" | "reconcile";
      readonly transitionId: string;
    }> = [];
    const transitions = [
      "transition-restore",
      "transition-grant",
      "transition-terminal",
    ];
    let now = 2_000;
    const observe = async (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
    ): Promise<void> => {
      effects.push({
        access: access(effect),
        port,
        transitionId: effect.transitionId,
      });
      if (
        port === "broadcast" &&
        effect.transitionId === "transition-grant" &&
        effect.persistenceStatus === "pending"
      ) {
        correctionStarted.resolve();
        await releaseCorrection.promise;
      }
    };
    const client = createOpenCookie({
      broadcast: (effect) => observe("broadcast", effect),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record"
          ? "record-1"
          : (transitions.shift() ?? "unexpected-transition"),
      now: () => now,
      reconcile: (effect) => observe("reconcile", effect),
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    effects.length = 0;
    memory.denyWrites();
    const grant = client.acceptAll();
    await correctionStarted.promise;
    memory.allowWrites();

    const terminal = client.rejectAll();
    await vi.waitFor(() => {
      expect(memory.stored()?.record?.method).toBe("reject-all");
    });
    now = 4_000;
    releaseCorrection.resolve();
    const [grantResult, terminalResult] = await Promise.all([grant, terminal]);

    expect(grantResult).toMatchObject({ outcome: "invalidated" });
    expect(terminalResult).toMatchObject({ outcome: "committed" });
    expect(effects.slice(0, 4)).toEqual([
      {
        access: {
          "analytics-script": "allowed",
          "personalization-script": "blocked",
        },
        port: "broadcast",
        transitionId: "transition-grant",
      },
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "broadcast",
        transitionId: "transition-grant",
      },
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "broadcast",
        transitionId: "transition-terminal",
      },
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "reconcile",
        transitionId: "transition-terminal",
      },
    ]);
    expect(effects.at(-1)).toEqual({
      access: {
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      },
      port: "reconcile",
      transitionId: "transition-terminal",
    });
  });

  it("clears a stale durable grant after a failed terminal replacement", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    let now = 1_000;
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.denyWrites();
    memory.denyClears();
    now = 2_000;
    const denied = await client.rejectAll();
    expect(denied).toMatchObject({ outcome: "degraded" });
    expect(memory.stored()?.record?.decisions).toEqual({
      analytics: "granted",
      personalization: "denied",
    });
    expect(client.getSnapshot().record?.decisions).toEqual([
      { purposeId: "analytics", value: "denied" },
      { purposeId: "personalization", value: "denied" },
    ]);
    memory.allowClears();
    now = 3_000;

    const pending = await client.acceptAll();

    expect(pending).toMatchObject({ outcome: "pending" });
    expect(memory.stored()).toBeNull();
    const reloaded = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-reload`,
      now: () => now,
      ...policy,
      store: memory.store,
    });
    await reloaded.initialize();
    expect(reloaded.getSnapshot()).toMatchObject({
      runtime: { accessConsent: { status: "first-visit" } },
    });
    expect(
      reloaded.getSnapshot().runtime.effectiveAccess.resources,
    ).toMatchObject([
      { access: "blocked", resourceId: "analytics-script" },
      { access: "blocked", resourceId: "personalization-script" },
    ]);
  });

  it("preserves a longer-lived durable denial that cannot restore access", async () => {
    const policy = mixedRuntimePolicy();
    const durableDenial: PersistedDecisionRecord = {
      catalogueDigest: policy.policySnapshot.catalogueDigest,
      decidedAt: 1_000,
      decisionSurfaceDigest: policy.policySnapshot.decisionSurfaceDigest,
      decisions: { analytics: "denied", personalization: "denied" },
      expiresAt: 10_000,
      method: "reject-all",
      policyVersion: policy.policySnapshot.policyVersion,
      recordId: "record-1",
      revision: 1,
    };
    const memory = recoverableStore({ record: durableDenial });
    memory.denyWrites();
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: memory.store,
    });
    await client.initialize();

    const pending = await client.acceptAll();
    if (pending.outcome !== "pending") {
      throw new Error("Failed widening must remain retryable.");
    }

    expect(pending).toMatchObject({ outcome: "pending" });
    expect(access(pending.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(memory.stored()).toEqual({ record: durableDenial });
  });

  it("continues exact stale-grant cleanup after candidate cleanup rejects", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const clearIfCurrent = memory.store.clearIfCurrent;
    let clearAttempts = 0;
    memory.denyWrites();
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: (expected) => {
          clearAttempts += 1;
          return clearAttempts === 1
            ? Promise.reject(new Error("candidate cleanup unavailable"))
            : clearIfCurrent(expected);
        },
      },
    });
    await client.initialize();

    const pending = await client.savePreferences(["personalization"]);
    if (pending.outcome !== "pending") {
      throw new Error("Failed replacement must remain retryable.");
    }

    expect(pending).toMatchObject({ outcome: "pending" });
    expect(access(pending.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(clearAttempts).toBe(2);
    expect(memory.stored()).toBeNull();
  });

  it("blocks stale pending access after an unrelated writer revokes consent", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    memory.denyWrites();
    memory.denyClears();

    const first = await client.acceptAll();
    expect(first).toMatchObject({ outcome: "pending" });

    const externalDenial: PersistedDecisionRecord = {
      ...initialRecord(policy.policySnapshot),
      decidedAt: 1_500,
      decisions: { analytics: "denied", personalization: "denied" },
      method: "reject-all",
      recordId: "record-external",
      revision: 7,
    };
    memory.replace({ record: externalDenial });
    memory.allowClears();

    const second = await client.savePreferences([
      "analytics",
      "personalization",
    ]);

    expect(second).toMatchObject({ outcome: "pending" });
    if (!("effect" in second)) {
      throw new Error("Conflicted replacement must expose a pending effect.");
    }
    expect(access(second.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(memory.stored()).toEqual({ record: externalDenial });
  });

  it.each([
    "unrelated-readback",
    "missing-readback",
    "invalid-readback",
    "unrelated-recovery",
  ] as const)(
    "blocks stale access after a %s disproves the write predecessor",
    async (mode) => {
      const policy = mixedRuntimePolicy();
      const memory = recoverableStore({
        record: initialRecord(policy.policySnapshot),
      });
      const compareAndSet = memory.store.compareAndSet;
      const read = memory.store.read;
      const externalDenial: PersistedDecisionRecord = {
        ...initialRecord(policy.policySnapshot),
        decidedAt: 1_500,
        decisions: { analytics: "denied", personalization: "denied" },
        method: "reject-all",
        recordId: "record-external",
        revision: 7,
      };
      let armed = false;
      let generated = 0;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => 2_000,
        ...policy,
        store: {
          ...memory.store,
          compareAndSet: async (expected, candidate) => {
            if (!armed) return compareAndSet(expected, candidate);
            if (mode === "unrelated-recovery") {
              memory.replace({ record: externalDenial });
              throw new Error("write acknowledgement unavailable");
            }
            const result = await compareAndSet(expected, candidate);
            memory.replace(
              mode === "missing-readback" ? null : { record: externalDenial },
            );
            return result;
          },
          read: () =>
            armed && mode === "invalid-readback"
              ? Promise.resolve({
                  reason: "malformed-json" as const,
                  status: "invalid" as const,
                })
              : read(),
        },
      });
      await client.initialize();
      armed = true;

      const pending = await client.acceptAll();

      expect(pending).toMatchObject({ outcome: "pending" });
      if (!("effect" in pending)) {
        throw new Error("Unconfirmed write must expose a pending effect.");
      }
      expect(access(pending.effect)).toEqual({
        "analytics-script": "blocked",
        "personalization-script": "blocked",
      });
      expect(memory.stored()).toEqual(
        mode === "missing-readback" ? null : { record: externalDenial },
      );
    },
  );

  it("does not let stale cleanup erase a newer unchanged choice", async () => {
    const policy = mixedRuntimePolicy();
    const original = initialRecord(policy.policySnapshot);
    const memory = recoverableStore({ record: original });
    const clearIfCurrent = memory.store.clearIfCurrent;
    const read = memory.store.read;
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    const secondRead = deferred();
    let holdCleanup = true;
    let observeSecond = false;
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...policy,
      store: {
        ...memory.store,
        clearIfCurrent: async (expected) => {
          if (holdCleanup && expected.pendingGrant) {
            cleanupStarted.resolve();
            await releaseCleanup.promise;
          }
          return clearIfCurrent(expected);
        },
        read: () => {
          if (observeSecond) secondRead.resolve();
          return read();
        },
      },
    });
    await client.initialize();
    memory.denyWrites();

    const first = client.savePreferences(["personalization"]);
    await cleanupStarted.promise;
    memory.allowWrites();
    observeSecond = true;
    const second = client.savePreferences(["analytics"]);
    await secondRead.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(memory.stored()).toEqual({ record: original });

    holdCleanup = false;
    releaseCleanup.resolve();
    await expect(first).resolves.toMatchObject({ outcome: "invalidated" });
    await expect(second).resolves.toMatchObject({ outcome: "unchanged" });
    expect(memory.stored()).toEqual({ record: original });
    expect(client.getSnapshot()).not.toHaveProperty("pendingGrant");
  });

  it("uses an exact unrelated readback to persist a later rejection", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const compareAndSet = memory.store.compareAndSet;
    const externalGrant: PersistedDecisionRecord = {
      ...initialRecord(policy.policySnapshot),
      decidedAt: 5_000,
      decisions: { analytics: "granted", personalization: "granted" },
      expiresAt: 90_000,
      method: "accept-all",
      recordId: "record-external",
      revision: 7,
    };
    let raceReadback = false;
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 6_000,
      ...policy,
      store: {
        ...memory.store,
        compareAndSet: async (expected, candidate) => {
          const result = await compareAndSet(expected, candidate);
          if (
            raceReadback &&
            result.status === "written" &&
            candidate.pendingGrant
          ) {
            raceReadback = false;
            memory.replace({ record: externalGrant });
          }
          return result;
        },
      },
    });
    await client.initialize();
    raceReadback = true;

    const pending = await client.acceptAll();
    expect(pending).toMatchObject({ outcome: "pending" });
    if (!("effect" in pending)) {
      throw new Error("Conflicted readback must expose a pending effect.");
    }
    expect(access(pending.effect)).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(memory.stored()).toEqual({ record: externalGrant });

    const terminal = await client.rejectAll();

    expect(terminal).toMatchObject({
      outcome: "committed",
      transition: {
        record: {
          method: "reject-all",
          recordId: externalGrant.recordId,
          revision: 8,
        },
      },
    });
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all", revision: 8 },
    });
    const reloaded = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-reload`,
      now: () => 7_000,
      ...policy,
      store: memory.store,
    });
    await reloaded.initialize();
    expect(
      reloaded.getSnapshot().runtime.effectiveAccess.resources,
    ).toMatchObject([
      { access: "blocked", resourceId: "analytics-script" },
      { access: "blocked", resourceId: "personalization-script" },
    ]);
  });

  it("blocks retained access when retry reprojection reads an invalid clock", async () => {
    const policy = mixedRuntimePolicy();
    const memory = recoverableStore({
      record: initialRecord(policy.policySnapshot),
    });
    const effects: Array<{
      readonly access: ReturnType<typeof access>;
      readonly port: "broadcast" | "reconcile";
    }> = [];
    let now = 2_000;
    let generated = 0;
    const observe = (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
    ) => {
      effects.push({ access: access(effect), port });
      return Promise.resolve();
    };
    const client = createOpenCookie({
      broadcast: (effect) => observe("broadcast", effect),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect) => observe("reconcile", effect),
      ...policy,
      store: memory.store,
    });
    await client.initialize();
    effects.length = 0;
    memory.denyWrites();

    const pending = await client.acceptAll();
    if (pending.outcome !== "pending") {
      throw new Error("Failed widening must remain retryable.");
    }
    expect(access(pending.effect)["analytics-script"]).toBe("allowed");
    const marker = effects.length;
    now = Number.POSITIVE_INFINITY;

    await expect(client.retryPendingGrant()).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );

    expect(
      Object.fromEntries(
        client
          .getSnapshot()
          .runtime.effectiveAccess.resources.map(
            ({ access: resourceAccess, resourceId }) => [
              resourceId,
              resourceAccess,
            ],
          ),
      ),
    ).toEqual({
      "analytics-script": "blocked",
      "personalization-script": "blocked",
    });
    expect(effects.slice(marker)).toEqual([
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "broadcast",
      },
      {
        access: {
          "analytics-script": "blocked",
          "personalization-script": "blocked",
        },
        port: "reconcile",
      },
    ]);
  });
});
