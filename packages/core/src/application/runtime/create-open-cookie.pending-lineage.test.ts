import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type DecisionStoreReadResult,
  type PersistedConsentState,
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

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

interface WriteObservation {
  readonly candidate: PersistedConsentState;
  readonly count: number;
  readonly expected: PersistedConsentState | null;
}

interface StoreOptions {
  readonly clearIfCurrent?: (observation: {
    readonly count: number;
    readonly durable: PersistedConsentState | null;
    readonly expected: PersistedConsentState;
  }) => "cleared" | "conflict" | "reject" | Promise<never> | undefined;
  readonly read?: (observation: {
    readonly count: number;
    readonly durable: PersistedConsentState | null;
  }) => DecisionStoreReadResult | undefined;
  readonly throwBeforeWrite?: (observation: WriteObservation) => boolean;
  readonly writeThenReject?: (
    observation: WriteObservation,
  ) => Promise<never> | undefined;
  readonly writeThenThrow?: (observation: WriteObservation) => boolean;
}

function controlledStore(options: StoreOptions = {}): {
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  let clearCount = 0;
  let durable: PersistedConsentState | null = null;
  let readCount = 0;
  let writeCount = 0;
  return {
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        clearCount += 1;
        const overridden = options.clearIfCurrent?.({
          count: clearCount,
          durable,
          expected,
        });
        if (overridden === "reject") {
          return Promise.reject(new Error("clear unavailable"));
        }
        if (overridden instanceof Promise) return overridden;
        if (overridden !== undefined) return Promise.resolve(overridden);
        if (durable === null) return Promise.resolve("cleared" as const);
        if (!statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        writeCount += 1;
        if (!statesEqual(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        const observation = { candidate, count: writeCount, expected };
        if (options.throwBeforeWrite?.(observation) === true) {
          return Promise.reject(new Error("write unavailable"));
        }
        durable = candidate;
        const rejected = options.writeThenReject?.(observation);
        if (rejected !== undefined) return rejected;
        if (options.writeThenThrow?.(observation) === true) {
          return Promise.reject(new Error("write acknowledgement lost"));
        }
        return Promise.resolve({ status: "written" as const });
      },
      read: () => {
        readCount += 1;
        const overridden = options.read?.({ count: readCount, durable });
        return Promise.resolve(
          overridden ??
            (durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const }),
        );
      },
    },
    stored: () => durable,
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

function rejectableDeferred<Result = void>(): {
  readonly promise: Promise<Result>;
  readonly reject: () => void;
} {
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((_resolve, fail) => {
    reject = fail;
  });
  return {
    promise,
    reject: () => {
      reject(new Error("signal failed after supersession"));
    },
  };
}

async function reload(
  store: DecisionStore,
  effects: ConsentRuntimeTransitionEffect[],
  now = 4_000,
) {
  const client = createOpenCookie({
    broadcast: (effect) => {
      effects.push(effect);
      return Promise.resolve();
    },
    consentDurationMs: 86_400_000,
    idGenerator: () => "transition-reload",
    now: () => now,
    ...runtimePolicy(),
    store,
  });
  return client.initialize();
}

function isRefreshedPending(state: PersistedConsentState): boolean {
  return (
    state.pendingGrant?.kind === "decision" &&
    state.pendingGrant.receiptOccurredAt === 2_000
  );
}

function failFirstActiveGrantRead(): NonNullable<StoreOptions["read"]> {
  let failed = false;
  return ({ durable }) => {
    if (
      !failed &&
      durable?.pendingGrant === undefined &&
      durable?.record?.method === "accept-all"
    ) {
      failed = true;
      throw new Error("activation readback unavailable");
    }
    return undefined;
  };
}

describe("createOpenCookie exact pending state lineage", () => {
  it.each(["reject", "withdraw"] as const)(
    "supersedes an ambiguously refreshed grant with %s and cannot reactivate it after reload",
    async (action) => {
      const memory = controlledStore({
        writeThenThrow: ({ candidate }) => isRefreshedPending(candidate),
      });
      const ids = ["record-a", "transition-a", "transition-terminal"];
      let now = 1_000;
      let firstAllowed = true;
      const client = createOpenCookie({
        broadcast: (effect) => {
          if (accessOf(effect) === "allowed" && firstAllowed) {
            firstAllowed = false;
            return Promise.reject(new Error("initial signal failed"));
          }
          return Promise.resolve();
        },
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected-id",
        now: () => now,
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();
      await client.acceptAll();

      now = 2_000;
      await expect(client.retryPendingGrant()).resolves.toMatchObject({
        diagnostics: [{ code: "grant-write-failed" }],
        outcome: "pending",
      });
      expect(memory.stored()).toBeNull();

      now = 3_000;
      const terminal = await (action === "reject"
        ? client.rejectAll()
        : client.withdrawConsent());
      const durableBeforeReload = memory.stored();
      const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
      const restored = await reload(memory.store, reloadEffects);

      expect(terminal).toMatchObject({ outcome: "committed" });
      expect(durableBeforeReload).toMatchObject({
        record: { method: "reject-all", revision: 1 },
      });
      expect(durableBeforeReload).not.toHaveProperty("pendingGrant");
      expect(restored).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all", revision: 1 },
      });
      expect(
        reloadEffects.some((effect) => accessOf(effect) === "allowed"),
      ).toBe(false);
    },
  );

  it("clears every plausible pending state when refreshed-grant terminal persistence is ambiguous", async () => {
    const memory = controlledStore({
      throwBeforeWrite: ({ candidate }) =>
        candidate.pendingGrant === undefined &&
        candidate.record?.method === "reject-all",
      writeThenThrow: ({ candidate }) => isRefreshedPending(candidate),
    });
    const ids = ["record-a", "transition-a", "transition-terminal"];
    let now = 1_000;
    let firstAllowed = true;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (accessOf(effect) === "allowed" && firstAllowed) {
          firstAllowed = false;
          return Promise.reject(new Error("initial signal failed"));
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    await client.acceptAll();
    now = 2_000;
    await client.retryPendingGrant();

    now = 3_000;
    const terminal = await client.rejectAll();
    const durableBeforeReload = memory.stored();
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const restored = await reload(memory.store, reloadEffects);

    expect(terminal).toMatchObject({
      diagnostics: [{ code: "denial-persistence-failed" }],
      outcome: "degraded",
    });
    expect(durableBeforeReload).toBeNull();
    expect(restored).toMatchObject({ grantActivation: "not-applicable" });
    expect(restored).not.toHaveProperty("record");
    expect(reloadEffects).toEqual([]);
  });

  it("replaces an ambiguously written first intent from its exact durable state", async () => {
    const memory = controlledStore({
      writeThenThrow: ({ candidate }) =>
        candidate.pendingGrant?.transitionId === "transition-a",
    });
    const ids = ["record-a", "transition-a", "transition-b"];
    const effects: ConsentRuntimeTransitionEffect[] = [];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
      transition: { transitionId: "transition-a" },
    });
    now = 2_000;
    const replacement = await client.savePreferences(["analytics"]);
    const durableBeforeReload = memory.stored();
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const restored = await reload(memory.store, reloadEffects, 3_000);

    expect(replacement).toMatchObject({
      outcome: "committed",
      transition: {
        record: { method: "granular", recordId: "record-a", revision: 1 },
        transitionId: "transition-b",
      },
    });
    expect(durableBeforeReload).toMatchObject({
      record: { method: "granular", recordId: "record-a", revision: 1 },
    });
    expect(durableBeforeReload).not.toHaveProperty("pendingGrant");
    expect(restored).toMatchObject({
      grantActivation: "active",
      record: { method: "granular", recordId: "record-a", revision: 1 },
    });
    expect(
      reloadEffects
        .filter((effect) => accessOf(effect) === "allowed")
        .map((effect) => effect.record.method),
    ).toEqual(["granular"]);
    expect(effects.map((effect) => effect.transitionId)).toEqual([
      "transition-a",
      "transition-b",
    ]);
  });

  it("does not broadcast a queued grant after a newer denial is durable", async () => {
    const memory = controlledStore();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const ids = [
      "record-a",
      "transition-a",
      "transition-b",
      "transition-terminal",
    ];
    const order: string[] = [];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        const access = accessOf(effect);
        const label =
          effect.transitionId === "transition-a"
            ? "A"
            : effect.transitionId === "transition-b"
              ? "B"
              : "terminal";
        order.push(`${label} ${access}`);
        if (label === "A" && access === "allowed") {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      reconcile: (effect) => {
        const label =
          effect.transitionId === "transition-a"
            ? "A"
            : effect.transitionId === "transition-b"
              ? "B"
              : "terminal";
        order.push(`${label} reconcile ${accessOf(effect)}`);
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
    await expect
      .poll(() => memory.stored()?.pendingGrant?.transitionId)
      .toBe("transition-b");
    now = 3_000;
    const terminal = client.rejectAll();
    await expect.poll(() => memory.stored()?.record?.method).toBe("reject-all");
    releaseFirst.resolve();

    const [firstResult, secondResult, terminalResult] = await Promise.all([
      first,
      second,
      terminal,
    ]);
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const restored = await reload(memory.store, reloadEffects, 4_000);

    expect(firstResult).toMatchObject({ outcome: "invalidated" });
    expect(secondResult).toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      outcome: "invalidated",
    });
    expect(terminalResult).toMatchObject({ outcome: "committed" });
    expect(order.filter((entry) => entry.endsWith("allowed"))).toEqual([
      "A allowed",
    ]);
    expect(order.filter((entry) => !entry.includes("reconcile")).at(-1)).toBe(
      "terminal blocked",
    );
    expect(order.filter((entry) => entry.includes("reconcile")).at(-1)).toBe(
      "terminal reconcile blocked",
    );
    expect(restored).toMatchObject({
      grantActivation: "not-applicable",
      record: { method: "reject-all" },
    });
    expect(reloadEffects).toEqual([]);
  });

  it("retains supersession when an in-flight broadcaster rejects", async () => {
    const memory = controlledStore();
    const firstStarted = deferred();
    const firstSignal = rejectableDeferred();
    const ids = ["record-a", "transition-a", "transition-terminal"];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.transitionId === "transition-a" &&
          accessOf(effect) === "allowed"
        ) {
          firstStarted.resolve();
          return firstSignal.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const first = client.acceptAll();
    await firstStarted.promise;
    now = 2_000;
    const terminal = client.rejectAll();
    await expect.poll(() => memory.stored()?.record?.method).toBe("reject-all");
    firstSignal.reject();

    await expect(first).resolves.toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      outcome: "invalidated",
    });
    await expect(terminal).resolves.toMatchObject({ outcome: "committed" });
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const restored = await reload(memory.store, reloadEffects, 3_000);
    expect(restored).toMatchObject({
      grantActivation: "not-applicable",
      record: { method: "reject-all" },
    });
    expect(reloadEffects).toEqual([]);
  });

  it.each(["reject", "withdraw"] as const)(
    "supersedes an ambiguously activated grant with %s after retry and cannot restore it",
    async (action) => {
      const memory = controlledStore({
        read: failFirstActiveGrantRead(),
      });
      const ids = ["record-a", "transition-a", "transition-terminal"];
      let now = 1_000;
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected-id",
        now: () => now,
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();

      await expect(client.acceptAll()).resolves.toMatchObject({
        diagnostics: [{ code: "grant-activation-unconfirmed" }],
        outcome: "pending",
      });
      expect(memory.stored()).toMatchObject({
        pendingGrant: { transitionId: "transition-a" },
      });
      now = 2_000;
      await expect(client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "committed",
      });

      now = 3_000;
      const terminal = await (action === "reject"
        ? client.rejectAll()
        : client.withdrawConsent());
      const durableBeforeReload = memory.stored();
      const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
      const restored = await reload(memory.store, reloadEffects, 4_000);

      expect(terminal).toMatchObject({ outcome: "committed" });
      expect(durableBeforeReload).toMatchObject({
        record: {
          method: action === "reject" ? "reject-all" : "withdrawal",
          revision: 2,
        },
      });
      expect(restored).toMatchObject({
        grantActivation: "not-applicable",
        record: {
          method: action === "reject" ? "reject-all" : "withdrawal",
          revision: 2,
        },
      });
      expect(reloadEffects).toEqual([]);
    },
  );

  it("clears a possibly active grant when terminal persistence after activation ambiguity fails", async () => {
    const memory = controlledStore({
      read: failFirstActiveGrantRead(),
      throwBeforeWrite: ({ candidate }) =>
        candidate.pendingGrant === undefined &&
        candidate.record?.method === "reject-all",
    });
    const ids = ["record-a", "transition-a", "transition-terminal"];
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    await client.acceptAll();

    now = 2_000;
    const terminal = await client.rejectAll();
    const durableBeforeReload = memory.stored();
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const restored = await reload(memory.store, reloadEffects, 3_000);

    expect(terminal).toMatchObject({
      diagnostics: [{ code: "denial-persistence-failed" }],
      outcome: "degraded",
    });
    expect(durableBeforeReload).toBeNull();
    expect(restored).toMatchObject({ grantActivation: "not-applicable" });
    expect(restored).not.toHaveProperty("record");
    expect(reloadEffects).toEqual([]);
  });

  it("stages a different intent from a possibly active grant and restores only the replacement", async () => {
    const memory = controlledStore({
      read: failFirstActiveGrantRead(),
    });
    const ids = ["record-a", "transition-a", "transition-b"];
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    await client.acceptAll();

    now = 2_000;
    const replacement = await client.savePreferences(["analytics"]);
    const durableBeforeReload = memory.stored();
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const restored = await reload(memory.store, reloadEffects, 3_000);

    expect(replacement).toMatchObject({
      outcome: "committed",
      transition: {
        record: { method: "granular", recordId: "record-a" },
        transitionId: "transition-b",
      },
    });
    expect(durableBeforeReload).toMatchObject({
      record: { method: "granular", recordId: "record-a" },
    });
    expect(restored).toMatchObject({
      grantActivation: "active",
      record: { method: "granular", recordId: "record-a" },
    });
    expect(
      reloadEffects
        .filter((effect) => accessOf(effect) === "allowed")
        .map((effect) => effect.record.method),
    ).toEqual(["granular"]);
  });

  it("continues exact cleanup after one clear candidate rejects", async () => {
    const memory = controlledStore({
      clearIfCurrent: ({ count }) => (count === 1 ? "reject" : undefined),
      throwBeforeWrite: ({ candidate }) =>
        candidate.pendingGrant === undefined &&
        candidate.record?.method === "reject-all",
      writeThenThrow: ({ candidate }) => isRefreshedPending(candidate),
    });
    const ids = ["record-a", "transition-a", "transition-terminal"];
    let now = 1_000;
    let firstAllowed = true;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (accessOf(effect) === "allowed" && firstAllowed) {
          firstAllowed = false;
          return Promise.reject(new Error("initial signal failed"));
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    await client.acceptAll();
    now = 2_000;
    await client.retryPendingGrant();

    now = 3_000;
    const terminal = await client.rejectAll();
    const durableBeforeReload = memory.stored();
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const restored = await reload(memory.store, reloadEffects, 4_000);

    expect(terminal).toMatchObject({
      diagnostics: [{ code: "denial-persistence-failed" }],
      outcome: "degraded",
    });
    expect(durableBeforeReload).toBeNull();
    expect(restored).toMatchObject({ grantActivation: "not-applicable" });
    expect(reloadEffects).toEqual([]);
  });

  it("blocks every queued grant after a newer terminal decision is durable", async () => {
    const memory = controlledStore();
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const ids = [
      "record-a",
      "transition-a",
      "transition-b",
      "transition-d",
      "transition-terminal",
    ];
    const order: string[] = [];
    let now = 1_000;
    const labelOf = (transitionId: string): string =>
      transitionId === "transition-a"
        ? "A"
        : transitionId === "transition-b"
          ? "B"
          : transitionId === "transition-d"
            ? "D"
            : "terminal";
    const client = createOpenCookie({
      broadcast: (effect) => {
        const label = labelOf(effect.transitionId);
        const access = accessOf(effect);
        order.push(`${label} ${access}`);
        if (label === "A" && access === "allowed") {
          firstStarted.resolve();
          return releaseFirst.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      reconcile: (effect) => {
        order.push(
          `${labelOf(effect.transitionId)} reconcile ${accessOf(effect)}`,
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
    await expect
      .poll(() => memory.stored()?.pendingGrant?.transitionId)
      .toBe("transition-b");
    now = 3_000;
    const third = client.acceptAll();
    await expect
      .poll(() => memory.stored()?.pendingGrant?.transitionId)
      .toBe("transition-d");
    now = 4_000;
    const terminal = client.rejectAll();
    await expect.poll(() => memory.stored()?.record?.method).toBe("reject-all");
    releaseFirst.resolve();

    const [firstResult, secondResult, thirdResult, terminalResult] =
      await Promise.all([first, second, third, terminal]);

    expect(firstResult).toMatchObject({ outcome: "invalidated" });
    expect(secondResult).toMatchObject({ outcome: "invalidated" });
    expect(thirdResult).toMatchObject({ outcome: "invalidated" });
    expect(terminalResult).toMatchObject({ outcome: "committed" });
    expect(order.filter((entry) => entry.endsWith("allowed"))).toEqual([
      "A allowed",
    ]);
    expect(order.filter((entry) => !entry.includes("reconcile")).at(-1)).toBe(
      "terminal blocked",
    );
    expect(order.filter((entry) => entry.includes("reconcile")).at(-1)).toBe(
      "terminal reconcile blocked",
    );
  });

  it("invalidates every queued attempt when the in-flight broadcaster rejects after terminal durability", async () => {
    const memory = controlledStore();
    const firstStarted = deferred();
    const firstSignal = rejectableDeferred();
    const ids = [
      "record-a",
      "transition-a",
      "transition-b",
      "transition-terminal",
    ];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.transitionId === "transition-a" &&
          accessOf(effect) === "allowed"
        ) {
          firstStarted.resolve();
          return firstSignal.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const first = client.acceptAll();
    await firstStarted.promise;
    now = 2_000;
    const second = client.savePreferences(["analytics"]);
    await expect
      .poll(() => memory.stored()?.pendingGrant?.transitionId)
      .toBe("transition-b");
    now = 3_000;
    const terminal = client.rejectAll();
    await expect.poll(() => memory.stored()?.record?.method).toBe("reject-all");
    firstSignal.reject();

    const [firstResult, secondResult, terminalResult] = await Promise.all([
      first,
      second,
      terminal,
    ]);
    expect(firstResult).toMatchObject({
      diagnostics: [
        { code: "grant-activation-conflict" },
        { code: "grant-superseded" },
      ],
      outcome: "invalidated",
    });
    expect(secondResult).toMatchObject({ outcome: "invalidated" });
    expect(terminalResult).toMatchObject({ outcome: "committed" });
  });

  it("supersedes every tracked grant before an ambiguous terminal write can await cleanup", async () => {
    const terminalDurable = deferred();
    const rejectTerminalWrite = rejectableDeferred<never>();
    const firstClearStarted = deferred();
    const rejectFirstClear = rejectableDeferred<never>();
    const memory = controlledStore({
      clearIfCurrent: ({ count }) => {
        if (count !== 1) return undefined;
        firstClearStarted.resolve();
        return rejectFirstClear.promise;
      },
      writeThenReject: ({ candidate }) => {
        if (
          candidate.pendingGrant !== undefined ||
          candidate.record?.method !== "reject-all"
        ) {
          return undefined;
        }
        terminalDurable.resolve();
        return rejectTerminalWrite.promise;
      },
    });
    const firstStarted = deferred();
    const firstSignal = rejectableDeferred();
    const ids = [
      "record-a",
      "transition-a",
      "transition-b",
      "transition-d",
      "transition-terminal",
    ];
    const order: string[] = [];
    let now = 1_000;
    const labelOf = (transitionId: string): string =>
      transitionId === "transition-a"
        ? "A"
        : transitionId === "transition-b"
          ? "B"
          : transitionId === "transition-d"
            ? "D"
            : "terminal";
    const client = createOpenCookie({
      broadcast: (effect) => {
        const label = labelOf(effect.transitionId);
        const access = accessOf(effect);
        order.push(`${label} ${access}`);
        if (label === "A" && access === "allowed") {
          firstStarted.resolve();
          return firstSignal.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => now,
      reconcile: (effect) => {
        order.push(
          `${labelOf(effect.transitionId)} reconcile ${accessOf(effect)}`,
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
    await expect
      .poll(() => memory.stored()?.pendingGrant?.transitionId)
      .toBe("transition-b");
    now = 3_000;
    const third = client.acceptAll();
    await expect
      .poll(() => memory.stored()?.pendingGrant?.transitionId)
      .toBe("transition-d");
    now = 4_000;
    const terminal = client.rejectAll();
    await terminalDurable.promise;
    expect(memory.stored()).toMatchObject({
      record: { method: "reject-all" },
    });

    firstSignal.reject();
    await expect
      .poll(() => order.filter((entry) => entry.includes("reconcile")).at(-1))
      .toBe("D reconcile blocked");
    rejectTerminalWrite.reject();
    await firstClearStarted.promise;
    rejectFirstClear.reject();

    const [firstResult, secondResult, thirdResult, terminalResult] =
      await Promise.all([first, second, third, terminal]);

    expect(firstResult).toMatchObject({ outcome: "invalidated" });
    expect(secondResult).toMatchObject({ outcome: "invalidated" });
    expect(thirdResult).toMatchObject({ outcome: "invalidated" });
    expect(terminalResult).toMatchObject({
      diagnostics: [
        { code: "denial-persistence-failed" },
        { code: "denial-clear-failed" },
      ],
      outcome: "degraded",
    });
    expect(order.filter((entry) => entry.endsWith("allowed"))).toEqual([
      "A allowed",
    ]);
    expect(order.filter((entry) => !entry.includes("reconcile")).at(-1)).toBe(
      "terminal blocked",
    );
    expect(order.filter((entry) => entry.includes("reconcile")).at(-1)).toBe(
      "terminal reconcile blocked",
    );
  });

  it("expires a detached corrective terminal after its callback settles", async () => {
    const memory = controlledStore();
    const terminalInvoked = deferred();
    const ids = ["record-a", "transition-a", "transition-terminal"];
    let terminalPromise:
      ReturnType<ReturnType<typeof createOpenCookie>["rejectAll"]> | undefined;
    const client = createOpenCookie({
      broadcast: (effect) =>
        effect.transitionId === "transition-a" && accessOf(effect) === "allowed"
          ? Promise.reject(new Error("intended signal failed"))
          : Promise.resolve(),
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => 1_000,
      reconcile: (effect, context) => {
        if (
          effect.transitionId === "transition-a" &&
          accessOf(effect) === "blocked"
        ) {
          queueMicrotask(() => {
            queueMicrotask(() => {
              if (context === undefined) {
                terminalInvoked.resolve();
                return;
              }
              terminalPromise = context.rejectAll();
              terminalInvoked.resolve();
            });
          });
        }
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const grant = client.acceptAll();
    await terminalInvoked.promise;
    if (terminalPromise === undefined) {
      throw new Error("Corrective reconcile must reserve reject-all.");
    }
    const terminalOutcome = terminalPromise.then(
      (result) => result,
      (error: unknown) => error,
    );
    const [grantResult, terminalResult] = await Promise.all([
      grant,
      terminalOutcome,
    ]);

    expect(grantResult).toMatchObject({
      diagnostics: [{ code: "grant-signal-broadcast-failed" }],
      outcome: "pending",
    });
    expect(terminalResult).toEqual(
      new Error("OpenCookie port context is no longer active."),
    );
    expect(memory.stored()?.record).toBeUndefined();
    expect(memory.stored()?.pendingGrant).toMatchObject({
      candidate: { method: "accept-all" },
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
    });
  });

  it("rejects a superseded corrective context before its blocked port settles", async () => {
    const memory = controlledStore();
    const correctionStarted = deferred();
    const releaseCorrection = deferred();
    const staleInvoked = deferred();
    const ids = [
      "record-a",
      "transition-a",
      "transition-b",
      "transition-terminal",
    ];
    let stale: Promise<unknown> | undefined;
    const client = createOpenCookie({
      broadcast: (effect) =>
        effect.transitionId === "transition-a" && accessOf(effect) === "allowed"
          ? Promise.reject(new Error("intended signal failed"))
          : Promise.resolve(),
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected-id",
      now: () => 1_000,
      reconcile: async (effect, context) => {
        if (
          effect.transitionId !== "transition-a" ||
          accessOf(effect) !== "blocked"
        ) {
          return;
        }
        correctionStarted.resolve();
        await releaseCorrection.promise;
        stale = context?.withdrawConsent().then(
          (result) => result,
          (error: unknown) => error,
        );
        staleInvoked.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const first = client.acceptAll();
    await correctionStarted.promise;

    const second = client.savePreferences(["analytics"]);
    await expect
      .poll(() => client.getSnapshot().pendingGrant?.transitionId)
      .toBe("transition-b");
    releaseCorrection.resolve();
    await staleInvoked.promise;
    if (stale === undefined) {
      throw new Error("Superseded correction must attempt its stale context.");
    }

    const [firstResult, secondResult, staleResult] = await Promise.all([
      first,
      second,
      stale,
    ]);

    expect(firstResult).toMatchObject({ outcome: "invalidated" });
    expect(secondResult).toMatchObject({
      outcome: "committed",
      transition: { transitionId: "transition-b" },
    });
    expect(staleResult).toEqual(
      new Error("OpenCookie port context is no longer active."),
    );
    expect(memory.stored()?.record).toMatchObject({
      decisions: { analytics: "granted", personalization: "denied" },
      method: "granular",
    });
  });

  it.each(["broadcast", "reconcile"] as const)(
    "keeps supersession precedence when terminal durability lands during corrective %s",
    async (phase) => {
      const memory = controlledStore();
      const correctionStarted = deferred();
      const releaseCorrection = deferred();
      const ids = ["record-a", "transition-a", "transition-terminal"];
      let now = 1_000;
      const client = createOpenCookie({
        broadcast: (effect) => {
          if (effect.transitionId !== "transition-a") {
            return Promise.resolve();
          }
          if (accessOf(effect) === "allowed") {
            return Promise.reject(new Error("intended signal failed"));
          }
          if (phase === "broadcast") {
            correctionStarted.resolve();
            return releaseCorrection.promise;
          }
          return Promise.resolve();
        },
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected-id",
        now: () => now,
        reconcile: (effect) => {
          if (phase === "reconcile" && effect.transitionId === "transition-a") {
            correctionStarted.resolve();
            return releaseCorrection.promise;
          }
          return Promise.resolve();
        },
        ...runtimePolicy(),
        store: memory.store,
      });
      await client.initialize();

      const first = client.acceptAll();
      await correctionStarted.promise;
      now = 2_000;
      const terminal = client.rejectAll();
      await expect
        .poll(() => memory.stored()?.record?.method)
        .toBe("reject-all");
      releaseCorrection.resolve();

      await expect(first).resolves.toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      await expect(terminal).resolves.toMatchObject({ outcome: "committed" });
    },
  );
});
