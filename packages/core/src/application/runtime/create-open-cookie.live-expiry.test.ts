import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
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
import type { ConsentReceipt } from "../../domain/consent-evidence/index.js";
import { persistedConsentStatesEqual } from "./persisted-consent-record.js";

function runtimePolicy() {
  const catalogue = definePolicy(
    completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
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

function activeRecord(): PersistedDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted" },
    expiresAt: 10_000,
    method: "accept-all",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-1",
    revision: 1,
  };
}

function memoryStore(initial: PersistedConsentState): {
  readonly compareCount: () => number;
  readonly readCount: () => number;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  let durable: PersistedConsentState | null = initial;
  let compareCount = 0;
  let readCount = 0;
  const equal = (
    left: PersistedConsentState | null,
    right: PersistedConsentState | null,
  ): boolean =>
    left === null || right === null
      ? left === right
      : persistedConsentStatesEqual(left, right);
  return {
    compareCount: () => compareCount,
    readCount: () => readCount,
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (!equal(durable, expected)) return Promise.resolve("conflict");
        durable = null;
        return Promise.resolve("cleared");
      },
      compareAndSet: (expected, candidate) => {
        compareCount += 1;
        if (!equal(durable, expected)) {
          return Promise.resolve({ status: "conflict" });
        }
        durable = structuredClone(candidate);
        return Promise.resolve({ status: "written" });
      },
      read: () => {
        readCount += 1;
        return Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : {
                state: structuredClone(durable),
                status: "stored" as const,
              },
        );
      },
    },
    stored: () => structuredClone(durable),
  };
}

function resourceAccess(
  source: ConsentRuntimeTransitionEffect | OpenCookieSnapshot,
): string | undefined {
  const runtime = "runtime" in source ? source.runtime : source;
  return runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  )?.access;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: () => void;
} {
  let reject!: (reason: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

async function activeClient() {
  let now = 9_999;
  let nextTransition = 0;
  const memory = memoryStore({ record: activeRecord() });
  const broadcast = vi.fn<
    (
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ) => Promise<void>
  >(() => Promise.resolve());
  const reconcile = vi.fn<
    (
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ) => Promise<void>
  >(() => Promise.resolve());
  const receipt = vi.fn<
    (receipt: ConsentReceipt, context?: OpenCookiePortContext) => Promise<void>
  >(() => Promise.resolve());
  const client = createOpenCookie({
    broadcast,
    consentDurationMs: 9_000,
    idGenerator: (kind) =>
      kind === "record"
        ? "record-generated"
        : `transition-${String(++nextTransition)}`,
    now: () => now,
    receipt,
    reconcile,
    ...runtimePolicy(),
    store: memory.store,
  });
  await client.initialize();
  broadcast.mockClear();
  reconcile.mockClear();
  return {
    broadcast,
    client,
    memory,
    receipt,
    reconcile,
    setNow: (value: number) => {
      now = value;
    },
    transitionCount: () => nextTransition,
  };
}

async function selectiveReconsentClient() {
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
  const historical: PersistedDecisionRecord = {
    catalogueDigest: previous.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: previous.decisionSurfaceDigest,
    decisions: { analytics: "granted" },
    expiresAt: 10_000,
    method: "accept-all",
    policyVersion: previous.policyVersion,
    recordId: "record-historical-expiry",
    revision: 1,
  };
  let now = 9_999;
  let transition = 0;
  const memory = memoryStore({ record: historical });
  const broadcast = vi.fn<
    (
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ) => Promise<void>
  >(() => Promise.resolve());
  const reconcile = vi.fn<
    (
      effect: ConsentRuntimeTransitionEffect,
      context?: OpenCookiePortContext,
    ) => Promise<void>
  >(() => Promise.resolve());
  const client = createOpenCookie({
    broadcast,
    consentDurationMs: 9_000,
    idGenerator: (kind) => `${kind}-selective-${String(++transition)}`,
    now: () => now,
    policyHistory: [current, previous],
    policySnapshot: current,
    reconcile,
    resourcePolicy: resources.resourcePolicy,
    store: memory.store,
  });
  await client.initialize();
  broadcast.mockClear();
  reconcile.mockClear();
  return {
    broadcast,
    client,
    memory,
    reconcile,
    setNow: (value: number) => {
      now = value;
    },
  };
}

async function settleWithin<Result>(
  promise: Promise<Result>,
  label: string,
): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} did not settle within 200ms.`));
        }, 200);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type GrantPort = "broadcast" | "receipt" | "reconcile";
type PortTerminalKind = "reject" | "withdraw";
type PortTerminalTiming =
  "await-1" | "await-2" | "detached-q1" | "detached-q2" | "direct";

const GRANT_PORT_TERMINAL_CASES = (
  ["broadcast", "reconcile", "receipt"] as const
).flatMap((port) =>
  (["reject", "withdraw"] as const).flatMap((terminalKind) =>
    (
      ["direct", "await-1", "await-2", "detached-q1", "detached-q2"] as const
    ).map(
      (timing) =>
        [port, terminalKind, timing] as const satisfies readonly [
          GrantPort,
          PortTerminalKind,
          PortTerminalTiming,
        ],
    ),
  ),
);

describe("createOpenCookie live expiry", () => {
  it("expires a requires-reconsent record even while legacy evaluation is already invalid", async () => {
    const fixture = await selectiveReconsentClient();
    const before = fixture.client.getSnapshot();
    const storedBefore = fixture.memory.stored();
    expect(before).toMatchObject({
      grantActivation: "not-applicable",
      runtime: {
        accessConsent: { status: "requires-reconsent" },
        consentEvaluation: { status: "invalid" },
        policyReconciliation: { status: "requires-reconsent" },
      },
    });
    fixture.setNow(10_000);

    const refreshed = await fixture.client.refresh();

    expect(refreshed.record).toBe(before.record);
    expect(refreshed).toMatchObject({
      grantActivation: "not-applicable",
      runtime: {
        accessConsent: { status: "expired" },
        consentEvaluation: { status: "invalid" },
        policyReconciliation: { status: "expired" },
      },
    });
    expect(fixture.broadcast).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
    expect(fixture.broadcast.mock.calls[0]?.[0].record).toEqual(before.record);
    expect(fixture.memory.stored()).toEqual(storedBefore);
  });

  it("publishes blocked access and reblocks resources before signals without rewriting the decision", async () => {
    const fixture = await activeClient();
    const before = fixture.client.getSnapshot();
    const storedBefore = fixture.memory.stored();
    const compareCount = fixture.memory.compareCount();
    const readCount = fixture.memory.readCount();
    const order: string[] = [];
    fixture.client.subscribe(() => order.push("notify"));
    fixture.broadcast.mockImplementation((effect) => {
      order.push("broadcast");
      expect(fixture.client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        preferencesOpen: true,
        runtime: { consentEvaluation: { prompt: true, status: "expired" } },
      });
      expect(resourceAccess(effect)).toBe("blocked");
      expect(effect.events).toEqual([]);
      expect(effect.record).toBe(before.record);
      return Promise.resolve();
    });
    fixture.reconcile.mockImplementation((effect) => {
      order.push("reconcile");
      expect(resourceAccess(effect)).toBe("blocked");
      return Promise.resolve();
    });
    fixture.setNow(10_000);

    const refreshed = await fixture.client.refresh();

    expect(refreshed).toBe(fixture.client.getSnapshot());
    expect(order).toEqual(["notify", "reconcile", "broadcast"]);
    expect(fixture.client.getSnapshot().record).toBe(before.record);
    expect(fixture.memory.stored()).toEqual(storedBefore);
    expect(fixture.memory.compareCount()).toBe(compareCount);
    expect(fixture.memory.readCount()).toBe(readCount);
  });

  it.each(["invalid-ports", "throwing-id", "invalid-id"] as const)(
    "publishes blocked expiry before %s effect preparation fails",
    async (failureKind) => {
      let now = 9_999;
      let failId = false;
      const memory = memoryStore({ record: activeRecord() });
      const broadcast = vi.fn<
        (effect: ConsentRuntimeTransitionEffect) => Promise<void>
      >(() => Promise.resolve());
      const reconcile = vi.fn<
        (effect: ConsentRuntimeTransitionEffect) => Promise<void>
      >(() => Promise.resolve());
      const options = {
        broadcast,
        consentDurationMs: 9_000,
        idGenerator: (kind: "record" | "transition") => {
          if (failId) {
            if (failureKind === "throwing-id") {
              throw new Error("simulated expiry identifier failure");
            }
            return "";
          }
          return `${kind}-preparation`;
        },
        now: () => now,
        reconcile,
        ...runtimePolicy(),
        store: memory.store,
      };
      const client = createOpenCookie(options);
      await client.initialize();
      broadcast.mockClear();
      reconcile.mockClear();
      const before = client.getSnapshot();
      const durableBefore = memory.stored();
      const compareCount = memory.compareCount();
      const readCount = memory.readCount();
      const published: OpenCookieSnapshot[] = [];
      client.subscribe(() => published.push(client.getSnapshot()));
      now = 10_000;
      if (failureKind === "invalid-ports") {
        options.store = Object.freeze({}) as DecisionStore;
      } else {
        failId = true;
      }

      await expect(client.refresh()).rejects.toBeDefined();

      const blocked = client.getSnapshot();
      expect(blocked).not.toBe(before);
      expect(blocked.record).toBe(before.record);
      expect(blocked.runtime.consentEvaluation.status).toBe("expired");
      expect(resourceAccess(blocked)).toBe("blocked");
      expect(published).toEqual([blocked]);
      expect(memory.stored()).toEqual(durableBefore);
      expect(memory.compareCount()).toBe(compareCount);
      expect(memory.readCount()).toBe(readCount);
      expect(broadcast).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();

      options.store = memory.store;
      failId = false;
      await expect(client.refresh()).resolves.toBe(blocked);

      expect(published).toEqual([blocked]);
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(broadcast.mock.calls[0]?.[0]).toBe(reconcile.mock.calls[0]?.[0]);
      expect(memory.stored()).toEqual(durableBefore);
      expect(memory.compareCount()).toBe(compareCount);
      expect(memory.readCount()).toBe(readCount);
    },
  );

  it("is a no-op before expiry and coalesces concurrent expiry observations", async () => {
    const fixture = await activeClient();
    const before = fixture.client.getSnapshot();
    const transitionsBefore = fixture.transitionCount();
    let updates = 0;
    fixture.client.subscribe(() => {
      updates += 1;
    });

    await expect(fixture.client.refresh()).resolves.toBe(before);
    expect(fixture.transitionCount()).toBe(transitionsBefore);
    expect(updates).toBe(0);
    expect(fixture.broadcast).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();

    fixture.setNow(10_000);
    const [first, second] = await Promise.all([
      fixture.client.refresh(),
      fixture.client.refresh(),
    ]);
    expect(first).toBe(second);
    expect(updates).toBe(1);
    expect(fixture.broadcast).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
  });

  it("uses a monotonic clock so rollback cannot regrant expired access", async () => {
    const fixture = await activeClient();
    fixture.setNow(10_000);
    await fixture.client.refresh();
    const expired = fixture.client.getSnapshot();
    fixture.broadcast.mockClear();
    fixture.reconcile.mockClear();
    fixture.setNow(9_999);

    await expect(fixture.client.refresh()).resolves.toBe(expired);

    expect(resourceAccess(fixture.client.getSnapshot())).toBe("blocked");
    expect(fixture.client.getSnapshot().runtime.consentEvaluation.status).toBe(
      "expired",
    );
    expect(fixture.broadcast).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });

  it("keeps access blocked and attempts reconciliation when broadcasting fails", async () => {
    const fixture = await activeClient();
    const failure = new Error("refresh broadcast failed");
    fixture.broadcast.mockRejectedValueOnce(failure);
    fixture.setNow(10_000);

    await expect(fixture.client.refresh()).rejects.toBe(failure);

    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
    expect(resourceAccess(fixture.client.getSnapshot())).toBe("blocked");
    expect(fixture.client.getSnapshot().runtime.consentEvaluation.status).toBe(
      "expired",
    );
  });

  it("preserves a non-Error expiry rejection by identity", async () => {
    const fixture = await activeClient();
    const failure = Object.freeze({ code: "refresh-broadcast-sentinel" });
    fixture.broadcast.mockRejectedValueOnce(failure);
    fixture.setNow(10_000);

    await expect(fixture.client.refresh()).rejects.toBe(failure);
  });

  it("shares a failed in-flight expiry and retries only its failed broadcast", async () => {
    const fixture = await activeClient();
    const broadcastStarted = deferred();
    const releaseBroadcast = deferred();
    const failure = new Error("deferred refresh broadcast failed");
    fixture.broadcast.mockImplementationOnce(async () => {
      broadcastStarted.resolve();
      await releaseBroadcast.promise;
    });
    fixture.setNow(10_000);

    const first = fixture.client.refresh().then(
      () => undefined,
      (error: unknown) => error,
    );
    await broadcastStarted.promise;
    const second = fixture.client.refresh().then(
      () => undefined,
      (error: unknown) => error,
    );
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseBroadcast.reject(failure);

    await expect(Promise.all([first, second])).resolves.toEqual([
      failure,
      failure,
    ]);
    expect(fixture.broadcast).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
    const effect = fixture.broadcast.mock.calls[0]?.[0];
    if (effect === undefined) throw new Error("Expiry effect must broadcast.");
    expect(fixture.reconcile.mock.calls[0]?.[0]).toBe(effect);

    await expect(fixture.client.refresh()).resolves.toBe(
      fixture.client.getSnapshot(),
    );
    expect(fixture.broadcast).toHaveBeenCalledTimes(2);
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
    expect(fixture.broadcast.mock.calls[1]?.[0]).toBe(effect);
    expect(fixture.broadcast.mock.calls[1]?.[0]?.transitionId).toBe(
      effect.transitionId,
    );
  });

  it("returns a newer terminal snapshot committed during expiry effects", async () => {
    const fixture = await activeClient();
    const expiryBroadcastStarted = deferred();
    const releaseExpiryBroadcast = deferred();
    fixture.broadcast.mockImplementationOnce(async () => {
      expiryBroadcastStarted.resolve();
      await releaseExpiryBroadcast.promise;
    });
    fixture.setNow(10_000);

    const refresh = fixture.client.refresh();
    await expiryBroadcastStarted.promise;

    const terminalCompletion = fixture.client.rejectAll();
    await vi.waitFor(() => {
      expect(fixture.client.getSnapshot().record?.method).toBe("reject-all");
    });
    expect(resourceAccess(fixture.client.getSnapshot())).toBe("blocked");

    releaseExpiryBroadcast.resolve();

    await expect(terminalCompletion).resolves.toMatchObject({
      outcome: "committed",
    });
    const terminal = fixture.client.getSnapshot();
    expect(terminal.record?.method).toBe("reject-all");
    await expect(refresh).resolves.toBe(terminal);
    expect(fixture.client.getSnapshot()).toBe(terminal);
  });

  it.each([
    ["Error", new Error("refresh reconciliation failed")],
    ["undefined", undefined],
  ] as const)(
    "retries only failed reconciliation after an %s rejection",
    async (_reasonKind, failure) => {
      const fixture = await activeClient();
      const order: string[] = [];
      fixture.broadcast.mockImplementation(() => {
        order.push("broadcast");
        return Promise.resolve();
      });
      fixture.reconcile
        .mockImplementationOnce(() => {
          order.push("reconcile");
          // This regression deliberately exercises arbitrary rejection values.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(failure);
        })
        .mockImplementationOnce(() => {
          order.push("reconcile");
          return Promise.resolve();
        });
      fixture.setNow(10_000);

      const first = await fixture.client.refresh().then(
        () => ({ status: "fulfilled" as const }),
        (reason: unknown) => ({ reason, status: "rejected" as const }),
      );

      expect(first).toEqual({ reason: failure, status: "rejected" });
      expect(fixture.broadcast).not.toHaveBeenCalled();
      expect(fixture.reconcile).toHaveBeenCalledTimes(1);
      const effect = fixture.reconcile.mock.calls[0]?.[0];
      if (effect === undefined)
        throw new Error("Expiry effect must reconcile.");

      await expect(fixture.client.refresh()).resolves.toBe(
        fixture.client.getSnapshot(),
      );
      expect(fixture.broadcast).toHaveBeenCalledTimes(1);
      expect(fixture.reconcile).toHaveBeenCalledTimes(2);
      expect(fixture.reconcile.mock.calls[1]?.[0]).toBe(effect);
      expect(fixture.broadcast.mock.calls[0]?.[0]).toBe(effect);
      expect(order).toEqual(["reconcile", "reconcile", "broadcast"]);
    },
  );

  it("withholds and retries broadcast until expiry reconciliation succeeds", async () => {
    const fixture = await activeClient();
    const broadcastFailure = new Error("refresh broadcast failed");
    const reconciliationFailure = new Error("refresh reconciliation failed");
    fixture.broadcast.mockRejectedValueOnce(broadcastFailure);
    fixture.reconcile.mockRejectedValueOnce(reconciliationFailure);
    fixture.setNow(10_000);

    await expect(fixture.client.refresh()).rejects.toBe(reconciliationFailure);
    expect(fixture.broadcast).not.toHaveBeenCalled();
    expect(fixture.reconcile).toHaveBeenCalledTimes(1);
    const effect = fixture.reconcile.mock.calls[0]?.[0];
    if (effect === undefined) throw new Error("Expiry effect must reconcile.");

    await expect(fixture.client.refresh()).rejects.toBe(broadcastFailure);
    expect(fixture.broadcast).toHaveBeenCalledTimes(1);
    expect(fixture.reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.broadcast.mock.calls[0]?.[0]).toBe(effect);
    expect(fixture.reconcile.mock.calls[1]?.[0]).toBe(effect);

    await expect(fixture.client.refresh()).resolves.toBe(
      fixture.client.getSnapshot(),
    );
    expect(fixture.broadcast).toHaveBeenCalledTimes(2);
    expect(fixture.reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.broadcast.mock.calls[1]?.[0]).toBe(effect);
  });

  it.each(["reject", "withdraw", "renew"] as const)(
    "discards a failed expiry attempt after a newer %s record",
    async (replacement) => {
      const fixture = await activeClient();
      const failure = new Error("old expiry broadcast failed");
      fixture.broadcast.mockRejectedValueOnce(failure);
      fixture.setNow(10_000);

      await expect(fixture.client.refresh()).rejects.toBe(failure);
      const expiredEffect = fixture.broadcast.mock.calls[0]?.[0];
      if (expiredEffect === undefined) {
        throw new Error("Expiry effect must broadcast.");
      }
      expect(fixture.reconcile.mock.calls[0]?.[0]).toBe(expiredEffect);

      const replacementResult =
        replacement === "reject"
          ? await fixture.client.rejectAll()
          : replacement === "withdraw"
            ? await fixture.client.withdrawConsent()
            : await fixture.client.acceptAll();
      expect(replacementResult.outcome).toBe("committed");
      expect(replacementResult).not.toHaveProperty("diagnostics");
      const replacementSnapshot = fixture.client.getSnapshot();
      expect(replacementSnapshot.record).not.toBe(expiredEffect.record);

      await expect(fixture.client.refresh()).resolves.toBe(replacementSnapshot);
      expect(
        fixture.broadcast.mock.calls.filter(
          ([effect]) => effect === expiredEffect,
        ),
      ).toHaveLength(1);
      expect(
        fixture.reconcile.mock.calls.filter(
          ([effect]) => effect === expiredEffect,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(GRANT_PORT_TERMINAL_CASES)(
    "binds a %s grant context to %s %s across the full callback lifetime",
    async (grantPort, terminalKind, timing) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const observedSignals: {
        readonly context: OpenCookiePortContext | undefined;
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      const observedReceipts: {
        readonly context: OpenCookiePortContext | undefined;
        readonly receipt: ConsentReceipt;
      }[] = [];
      let terminalPromise:
        | ReturnType<OpenCookiePortContext["rejectAll"]>
        | ReturnType<OpenCookiePortContext["withdrawConsent"]>
        | undefined;

      const startTerminal = async (
        context: OpenCookiePortContext | undefined,
      ): Promise<void> => {
        if (terminalPromise !== undefined) return;
        const invoke = async (): Promise<void> => {
          terminalInvoked.resolve();
          if (context === undefined) {
            throw new Error("A grant port must receive its scoped context.");
          }
          terminalPromise =
            terminalKind === "reject"
              ? context.rejectAll()
              : context.withdrawConsent();
          await terminalPromise;
        };

        if (timing === "await-1" || timing === "await-2") {
          await Promise.resolve();
        }
        if (timing === "await-2") await Promise.resolve();
        if (timing === "detached-q1" || timing === "detached-q2") {
          queueMicrotask(() => {
            const schedule = (): void => {
              void invoke().catch(() => undefined);
            };
            if (timing === "detached-q2") {
              queueMicrotask(schedule);
            } else {
              schedule();
            }
          });
          return;
        }
        await invoke();
      };

      fixture.broadcast.mockImplementation(async (effect, context) => {
        observedSignals.push({ context, effect, port: "broadcast" });
        if (
          grantPort === "broadcast" &&
          effect.record.method === "accept-all"
        ) {
          await startTerminal(context);
        }
      });
      fixture.reconcile.mockImplementation(async (effect, context) => {
        observedSignals.push({ context, effect, port: "reconcile" });
        if (
          grantPort === "reconcile" &&
          effect.record.method === "accept-all"
        ) {
          await startTerminal(context);
        }
      });
      fixture.receipt.mockImplementation(async (receipt, context) => {
        observedReceipts.push({ context, receipt });
        if (grantPort === "receipt" && receipt.method === "accept-all") {
          await startTerminal(context);
        }
      });

      fixture.setNow(10_000);
      const grantPromise = fixture.client.acceptAll();
      await settleWithin(terminalInvoked.promise, "scoped terminal invocation");
      if (terminalPromise === undefined) {
        throw new Error("The scoped terminal command must be started.");
      }
      const [grantResult, terminalResult] = await settleWithin(
        Promise.all([grantPromise, terminalPromise]),
        "scoped grant and terminal settlement",
      );

      expect(grantResult).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      expect(terminalResult.outcome).toBe("committed");
      expect(terminalResult).not.toHaveProperty("diagnostics");
      if (
        grantResult.outcome !== "invalidated" ||
        terminalResult.outcome !== "committed"
      ) {
        throw new Error("Scoped supersession must invalidate and commit.");
      }
      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      const terminalStatus = terminalKind === "reject" ? "active" : "withdrawn";
      const grantContexts = [
        ...observedSignals
          .filter(({ effect }) => effect.record.method === "accept-all")
          .map(({ context }) => context),
        ...observedReceipts
          .filter(({ receipt }) => receipt.method === "accept-all")
          .map(({ context }) => context),
      ];
      expect(grantContexts.length).toBeGreaterThan(0);
      expect(grantContexts.every((context) => context !== undefined)).toBe(
        true,
      );
      expect(grantContexts.every((context) => Object.isFrozen(context))).toBe(
        true,
      );
      expect(new Set(grantContexts).size).toBe(1);
      const terminalSignals = observedSignals.filter(
        ({ effect }) => effect.record.method === terminalMethod,
      );
      expect(terminalSignals.map(({ port }) => port)).toEqual([
        "broadcast",
        "reconcile",
      ]);
      expect(
        terminalSignals.every(({ context }) => context === undefined),
      ).toBe(true);
      const firstTerminalIndex = observedSignals.findIndex(
        ({ effect }) => effect.record.method === terminalMethod,
      );
      expect(firstTerminalIndex).toBeGreaterThan(-1);
      expect(
        observedSignals
          .slice(firstTerminalIndex + 1)
          .some(({ effect }) => effect.record.method === "accept-all"),
      ).toBe(false);
      expect(observedReceipts.at(-1)).toMatchObject({
        context: undefined,
        receipt: {
          method: terminalMethod,
          transitionId: terminalResult.effect.transitionId,
        },
      });
      expect(fixture.client.getSnapshot()).toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: terminalMethod },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
      await expect(fixture.client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "not-applicable",
      });

      const reloaded = createOpenCookie({
        consentDurationMs: 9_000,
        idGenerator: (kind) => `scoped-reload-${kind}`,
        now: () => 10_001,
        ...runtimePolicy(),
        store: fixture.memory.store,
      });
      await expect(
        settleWithin(reloaded.initialize(), "scoped terminal reload"),
      ).resolves.toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
    },
  );

  it("provides one frozen identity-bound context to every port of an attempt", async () => {
    const fixture = await activeClient();
    const contexts: OpenCookiePortContext[] = [];
    fixture.broadcast.mockImplementation((_effect, context) => {
      if (context !== undefined) contexts.push(context);
      return Promise.resolve();
    });
    fixture.reconcile.mockImplementation((_effect, context) => {
      if (context !== undefined) contexts.push(context);
      return Promise.resolve();
    });
    fixture.receipt.mockImplementation((_receipt, context) => {
      if (context !== undefined) contexts.push(context);
      return Promise.resolve();
    });
    fixture.setNow(10_000);

    await expect(fixture.client.acceptAll()).resolves.toMatchObject({
      outcome: "committed",
    });

    expect(contexts).toHaveLength(3);
    expect(contexts.every((context) => context === contexts[0])).toBe(true);
    expect(contexts.every((context) => Object.isFrozen(context))).toBe(true);
    expect(typeof contexts[0]?.rejectAll).toBe("function");
    expect(typeof contexts[0]?.withdrawConsent).toBe("function");
  });

  it.each(["reject", "withdraw"] as const)(
    "expires a stale context before %s can create external effects",
    async (terminalKind) => {
      const fixture = await activeClient();
      let staleContext: OpenCookiePortContext | undefined;
      fixture.broadcast.mockImplementation((_effect, context) => {
        staleContext ??= context;
        return Promise.resolve();
      });
      fixture.setNow(10_000);
      await expect(fixture.client.acceptAll()).resolves.toMatchObject({
        outcome: "committed",
      });
      if (staleContext === undefined) {
        throw new Error("The grant must expose its scoped context.");
      }
      const context = staleContext;
      const before = fixture.client.getSnapshot();
      const durableBefore = fixture.memory.stored();
      fixture.broadcast.mockClear();
      fixture.reconcile.mockClear();
      fixture.receipt.mockClear();

      const terminal =
        terminalKind === "reject"
          ? context.rejectAll().then(() => undefined)
          : context.withdrawConsent().then(() => undefined);
      await expect(
        settleWithin(terminal, "expired scoped context"),
      ).rejects.toThrow("OpenCookie port context is no longer active.");

      expect(fixture.client.getSnapshot()).toBe(before);
      expect(fixture.memory.stored()).toEqual(durableBefore);
      expect(fixture.broadcast).not.toHaveBeenCalled();
      expect(fixture.reconcile).not.toHaveBeenCalled();
      expect(fixture.receipt).not.toHaveBeenCalled();
    },
  );

  it.each(
    (["broadcast", "reconcile", "receipt"] as const).flatMap((port) =>
      (["reject", "withdraw"] as const).map(
        (terminalKind) => [port, terminalKind] as const,
      ),
    ),
  )(
    "rejects a stale %s context %s inside a newer grant without cycling",
    async (grantPort, terminalKind) => {
      const fixture = await activeClient();
      let staleContext: OpenCookiePortContext | undefined;
      fixture.broadcast.mockImplementation((_effect, context) => {
        staleContext ??= context;
        return Promise.resolve();
      });
      fixture.setNow(10_000);
      await expect(fixture.client.acceptAll()).resolves.toMatchObject({
        outcome: "committed",
      });
      if (staleContext === undefined) {
        throw new Error("The first grant must expose its scoped context.");
      }
      const context = staleContext;

      let staleError: unknown;
      const invokeStaleContext = async (): Promise<void> => {
        try {
          if (terminalKind === "reject") await context.rejectAll();
          else await context.withdrawConsent();
        } catch (error) {
          staleError = error;
        }
      };
      fixture.broadcast.mockImplementation(async (effect) => {
        if (
          grantPort === "broadcast" &&
          effect.record.method === "accept-all"
        ) {
          await invokeStaleContext();
        }
      });
      fixture.reconcile.mockImplementation(async (effect) => {
        if (
          grantPort === "reconcile" &&
          effect.record.method === "accept-all"
        ) {
          await invokeStaleContext();
        }
      });
      fixture.receipt.mockImplementation(async (receipt) => {
        if (grantPort === "receipt" && receipt.method === "accept-all") {
          await invokeStaleContext();
        }
      });
      fixture.setNow(19_000);

      await expect(
        settleWithin(fixture.client.acceptAll(), "newer scoped grant"),
      ).resolves.toMatchObject({ outcome: "committed" });
      expect(staleError).toMatchObject({
        message: "OpenCookie port context is no longer active.",
      });
      expect(fixture.client.getSnapshot()).toMatchObject({
        record: { method: "accept-all" },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: "accept-all" },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
    },
  );

  it("settles a newer grant when an uncaught stale context rejects its port", async () => {
    const fixture = await activeClient();
    let staleContext: OpenCookiePortContext | undefined;
    fixture.broadcast.mockImplementation((_effect, context) => {
      staleContext ??= context;
      return Promise.resolve();
    });
    fixture.setNow(10_000);
    await expect(fixture.client.acceptAll()).resolves.toMatchObject({
      outcome: "committed",
    });
    if (staleContext === undefined) {
      throw new Error("The first grant must expose its scoped context.");
    }
    const context = staleContext;
    fixture.broadcast.mockImplementation(async (effect) => {
      if (effect.record.method === "accept-all") await context.rejectAll();
    });
    fixture.setNow(19_000);

    const result = await settleWithin(
      fixture.client.acceptAll(),
      "newer grant with rejected stale context",
    );

    expect(result.outcome).not.toBe("committed");
    expect(
      fixture.client.getSnapshot().runtime.effectiveAccess.resources,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ access: "blocked" })]),
    );
  });

  it.each(["reject", "withdraw"] as const)(
    "keeps %s callbacks final across an in-flight expiry signal",
    async (terminalKind) => {
      const fixture = await activeClient();
      const expiryStarted = deferred();
      const releaseExpiry = deferred();
      const order: string[] = [];
      fixture.broadcast.mockImplementation(async (effect) => {
        const label = `${effect.record.method}:${effect.runtime.consentEvaluation.status}`;
        order.push(`${label}:broadcast`);
        if (effect.runtime.consentEvaluation.status === "expired") {
          expiryStarted.resolve();
          await releaseExpiry.promise;
        }
      });
      fixture.reconcile.mockImplementation((effect) => {
        const label = `${effect.record.method}:${effect.runtime.consentEvaluation.status}`;
        order.push(`${label}:reconcile`);
        return Promise.resolve();
      });
      fixture.setNow(10_000);

      const refresh = fixture.client.refresh();
      await expiryStarted.promise;
      const terminal =
        terminalKind === "reject"
          ? fixture.client.rejectAll()
          : fixture.client.withdrawConsent();
      await Promise.resolve();
      await Promise.resolve();

      releaseExpiry.resolve();
      await expect(refresh).resolves.toBeDefined();
      const terminalResult = await terminal;
      expect(terminalResult.outcome).toBe("committed");
      expect(terminalResult).not.toHaveProperty("diagnostics");

      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      const terminalStatus = terminalKind === "reject" ? "active" : "withdrawn";
      expect(order.slice(0, 2)).toEqual([
        "accept-all:expired:reconcile",
        "accept-all:expired:broadcast",
      ]);
      expect(
        order.filter(
          (entry) => entry === `${terminalMethod}:${terminalStatus}:broadcast`,
        ),
      ).toHaveLength(2);
      expect(
        order.filter(
          (entry) => entry === `${terminalMethod}:${terminalStatus}:reconcile`,
        ),
      ).toHaveLength(1);
      expect(order.at(-1)).toMatch(
        new RegExp(
          `^${terminalMethod}:${terminalStatus}:(broadcast|reconcile)$`,
        ),
      );
    },
  );

  it.each([
    ["broadcast", "reject", "direct"],
    ["broadcast", "withdraw", "direct"],
    ["reconcile", "reject", "direct"],
    ["reconcile", "withdraw", "direct"],
    ["broadcast", "reject", "after a microtask"],
    ["broadcast", "withdraw", "after a microtask"],
    ["reconcile", "reject", "after a microtask"],
    ["reconcile", "withdraw", "after a microtask"],
  ] as const)(
    "lets an expiry %s callback await %s %s without replaying stale expiry",
    async (reentrantPort, terminalKind, timing) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const observed: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      let terminalPromise:
        | ReturnType<typeof fixture.client.rejectAll>
        | ReturnType<typeof fixture.client.withdrawConsent>
        | undefined;
      const observePort = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ): Promise<void> => {
        observed.push({ effect, port });
        if (
          port !== reentrantPort ||
          effect.runtime.consentEvaluation.status !== "expired" ||
          terminalPromise !== undefined
        ) {
          return;
        }
        if (timing === "after a microtask") await Promise.resolve();
        terminalPromise =
          terminalKind === "reject"
            ? fixture.client.rejectAll()
            : fixture.client.withdrawConsent();
        terminalInvoked.resolve();
        await terminalPromise;
      };
      fixture.broadcast.mockImplementation((effect) =>
        observePort("broadcast", effect),
      );
      fixture.reconcile.mockImplementation((effect) =>
        observePort("reconcile", effect),
      );
      fixture.setNow(10_000);

      const refresh = fixture.client.refresh();
      await settleWithin(terminalInvoked.promise, "terminal callback");
      if (terminalPromise === undefined) {
        throw new Error("Expiry callback must invoke the terminal command.");
      }
      const [refreshed, terminalResult] = await settleWithin(
        Promise.all([refresh, terminalPromise]),
        "reentrant expiry and terminal commands",
      );

      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      const terminalSnapshot = fixture.client.getSnapshot();
      expect(terminalResult.outcome).toBe("committed");
      expect(terminalResult).not.toHaveProperty("diagnostics");
      expect(
        "effect" in terminalResult ? terminalResult.effect.record.method : "",
      ).toBe(terminalMethod);
      expect(refreshed).toBe(terminalSnapshot);
      expect(terminalSnapshot.record?.method).toBe(terminalMethod);
      expect(fixture.memory.stored()?.record?.method).toBe(terminalMethod);
      expect(fixture.receipt).toHaveBeenCalledTimes(1);
      expect(fixture.receipt.mock.calls[0]?.[0]).toMatchObject({
        method: terminalMethod,
      });
      expect(
        observed.filter(({ port }) => port === "broadcast").at(-1)?.effect
          .record.method,
      ).toBe(terminalMethod);
      expect(
        observed.filter(({ port }) => port === "reconcile").at(-1)?.effect
          .record.method,
      ).toBe(terminalMethod);

      const expiryEffectsBefore = observed.filter(
        ({ effect }) =>
          effect.runtime.consentEvaluation.status === "expired" &&
          effect.record.method === "accept-all",
      ).length;
      await expect(
        settleWithin(fixture.client.refresh(), "post-terminal refresh"),
      ).resolves.toBe(terminalSnapshot);
      expect(
        observed.filter(
          ({ effect }) =>
            effect.runtime.consentEvaluation.status === "expired" &&
            effect.record.method === "accept-all",
        ),
      ).toHaveLength(expiryEffectsBefore);
      expect(fixture.client.getSnapshot()).toBe(terminalSnapshot);
    },
  );

  it.each([
    ["broadcast", "Error", "denial-signal-broadcast-failed"],
    ["reconcile", "Error", "denial-reconcile-failed"],
    ["receipt", "Error", "denial-receipt-failed"],
    ["broadcast", "undefined", "denial-signal-broadcast-failed"],
    ["reconcile", "undefined", "denial-reconcile-failed"],
  ] as const)(
    "reports a reentrant terminal %s %s rejection without losing the durable denial",
    async (failingPort, reasonKind, diagnostic) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const failure =
        reasonKind === "undefined"
          ? undefined
          : new Error(`terminal ${failingPort} failed`);
      let terminalPromise:
        ReturnType<typeof fixture.client.rejectAll> | undefined;
      let terminalPortFailed = false;
      const observeEffect = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ): Promise<void> => {
        if (
          port === "broadcast" &&
          effect.runtime.consentEvaluation.status === "expired" &&
          terminalPromise === undefined
        ) {
          terminalPromise = fixture.client.rejectAll();
          terminalInvoked.resolve();
          await terminalPromise;
          return;
        }
        if (
          port === failingPort &&
          effect.record.method === "reject-all" &&
          !terminalPortFailed
        ) {
          terminalPortFailed = true;
          // This regression deliberately preserves arbitrary rejection values.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw failure;
        }
      };
      fixture.broadcast.mockImplementation((effect) =>
        observeEffect("broadcast", effect),
      );
      fixture.reconcile.mockImplementation((effect) =>
        observeEffect("reconcile", effect),
      );
      if (failingPort === "receipt") {
        fixture.receipt.mockRejectedValueOnce(failure);
      }
      fixture.setNow(10_000);

      const refresh = fixture.client.refresh();
      await settleWithin(terminalInvoked.promise, "terminal failure callback");
      if (terminalPromise === undefined) {
        throw new Error("Expiry callback must invoke reject-all.");
      }
      const terminalResult = await settleWithin(
        terminalPromise,
        "terminal failure result",
      );
      const refreshed = await settleWithin(refresh, "terminal correction");

      expect(terminalResult.outcome).toBe("degraded");
      if (!("diagnostics" in terminalResult)) {
        throw new Error("Failed terminal effect must expose diagnostics.");
      }
      expect(terminalResult.diagnostics).toContainEqual({ code: diagnostic });
      expect(refreshed.record?.method).toBe("reject-all");
      expect(fixture.client.getSnapshot()).toBe(refreshed);
      expect(fixture.memory.stored()?.record?.method).toBe("reject-all");
      expect(fixture.receipt).toHaveBeenCalledTimes(1);
      await expect(
        settleWithin(fixture.client.refresh(), "post-failure refresh"),
      ).resolves.toBe(refreshed);
    },
  );

  it.each([
    ["broadcast", "Error", [new Error("broadcast correction failed")]],
    ["reconcile", "Error", [new Error("reconcile correction failed")]],
    ["reconcile", "undefined repair", [undefined]],
    [
      "reconcile",
      "undefined retry",
      [new Error("reconcile correction seed failed"), undefined],
    ],
  ] as const)(
    "checkpoints and retries only a failed %s terminal correction with %s",
    async (reentrantPort, _reasonKind, rejectionReasons) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const pendingRejections: unknown[] = [...rejectionReasons];
      const observed: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      let terminalPromise:
        ReturnType<typeof fixture.client.rejectAll> | undefined;
      let terminalTargetCalls = 0;
      const observeEffect = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ): Promise<void> => {
        observed.push({ effect, port });
        if (
          port === reentrantPort &&
          effect.runtime.consentEvaluation.status === "expired" &&
          terminalPromise === undefined
        ) {
          terminalPromise = fixture.client.rejectAll();
          terminalInvoked.resolve();
          await terminalPromise;
          return;
        }
        if (port === reentrantPort && effect.record.method === "reject-all") {
          terminalTargetCalls += 1;
          if (terminalTargetCalls > 1 && pendingRejections.length > 0) {
            throw pendingRejections.shift();
          }
        }
      };
      fixture.broadcast.mockImplementation((effect) =>
        observeEffect("broadcast", effect),
      );
      fixture.reconcile.mockImplementation((effect) =>
        observeEffect("reconcile", effect),
      );
      fixture.setNow(10_000);

      const rejectionOf = (completion: Promise<unknown>) =>
        completion.then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ reason, status: "rejected" as const }),
        );
      const refresh = rejectionOf(fixture.client.refresh());
      await settleWithin(
        terminalInvoked.promise,
        "correction failure callback",
      );
      if (terminalPromise === undefined) {
        throw new Error("Expiry callback must invoke reject-all.");
      }
      const terminalResult = await settleWithin(
        terminalPromise,
        "terminal result before correction",
      );
      const refreshFailure = await settleWithin(
        refresh,
        "failed terminal correction",
      );

      expect(terminalResult.outcome).toBe("committed");
      expect(refreshFailure).toEqual({
        reason: rejectionReasons[0],
        status: "rejected",
      });
      expect(fixture.memory.stored()?.record?.method).toBe("reject-all");
      expect(fixture.client.getSnapshot().record?.method).toBe("reject-all");
      expect(fixture.receipt).toHaveBeenCalledTimes(1);
      const terminalTargetEffects = observed
        .filter(
          ({ effect, port }) =>
            port === reentrantPort && effect.record.method === "reject-all",
        )
        .map(({ effect }) => effect);
      expect(terminalTargetEffects).toHaveLength(2);
      expect(terminalTargetEffects[1]).toBe(terminalTargetEffects[0]);

      const terminalSnapshot = fixture.client.getSnapshot();
      for (const reason of rejectionReasons.slice(1)) {
        await expect(
          settleWithin(
            rejectionOf(fixture.client.refresh()),
            "failed terminal correction retry",
          ),
        ).resolves.toEqual({ reason, status: "rejected" });
      }
      await expect(
        settleWithin(fixture.client.refresh(), "retried terminal correction"),
      ).resolves.toBe(terminalSnapshot);
      const retriedTargetEffects = observed
        .filter(
          ({ effect, port }) =>
            port === reentrantPort && effect.record.method === "reject-all",
        )
        .map(({ effect }) => effect);
      expect(retriedTargetEffects).toHaveLength(rejectionReasons.length + 2);
      expect(
        retriedTargetEffects.every(
          (effect) => effect === retriedTargetEffects[0],
        ),
      ).toBe(true);
      expect(fixture.receipt).toHaveBeenCalledTimes(1);
      expect(
        observed.filter(
          ({ effect }) =>
            effect.runtime.consentEvaluation.status === "expired" &&
            effect.record.method === "accept-all",
        ),
      ).toHaveLength(reentrantPort === "broadcast" ? 2 : 1);
      expect(
        observed.filter(({ port }) => port === reentrantPort).at(-1)?.effect
          .record.method,
      ).toBe("reject-all");
    },
  );

  it.each(["pending", "committed"] as const)(
    "discards a failed expiry correction after a newer grant is %s",
    async (renewalState) => {
      const fixture = await activeClient();
      const correctionFailure = new Error("terminal correction failed");
      const renewalBroadcastStarted = deferred();
      const releaseRenewalBroadcast = deferred();
      const observed: ConsentRuntimeTransitionEffect[] = [];
      let terminalPromise:
        ReturnType<typeof fixture.client.rejectAll> | undefined;
      let rejectionBroadcasts = 0;
      fixture.broadcast.mockImplementation(async (effect) => {
        observed.push(effect);
        if (
          effect.runtime.consentEvaluation.status === "expired" &&
          terminalPromise === undefined
        ) {
          terminalPromise = fixture.client.rejectAll();
          await terminalPromise;
          return;
        }
        if (effect.record.method === "reject-all") {
          rejectionBroadcasts += 1;
          if (rejectionBroadcasts === 2) throw correctionFailure;
          return;
        }
        if (
          effect.record.method === "accept-all" &&
          effect.record.decidedAt === 10_001
        ) {
          renewalBroadcastStarted.resolve();
          if (renewalState === "pending") {
            await releaseRenewalBroadcast.promise;
          }
        }
      });
      fixture.setNow(10_000);

      await expect(
        settleWithin(fixture.client.refresh(), "failed expiry correction"),
      ).rejects.toBe(correctionFailure);
      expect(terminalPromise).toBeDefined();
      expect(fixture.client.getSnapshot().record?.method).toBe("reject-all");

      fixture.setNow(10_001);
      const renewal = fixture.client.acceptAll();
      await settleWithin(
        renewalBroadcastStarted.promise,
        "newer grant broadcast",
      );
      const observedBeforeRetry = observed.length;
      let retry: Promise<OpenCookieSnapshot> | undefined;
      if (renewalState === "pending") {
        retry = fixture.client.refresh();
        releaseRenewalBroadcast.resolve();
      }
      const renewed = await settleWithin(renewal, "newer grant completion");
      expect(renewed.outcome).toBe("committed");
      if (renewalState === "committed") retry = fixture.client.refresh();
      if (retry === undefined) {
        throw new Error("The post-renewal refresh must be scheduled.");
      }
      await settleWithin(retry, "post-renewal refresh");

      expect(fixture.client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        record: { decidedAt: 10_001, method: "accept-all" },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { decidedAt: 10_001, method: "accept-all" },
      });
      expect(
        observed
          .slice(observedBeforeRetry)
          .filter(({ record }) => record.method === "reject-all"),
      ).toHaveLength(0);
      expect(observed.at(-1)?.record).toMatchObject({
        decidedAt: 10_001,
        method: "accept-all",
      });
    },
  );

  it("corrects only the latest of two terminal intents in one expiry turn", async () => {
    const fixture = await activeClient();
    const observed: {
      readonly effect: ConsentRuntimeTransitionEffect;
      readonly port: "broadcast" | "reconcile";
    }[] = [];
    let firstResult:
      Awaited<ReturnType<typeof fixture.client.withdrawConsent>> | undefined;
    let secondResult:
      Awaited<ReturnType<typeof fixture.client.rejectAll>> | undefined;
    fixture.broadcast.mockImplementation(async (effect) => {
      observed.push({ effect, port: "broadcast" });
      if (
        effect.runtime.consentEvaluation.status === "expired" &&
        firstResult === undefined
      ) {
        firstResult = await fixture.client.withdrawConsent();
        secondResult = await fixture.client.rejectAll();
      }
    });
    fixture.reconcile.mockImplementation((effect) => {
      observed.push({ effect, port: "reconcile" });
      return Promise.resolve();
    });
    fixture.setNow(10_000);

    const refreshed = await settleWithin(
      fixture.client.refresh(),
      "two terminal intents",
    );

    expect(firstResult?.outcome).toBe("committed");
    expect(secondResult?.outcome).toBe("committed");
    expect(refreshed.record?.method).toBe("reject-all");
    expect(fixture.memory.stored()?.record?.method).toBe("reject-all");
    expect(
      fixture.receipt.mock.calls.map(([receipt]) => receipt.method),
    ).toEqual(["withdrawal", "reject-all"]);
    const rejectionBroadcasts = observed
      .filter(
        ({ effect, port }) =>
          port === "broadcast" && effect.record.method === "reject-all",
      )
      .map(({ effect }) => effect);
    expect(rejectionBroadcasts).toHaveLength(2);
    expect(rejectionBroadcasts[1]).toBe(rejectionBroadcasts[0]);
    expect(
      observed.filter(
        ({ effect, port }) =>
          port === "broadcast" && effect.record.method === "withdrawal",
      ),
    ).toHaveLength(1);
    expect(observed.at(-1)?.effect.record.method).toBe("reject-all");
    await expect(
      settleWithin(fixture.client.refresh(), "latest terminal refresh"),
    ).resolves.toBe(refreshed);
  });

  it("accepts only the first simultaneous terminal context reservation", async () => {
    const fixture = await activeClient();
    const terminalPairStarted = deferred();
    const withdrawalBroadcastStarted = deferred();
    const releaseWithdrawalBroadcast = deferred();
    const completedBroadcasts: string[] = [];
    const completedReconciliations: string[] = [];
    const completedReceipts: string[] = [];
    let grantRequested = false;
    let withdrawal:
      ReturnType<OpenCookiePortContext["withdrawConsent"]> | undefined;
    let rejection: ReturnType<OpenCookiePortContext["rejectAll"]> | undefined;
    fixture.broadcast.mockImplementation(async (effect, context) => {
      if (
        effect.runtime.consentEvaluation.status === "expired" &&
        !grantRequested
      ) {
        grantRequested = true;
        await fixture.client.acceptAll();
        return;
      }
      if (
        effect.record.method === "accept-all" &&
        effect.record.decidedAt === 10_000
      ) {
        if (context === undefined) {
          throw new Error("The queued grant must expose its port context.");
        }
        withdrawal = context.withdrawConsent();
        rejection = context.rejectAll();
        void rejection.catch(() => undefined);
        terminalPairStarted.resolve();
        return;
      }
      if (effect.record.method === "withdrawal") {
        withdrawalBroadcastStarted.resolve();
        await releaseWithdrawalBroadcast.promise;
      }
      completedBroadcasts.push(effect.record.method);
    });
    fixture.reconcile.mockImplementation((effect) => {
      completedReconciliations.push(effect.record.method);
      return Promise.resolve();
    });
    fixture.receipt.mockImplementation((receipt) => {
      completedReceipts.push(receipt.method);
      return Promise.resolve();
    });
    fixture.setNow(10_000);

    const refresh = fixture.client.refresh();
    await settleWithin(terminalPairStarted.promise, "simultaneous terminals");
    await settleWithin(
      withdrawalBroadcastStarted.promise,
      "withdrawal broadcast",
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    releaseWithdrawalBroadcast.resolve();
    if (withdrawal === undefined || rejection === undefined) {
      throw new Error("Both terminal operations must be scheduled.");
    }
    const withdrawalResult = await settleWithin(
      withdrawal,
      "first terminal completion",
    );
    await expect(rejection).rejects.toThrow(
      "OpenCookie port context is no longer active.",
    );
    await settleWithin(refresh, "expiry with simultaneous terminals");
    await Promise.resolve();
    await Promise.resolve();

    expect(withdrawalResult.outcome).toBe("committed");
    expect(fixture.client.getSnapshot()).toMatchObject({
      record: { method: "withdrawal" },
      runtime: { consentEvaluation: { status: "withdrawn" } },
    });
    expect(fixture.memory.stored()).toMatchObject({
      record: { method: "withdrawal" },
    });
    expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
    expect(completedBroadcasts.at(-1)).toBe("withdrawal");
    expect(completedReconciliations.at(-1)).toBe("withdrawal");
    expect(completedReceipts.at(-1)).toBe("withdrawal");
  });

  it("expires a retained grant context before terminal aftercare", async () => {
    const fixture = await activeClient();
    let grantRequested = false;
    let retainedContext: OpenCookiePortContext | undefined;
    let withdrawal:
      ReturnType<OpenCookiePortContext["withdrawConsent"]> | undefined;
    let recursiveRejection:
      ReturnType<OpenCookiePortContext["rejectAll"]> | undefined;
    fixture.broadcast.mockImplementation(async (effect, context) => {
      if (
        effect.runtime.consentEvaluation.status === "expired" &&
        !grantRequested
      ) {
        grantRequested = true;
        await fixture.client.acceptAll();
        return;
      }
      if (
        effect.record.method === "accept-all" &&
        effect.record.decidedAt === 10_000
      ) {
        if (context === undefined) {
          throw new Error("The queued grant must expose its port context.");
        }
        retainedContext = context;
        withdrawal = context.withdrawConsent();
        return;
      }
      if (effect.record.method === "withdrawal") {
        if (retainedContext === undefined) {
          throw new Error("The grant context must be retained for the probe.");
        }
        recursiveRejection = retainedContext.rejectAll();
        await expect(recursiveRejection).rejects.toThrow(
          "OpenCookie port context is no longer active.",
        );
      }
    });
    fixture.setNow(10_000);

    await settleWithin(
      fixture.client.refresh(),
      "expiry with recursive terminal attempt",
    );
    if (withdrawal === undefined || recursiveRejection === undefined) {
      throw new Error("The terminal and recursive commands must be invoked.");
    }
    await expect(
      settleWithin(withdrawal, "terminal after recursive rejection"),
    ).resolves.toMatchObject({ outcome: "committed" });
    await expect(recursiveRejection).rejects.toThrow(
      "OpenCookie port context is no longer active.",
    );
    expect(fixture.client.getSnapshot()).toMatchObject({
      record: { method: "withdrawal" },
      runtime: { consentEvaluation: { status: "withdrawn" } },
    });
    expect(fixture.memory.stored()).toMatchObject({
      record: { method: "withdrawal" },
    });
  });

  it("settles a pre-reserved terminal awaited from older aftercare", async () => {
    const fixture = await activeClient();
    const completedBroadcasts: string[] = [];
    const completedReconciliations: string[] = [];
    const completedReceipts: string[] = [];
    let grantRequested = false;
    let withdrawal:
      ReturnType<OpenCookiePortContext["withdrawConsent"]> | undefined;
    let rejection: ReturnType<OpenCookiePortContext["rejectAll"]> | undefined;
    fixture.broadcast.mockImplementation(async (effect, context) => {
      if (
        effect.runtime.consentEvaluation.status === "expired" &&
        !grantRequested
      ) {
        grantRequested = true;
        await fixture.client.acceptAll();
        return;
      }
      if (
        effect.record.method === "accept-all" &&
        effect.record.decidedAt === 10_000
      ) {
        if (context === undefined) {
          throw new Error("The queued grant must expose its port context.");
        }
        withdrawal = context.withdrawConsent();
        rejection = context.rejectAll();
        void rejection.catch(() => undefined);
        return;
      }
      if (effect.record.method === "withdrawal") {
        if (rejection === undefined) {
          throw new Error("The newer terminal command must be reserved.");
        }
        await expect(rejection).rejects.toThrow(
          "OpenCookie port context is no longer active.",
        );
      }
      completedBroadcasts.push(effect.record.method);
    });
    fixture.reconcile.mockImplementation((effect) => {
      completedReconciliations.push(effect.record.method);
      return Promise.resolve();
    });
    fixture.receipt.mockImplementation((receipt) => {
      completedReceipts.push(receipt.method);
      return Promise.resolve();
    });
    fixture.setNow(10_000);

    const refresh = fixture.client.refresh();
    await vi.waitFor(() => {
      expect(withdrawal).toBeDefined();
      expect(rejection).toBeDefined();
    });
    if (withdrawal === undefined || rejection === undefined) {
      throw new Error("Both terminal commands must be reserved.");
    }
    const withdrawalResult = await settleWithin(
      withdrawal,
      "terminal with rejected nested reservation",
    );
    await expect(rejection).rejects.toThrow(
      "OpenCookie port context is no longer active.",
    );
    await settleWithin(refresh, "expiry with nested pre-reserved terminals");

    expect(withdrawalResult.outcome).toBe("committed");
    expect(fixture.client.getSnapshot()).toMatchObject({
      record: { method: "withdrawal" },
      runtime: { consentEvaluation: { status: "withdrawn" } },
    });
    expect(fixture.memory.stored()).toMatchObject({
      record: { method: "withdrawal" },
    });
    expect(completedBroadcasts.at(-1)).toBe("withdrawal");
    expect(completedReconciliations.at(-1)).toBe("withdrawal");
    expect(completedReceipts.at(-1)).toBe("withdrawal");
  });

  it.each(["broadcast", "reconcile", "receipt"] as const)(
    "consumes ordinary terminal reentry from a grant %s callback",
    async (originPort) => {
      const fixture = await activeClient();
      const observedEffects: {
        readonly method: string;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      const observedReceipts: string[] = [];
      let grantRequested = false;
      let terminalPairStarted = false;
      let withdrawal:
        ReturnType<typeof fixture.client.withdrawConsent> | undefined;
      let rejection: ReturnType<typeof fixture.client.rejectAll> | undefined;
      const startTerminalPair = (): void => {
        if (terminalPairStarted) return;
        terminalPairStarted = true;
        withdrawal = fixture.client.withdrawConsent();
        rejection = fixture.client.rejectAll();
        void rejection.catch(() => undefined);
      };
      fixture.broadcast.mockImplementation(async (effect) => {
        observedEffects.push({
          method: effect.record.method,
          port: "broadcast",
        });
        if (
          effect.runtime.consentEvaluation.status === "expired" &&
          !grantRequested
        ) {
          grantRequested = true;
          await fixture.client.acceptAll();
          return;
        }
        if (
          originPort === "broadcast" &&
          effect.record.method === "accept-all" &&
          effect.record.decidedAt === 10_000
        ) {
          startTerminalPair();
          return;
        }
        if (effect.record.method === "withdrawal") {
          if (rejection === undefined) {
            throw new Error("The second ordinary terminal must be invoked.");
          }
          await expect(rejection).rejects.toThrow(
            "OpenCookie port context is no longer active.",
          );
        }
      });
      fixture.reconcile.mockImplementation((effect) => {
        observedEffects.push({
          method: effect.record.method,
          port: "reconcile",
        });
        if (
          originPort === "reconcile" &&
          effect.record.method === "accept-all" &&
          effect.record.decidedAt === 10_000
        ) {
          startTerminalPair();
        }
        return Promise.resolve();
      });
      fixture.receipt.mockImplementation((receipt) => {
        observedReceipts.push(receipt.method);
        if (
          originPort === "receipt" &&
          receipt.method === "accept-all" &&
          receipt.decidedAt === 10_000
        ) {
          startTerminalPair();
        }
        return Promise.resolve();
      });
      fixture.setNow(10_000);

      const refresh = fixture.client.refresh();
      await vi.waitFor(() => {
        expect(withdrawal).toBeDefined();
        expect(rejection).toBeDefined();
      });
      if (withdrawal === undefined || rejection === undefined) {
        throw new Error("Both ordinary terminal calls must be attempted.");
      }
      const withdrawalResult = await settleWithin(
        withdrawal,
        `ordinary ${originPort} terminal`,
      );
      await expect(rejection).rejects.toThrow(
        "OpenCookie port context is no longer active.",
      );
      await settleWithin(refresh, `ordinary ${originPort} expiry`);

      expect(withdrawalResult.outcome).toBe("committed");
      expect(fixture.client.getSnapshot()).toMatchObject({
        record: { method: "withdrawal" },
        runtime: { consentEvaluation: { status: "withdrawn" } },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: "withdrawal" },
      });
      expect(
        observedEffects.filter(({ method }) => method === "reject-all"),
      ).toHaveLength(0);
      expect(observedReceipts).not.toContain("reject-all");
      expect(observedEffects.at(-1)?.method).toBe("withdrawal");
      expect(observedReceipts.at(-1)).toBe("withdrawal");
    },
  );

  it.each([
    ["reject", "reconcile", "while parked"],
    ["withdraw", "reconcile", "while parked"],
    ["reject", "receipt", "while parked"],
    ["withdraw", "receipt", "while parked"],
    ["reject", "reconcile", "as it releases"],
    ["withdraw", "reconcile", "as it releases"],
    ["reject", "receipt", "as it releases"],
    ["withdraw", "receipt", "as it releases"],
    ["deny-all", "reconcile", "while parked"],
    ["deny-all", "receipt", "while parked"],
    ["deny-all", "reconcile", "as it releases"],
    ["deny-all", "receipt", "as it releases"],
  ] as const)(
    "settles an external %s issued during a grant's %s aftercare %s",
    async (terminalKind, aftercarePort, timing) => {
      const fixture = await activeClient();
      const aftercareStarted = deferred();
      const releaseAftercare = deferred();
      let parked = false;
      if (aftercarePort === "reconcile") {
        fixture.reconcile.mockImplementation((effect) => {
          if (effect.record.method === "accept-all" && !parked) {
            parked = true;
            aftercareStarted.resolve();
            return releaseAftercare.promise;
          }
          return Promise.resolve();
        });
      } else {
        fixture.receipt.mockImplementation((receipt) => {
          if (receipt.method === "accept-all" && !parked) {
            parked = true;
            aftercareStarted.resolve();
            return releaseAftercare.promise;
          }
          return Promise.resolve();
        });
      }
      fixture.setNow(10_000);
      const grant = fixture.client.acceptAll();
      await settleWithin(aftercareStarted.promise, "grant aftercare start");
      if (timing === "as it releases") releaseAftercare.resolve();
      const terminal =
        terminalKind === "reject"
          ? fixture.client.rejectAll()
          : terminalKind === "deny-all"
            ? fixture.client.savePreferences([])
            : fixture.client.withdrawConsent();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      if (timing === "while parked") releaseAftercare.resolve();

      const [grantResult, terminalResult] = await settleWithin(
        Promise.all([grant, terminal]),
        "grant and external aftercare terminal",
      );
      expect(grantResult).toMatchObject({ outcome: "committed" });
      expect(terminalResult).toMatchObject({ outcome: "committed" });
      const terminalMethod =
        terminalKind === "reject"
          ? "reject-all"
          : terminalKind === "deny-all"
            ? "granular"
            : "withdrawal";
      expect(fixture.memory.stored()?.record).toMatchObject({
        method: terminalMethod,
      });
      expect(fixture.client.getSnapshot().record).toMatchObject({
        method: terminalMethod,
      });
      expect(
        fixture.broadcast.mock.calls.filter(
          ([effect]) => effect.record.method === terminalMethod,
        ),
      ).toHaveLength(1);
      expect(
        fixture.reconcile.mock.calls.filter(
          ([effect]) => effect.record.method === terminalMethod,
        ),
      ).toHaveLength(1);
      expect(
        fixture.receipt.mock.calls.filter(
          ([received]) => received.method === terminalMethod,
        ),
      ).toHaveLength(1);
      await expect(
        settleWithin(fixture.client.refresh(), "post-terminal refresh"),
      ).resolves.toBeDefined();
    },
  );

  it.each([
    ["reject", "parked broadcast"],
    ["reject", "instant broadcast"],
    ["deny-all", "parked broadcast"],
    ["deny-all", "instant broadcast"],
  ] as const)(
    "settles withdraw then %s over a pre-activation grant with %s",
    async (secondKind, grantTiming) => {
      const fixture = await activeClient();
      const grantBroadcastStarted = deferred();
      const releaseGrantBroadcast = deferred();
      const order: string[] = [];
      let grantParked = false;
      fixture.broadcast.mockImplementation((effect) => {
        order.push(`broadcast:${effect.record.method}`);
        if (
          grantTiming === "parked broadcast" &&
          effect.record.method === "accept-all" &&
          !grantParked
        ) {
          grantParked = true;
          grantBroadcastStarted.resolve();
          return releaseGrantBroadcast.promise;
        }
        return Promise.resolve();
      });
      fixture.reconcile.mockImplementation((effect) => {
        order.push(`reconcile:${effect.record.method}`);
        return Promise.resolve();
      });
      fixture.receipt.mockImplementation((receipt) => {
        order.push(`receipt:${receipt.method}`);
        return Promise.resolve();
      });
      const compareCountBefore = fixture.memory.compareCount();
      const transitionCountBefore = fixture.transitionCount();
      fixture.setNow(10_000);
      const grant = fixture.client.acceptAll();
      if (grantTiming === "parked broadcast") {
        await settleWithin(grantBroadcastStarted.promise, "grant broadcast");
      }
      const withdrawal = fixture.client.withdrawConsent();
      const rejection =
        secondKind === "reject"
          ? fixture.client.rejectAll()
          : fixture.client.savePreferences([]);
      const secondMethod = secondKind === "reject" ? "reject-all" : "granular";
      if (grantTiming === "parked broadcast") {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        releaseGrantBroadcast.resolve();
      }

      const [grantResult, withdrawalResult, rejectionResult] =
        await settleWithin(
          Promise.all([grant, withdrawal, rejection]),
          "grant, withdrawal, and rejection",
        );
      if (grantTiming === "instant broadcast") {
        expect(grantResult).toEqual({
          diagnostics: [{ code: "grant-superseded" }],
          outcome: "invalidated",
          stage: "intent",
        });
        expect(grantResult).not.toHaveProperty("effect");
        expect(grantResult).not.toHaveProperty("transition");
        expect(fixture.transitionCount() - transitionCountBefore).toBe(2);
        expect(fixture.memory.compareCount() - compareCountBefore).toBe(2);
        expect(
          fixture.broadcast.mock.calls.some(
            ([effect]) => effect.record.method === "accept-all",
          ),
        ).toBe(false);
        expect(
          fixture.reconcile.mock.calls.some(
            ([effect]) => effect.record.method === "accept-all",
          ),
        ).toBe(false);
        expect(
          fixture.receipt.mock.calls.some(
            ([receipt]) => receipt.method === "accept-all",
          ),
        ).toBe(false);
      } else {
        expect(grantResult).toMatchObject({ outcome: "invalidated" });
      }
      expect(withdrawalResult).toMatchObject({ outcome: "committed" });
      expect(rejectionResult).toMatchObject({ outcome: "committed" });
      expect(fixture.memory.stored()?.record).toMatchObject({
        method: secondMethod,
      });
      expect(fixture.client.getSnapshot().record).toMatchObject({
        method: secondMethod,
      });
      for (const port of ["broadcast", "reconcile", "receipt"] as const) {
        const terminalEffects = order.filter(
          (entry) =>
            entry === `${port}:withdrawal` ||
            entry === `${port}:${secondMethod}`,
        );
        expect(terminalEffects).toEqual([
          `${port}:withdrawal`,
          `${port}:${secondMethod}`,
        ]);
      }
      await expect(
        settleWithin(fixture.client.refresh(), "post-terminal refresh"),
      ).resolves.toMatchObject({ record: { method: secondMethod } });
    },
  );

  it.each(["awaited", "detached"] as const)(
    "settles a terminal issued while a queued grant turn is cancelled when its corrective port uses the context %s",
    async (contextUse) => {
      const fixture = await activeClient();
      const firstWithdrawalStarted = deferred();
      const releaseFirstWithdrawal = deferred();
      const queuedGrantPortStarted = deferred();
      const releaseQueuedGrantPort = deferred();
      let firstWithdrawalParked = false;
      let correctiveTerminal:
        ReturnType<OpenCookiePortContext["rejectAll"]> | undefined;
      fixture.broadcast.mockImplementation(async (effect, context) => {
        if (effect.record.method === "withdrawal" && !firstWithdrawalParked) {
          firstWithdrawalParked = true;
          firstWithdrawalStarted.resolve();
          await releaseFirstWithdrawal.promise;
          return;
        }
        if (
          context !== undefined &&
          effect.record.method === "accept-all" &&
          effect.persistenceStatus === "pending" &&
          effect.record.decidedAt === 10_004 &&
          correctiveTerminal === undefined
        ) {
          queuedGrantPortStarted.resolve();
          await releaseQueuedGrantPort.promise;
          correctiveTerminal = context.rejectAll();
          if (contextUse === "awaited") {
            await correctiveTerminal.catch(() => undefined);
          } else {
            void correctiveTerminal.catch(() => undefined);
          }
        }
      });

      fixture.setNow(10_000);
      const firstGrant = fixture.client.acceptAll();
      fixture.setNow(10_002);
      const firstWithdrawal = fixture.client.withdrawConsent();
      await settleWithin(firstWithdrawalStarted.promise, "first withdrawal");
      fixture.setNow(10_004);
      const queuedGrant = fixture.client.acceptAll();
      await settleWithin(
        queuedGrantPortStarted.promise,
        "queued grant corrective port",
      );
      fixture.setNow(10_006);
      const cancellingWithdrawal = fixture.client.withdrawConsent();
      fixture.setNow(10_008);
      const rejection = fixture.client.rejectAll();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      releaseQueuedGrantPort.resolve();
      releaseFirstWithdrawal.resolve();

      const results = await settleWithin(
        Promise.all([
          firstGrant,
          firstWithdrawal,
          queuedGrant,
          cancellingWithdrawal,
          rejection,
        ]),
        "grants and terminals around a queued turn",
      );
      expect(results[4]).toMatchObject({ outcome: "committed" });
      if (correctiveTerminal === undefined) {
        throw new Error("The queued grant's corrective port must run.");
      }
      await expect(
        settleWithin(correctiveTerminal, "corrective context terminal"),
      ).rejects.toThrow("OpenCookie port context is no longer active.");
      expect(fixture.memory.stored()?.record).toMatchObject({
        method: "reject-all",
      });
      expect(fixture.client.getSnapshot().record).toMatchObject({
        method: "reject-all",
      });
      expect(fixture.client.getSnapshot().lastPersistenceStatus).toBe(
        "confirmed",
      );
      await expect(
        settleWithin(fixture.client.refresh(), "post-terminal refresh"),
      ).resolves.toMatchObject({ record: { method: "reject-all" } });
    },
  );

  it.each([
    ["broadcast", "accept-all", "direct"],
    ["broadcast", "granular", "direct"],
    ["reconcile", "accept-all", "direct"],
    ["reconcile", "granular", "direct"],
    ["broadcast", "accept-all", "after a microtask"],
    ["broadcast", "granular", "after a microtask"],
    ["reconcile", "accept-all", "after a microtask"],
    ["reconcile", "granular", "after a microtask"],
  ] as const)(
    "defers a reentrant expiry %s callback %s grant %s until its queued activation",
    async (reentrantPort, grantKind, timing) => {
      const fixture = await activeClient();
      const publicGrantSettled = deferred();
      const queuedGrantStarted = deferred();
      const releaseQueuedGrant = deferred();
      const observed: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      let grantInvoked = false;
      let publicGrantResult:
        Awaited<ReturnType<typeof fixture.client.acceptAll>> | undefined;

      const observePort = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ): Promise<void> => {
        observed.push({ effect, port });
        if (
          port === reentrantPort &&
          effect.runtime.consentEvaluation.status === "expired" &&
          !grantInvoked
        ) {
          grantInvoked = true;
          if (timing === "after a microtask") await Promise.resolve();
          publicGrantResult = await (grantKind === "accept-all"
            ? fixture.client.acceptAll()
            : fixture.client.savePreferences(["analytics"]));
          publicGrantSettled.resolve();
          return;
        }
        if (
          port === "broadcast" &&
          effect.record.decidedAt === 10_000 &&
          effect.runtime.consentEvaluation.status === "active"
        ) {
          queuedGrantStarted.resolve();
          await releaseQueuedGrant.promise;
        }
      };
      fixture.broadcast.mockImplementation((effect) =>
        observePort("broadcast", effect),
      );
      fixture.reconcile.mockImplementation((effect) =>
        observePort("reconcile", effect),
      );
      fixture.setNow(10_000);

      const refresh = fixture.client.refresh();
      await settleWithin(publicGrantSettled.promise, "public pending grant");
      if (publicGrantResult === undefined) {
        throw new Error(
          "Expiry callback must receive its pending grant result.",
        );
      }
      expect(publicGrantResult.outcome).toBe("pending");
      if (publicGrantResult.outcome !== "pending") {
        throw new Error("Reentrant grant must remain pending.");
      }
      expect(publicGrantResult.effect.record.method).toBe(grantKind);
      expect(resourceAccess(fixture.client.getSnapshot())).toBe("blocked");
      expect(fixture.client.getSnapshot()).toMatchObject({
        grantActivation: "pending",
      });
      expect(
        fixture.client.getSnapshot().runtime.consentEvaluation.status,
      ).not.toBe("active");
      const pendingState = fixture.memory.stored();
      expect(pendingState?.pendingGrant).toMatchObject({
        candidate: {
          decidedAt: 10_000,
          decisions: { analytics: "granted" },
          expiresAt: 19_000,
          method: grantKind,
        },
        kind: "decision",
        transitionId: publicGrantResult.transition.transitionId,
      });
      expect(pendingState?.record?.decidedAt).toBe(1_000);

      await settleWithin(queuedGrantStarted.promise, "queued grant broadcast");
      const queuedCompletion = fixture.client.retryPendingGrant();
      releaseQueuedGrant.resolve();
      const [, completed] = await settleWithin(
        Promise.all([refresh, queuedCompletion]),
        "expiry and queued grant completion",
      );

      expect(completed.outcome).toBe("committed");
      if (completed.outcome !== "committed") {
        throw new Error("Queued grant must commit.");
      }
      expect(completed.transition.transitionId).toBe(
        publicGrantResult.transition.transitionId,
      );
      const active = fixture.client.getSnapshot();
      expect(active).toMatchObject({
        grantActivation: "active",
        record: {
          decidedAt: 10_000,
          decisions: [{ purposeId: "analytics", value: "granted" }],
          method: grantKind,
        },
        runtime: { consentEvaluation: { status: "active" } },
      });
      expect(resourceAccess(active)).toBe("allowed");
      expect(fixture.memory.stored()).toMatchObject({
        record: { decidedAt: 10_000, method: grantKind },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
      const grantBroadcasts = observed.filter(
        ({ effect, port }) =>
          port === "broadcast" && effect.record.decidedAt === 10_000,
      );
      const grantReconciliations = observed.filter(
        ({ effect, port }) =>
          port === "reconcile" && effect.record.decidedAt === 10_000,
      );
      expect(grantBroadcasts).toHaveLength(1);
      expect(grantReconciliations).toHaveLength(1);
      expect(grantBroadcasts[0]?.effect.transitionId).toBe(
        publicGrantResult.transition.transitionId,
      );
      expect(grantReconciliations[0]?.effect.transitionId).toBe(
        publicGrantResult.transition.transitionId,
      );
      expect(fixture.receipt).toHaveBeenCalledTimes(1);
      expect(fixture.receipt.mock.calls[0]?.[0]).toMatchObject({
        method: grantKind,
        transitionId: publicGrantResult.transition.transitionId,
      });

      const observedBeforeRefresh = observed.length;
      await expect(
        settleWithin(fixture.client.refresh(), "stable granted refresh"),
      ).resolves.toBe(active);
      expect(observed).toHaveLength(observedBeforeRefresh);
    },
  );

  it.each(["broadcast", "reconcile"] as const)(
    "keeps an external grant overlapping expiry %s fail-closed until queued activation",
    async (activePort) => {
      const fixture = await activeClient();
      const expiryPortStarted = deferred();
      const releaseExpiryPort = deferred();
      const grantBroadcastStarted = deferred();
      const releaseGrantBroadcast = deferred();
      const observed: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      const observePort = async (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ): Promise<void> => {
        observed.push({ effect, port });
        if (
          port === activePort &&
          effect.runtime.consentEvaluation.status === "expired"
        ) {
          expiryPortStarted.resolve();
          await releaseExpiryPort.promise;
          return;
        }
        if (
          port === "broadcast" &&
          effect.record.decidedAt === 10_000 &&
          effect.runtime.consentEvaluation.status === "active"
        ) {
          grantBroadcastStarted.resolve();
          await releaseGrantBroadcast.promise;
        }
      };
      fixture.broadcast.mockImplementation((effect) =>
        observePort("broadcast", effect),
      );
      fixture.reconcile.mockImplementation((effect) =>
        observePort("reconcile", effect),
      );
      fixture.setNow(10_000);

      const refresh = fixture.client.refresh();
      await settleWithin(expiryPortStarted.promise, "active expiry port");
      const publicResult = await settleWithin(
        fixture.client.savePreferences(["analytics"]),
        "external pending grant",
      );

      expect(publicResult.outcome).toBe("pending");
      if (publicResult.outcome !== "pending") {
        throw new Error("Overlapping external grant must remain pending.");
      }
      expect(resourceAccess(fixture.client.getSnapshot())).toBe("blocked");
      expect(fixture.memory.stored()?.pendingGrant).toMatchObject({
        candidate: { decidedAt: 10_000, method: "granular" },
        transitionId: publicResult.transition.transitionId,
      });

      releaseExpiryPort.resolve();
      await settleWithin(grantBroadcastStarted.promise, "grant after expiry");
      const completion = fixture.client.retryPendingGrant();
      releaseGrantBroadcast.resolve();
      const [, completed] = await settleWithin(
        Promise.all([refresh, completion]),
        "external overlap completion",
      );

      expect(completed.outcome).toBe("committed");
      expect(fixture.client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        record: { decidedAt: 10_000, method: "granular" },
      });
      expect(
        observed.filter(
          ({ effect, port }) =>
            port === "broadcast" && effect.record.decidedAt === 10_000,
        ),
      ).toHaveLength(1);
      expect(
        observed.filter(
          ({ effect, port }) =>
            port === "reconcile" && effect.record.decidedAt === 10_000,
        ),
      ).toHaveLength(1);
      expect(fixture.receipt).toHaveBeenCalledTimes(1);
    },
  );

  it("returns the same pending grant when a reentrant callback retries the same intent", async () => {
    const fixture = await activeClient();
    let entered = false;
    let first: Awaited<ReturnType<typeof fixture.client.acceptAll>> | undefined;
    let second:
      Awaited<ReturnType<typeof fixture.client.acceptAll>> | undefined;
    let transitionCountAfterFirst: number | undefined;
    fixture.broadcast.mockImplementation(async (effect) => {
      if (effect.runtime.consentEvaluation.status === "expired" && !entered) {
        entered = true;
        first = await fixture.client.acceptAll();
        transitionCountAfterFirst = fixture.transitionCount();
        second = await fixture.client.acceptAll();
      }
    });
    fixture.setNow(10_000);

    const refreshed = await settleWithin(
      fixture.client.refresh(),
      "same-intent reentrant retry",
    );
    if (first === undefined || second === undefined) {
      throw new Error("Both reentrant grant calls must settle.");
    }
    expect(first.outcome).toBe("pending");
    expect(second.outcome).toBe("pending");
    if (first.outcome !== "pending" || second.outcome !== "pending") {
      throw new Error("Same-intent reentrant grants must remain pending.");
    }
    expect(second.transition.transitionId).toBe(first.transition.transitionId);
    expect(second.effect).toBe(first.effect);
    expect(fixture.transitionCount()).toBe(transitionCountAfterFirst);
    const completion = await settleWithin(
      fixture.client.retryPendingGrant(),
      "same-intent queued completion",
    );
    expect(completion.outcome).toBe("not-applicable");
    expect(fixture.broadcast).toHaveBeenCalledTimes(2);
    expect(fixture.reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.receipt).toHaveBeenCalledTimes(1);
    expect(refreshed.runtime.consentEvaluation.status).toBe("active");
    expect(refreshed).toBe(fixture.client.getSnapshot());
    expect(fixture.client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      record: { decidedAt: 10_000, method: "accept-all" },
    });
  });

  it("lets a terminal intent supersede a deferred reentrant grant before activation", async () => {
    const fixture = await activeClient();
    const observed: {
      readonly effect: ConsentRuntimeTransitionEffect;
      readonly port: "broadcast" | "reconcile";
    }[] = [];
    let entered = false;
    let grantResult:
      Awaited<ReturnType<typeof fixture.client.acceptAll>> | undefined;
    let terminalResult:
      Awaited<ReturnType<typeof fixture.client.rejectAll>> | undefined;
    fixture.broadcast.mockImplementation(async (effect) => {
      observed.push({ effect, port: "broadcast" });
      if (effect.runtime.consentEvaluation.status === "expired" && !entered) {
        entered = true;
        grantResult = await fixture.client.acceptAll();
        terminalResult = await fixture.client.rejectAll();
      }
    });
    fixture.reconcile.mockImplementation((effect) => {
      observed.push({ effect, port: "reconcile" });
      return Promise.resolve();
    });
    fixture.setNow(10_000);

    const refreshed = await settleWithin(
      fixture.client.refresh(),
      "terminal supersession of deferred grant",
    );
    if (grantResult === undefined || terminalResult === undefined) {
      throw new Error("Grant and terminal supersession must both settle.");
    }
    expect(grantResult.outcome).toBe("pending");
    if (grantResult.outcome !== "pending") {
      throw new Error("Superseded grant must first report pending.");
    }
    const grantTransitionId = grantResult.transition.transitionId;
    expect(terminalResult.outcome).toBe("committed");
    expect(refreshed.record?.method).toBe("reject-all");
    expect(fixture.client.getSnapshot()).toBe(refreshed);
    expect(fixture.memory.stored()).toMatchObject({
      record: { decidedAt: 10_000, method: "reject-all" },
    });
    expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
    expect(
      observed.filter(
        ({ effect }) =>
          effect.transitionId === grantTransitionId &&
          effect.runtime.consentEvaluation.status === "active",
      ),
    ).toHaveLength(0);
    expect(observed.at(-1)?.effect.record.method).toBe("reject-all");
    expect(fixture.receipt).toHaveBeenCalledTimes(1);
    expect(fixture.receipt.mock.calls[0]?.[0].method).toBe("reject-all");
    await expect(fixture.client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "not-applicable",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(observed.at(-1)?.effect.record.method).toBe("reject-all");
  });

  it.each(["reject", "withdraw"] as const)(
    "settles an awaited %s started by the intended grant broadcast",
    async (terminalKind) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const observedSignals: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      const observedReceipts: ConsentReceipt[] = [];
      let terminalPromise:
        | ReturnType<typeof fixture.client.rejectAll>
        | ReturnType<typeof fixture.client.withdrawConsent>
        | undefined;
      fixture.broadcast.mockImplementation(async (effect, context) => {
        observedSignals.push({ effect, port: "broadcast" });
        if (
          effect.record.method === "accept-all" &&
          terminalPromise === undefined
        ) {
          if (context === undefined) {
            throw new Error("The intended grant must receive a port context.");
          }
          terminalPromise =
            terminalKind === "reject"
              ? context.rejectAll()
              : context.withdrawConsent();
          terminalInvoked.resolve();
          await terminalPromise;
        }
      });
      fixture.reconcile.mockImplementation((effect) => {
        observedSignals.push({ effect, port: "reconcile" });
        return Promise.resolve();
      });
      fixture.receipt.mockImplementation((receipt) => {
        observedReceipts.push(receipt);
        return Promise.resolve();
      });

      fixture.setNow(10_000);
      const grantPromise = fixture.client.acceptAll();
      await settleWithin(
        terminalInvoked.promise,
        "intended grant broadcast terminal invocation",
      );
      if (terminalPromise === undefined) {
        throw new Error(
          "The intended broadcast must start a terminal command.",
        );
      }
      const [grantResult, terminalResult] = await settleWithin(
        Promise.all([grantPromise, terminalPromise]),
        "intended grant broadcast terminal settlement",
      );

      expect(grantResult).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      if (grantResult.outcome !== "invalidated" || "stage" in grantResult) {
        throw new Error("The intended grant must be invalidated.");
      }
      expect(terminalResult.outcome).toBe("committed");
      expect(terminalResult).not.toHaveProperty("diagnostics");
      if (terminalResult.outcome !== "committed") {
        throw new Error("The intended-broadcast terminal must commit.");
      }
      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      const terminalStatus = terminalKind === "reject" ? "active" : "withdrawn";
      expect(
        observedSignals.map(({ effect, port }) => [
          effect.record.method,
          port,
          effect.transitionId,
        ]),
      ).toEqual([
        ["accept-all", "broadcast", grantResult.effect.transitionId],
        ["accept-all", "reconcile", grantResult.effect.transitionId],
        [terminalMethod, "broadcast", terminalResult.effect.transitionId],
        [terminalMethod, "reconcile", terminalResult.effect.transitionId],
      ]);
      expect(observedReceipts).toEqual([
        expect.objectContaining({
          method: terminalMethod,
          transitionId: terminalResult.effect.transitionId,
        }),
      ]);
      expect(fixture.client.getSnapshot()).toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: terminalMethod },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
      await expect(fixture.client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "not-applicable",
      });

      const reloaded = createOpenCookie({
        consentDurationMs: 9_000,
        idGenerator: (kind) => `broadcast-terminal-reload-${kind}`,
        now: () => 10_001,
        ...runtimePolicy(),
        store: fixture.memory.store,
      });
      await expect(
        settleWithin(reloaded.initialize(), "broadcast terminal reload"),
      ).resolves.toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
    },
  );

  it.each([
    ["reconcile", "reject"],
    ["reconcile", "withdraw"],
    ["receipt", "reject"],
    ["receipt", "withdraw"],
  ] as const)(
    "settles a grant and %s-time %s without a state-signal queue cycle",
    async (aftercarePort, terminalKind) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const observedSignals: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      const observedReceipts: ConsentReceipt[] = [];
      let terminalPromise:
        | ReturnType<typeof fixture.client.rejectAll>
        | ReturnType<typeof fixture.client.withdrawConsent>
        | undefined;

      const invokeTerminal = (
        context: OpenCookiePortContext | undefined,
      ): Promise<void> => {
        if (terminalPromise !== undefined) return Promise.resolve();
        if (context === undefined) {
          throw new Error("Grant aftercare must receive a port context.");
        }
        terminalPromise =
          terminalKind === "reject"
            ? context.rejectAll()
            : context.withdrawConsent();
        terminalInvoked.resolve();
        return terminalPromise.then(() => undefined);
      };
      fixture.broadcast.mockImplementation((effect) => {
        observedSignals.push({ effect, port: "broadcast" });
        return Promise.resolve();
      });
      fixture.reconcile.mockImplementation(async (effect, context) => {
        observedSignals.push({ effect, port: "reconcile" });
        if (
          aftercarePort === "reconcile" &&
          effect.record.method === "accept-all"
        ) {
          await invokeTerminal(context);
        }
      });
      fixture.receipt.mockImplementation(async (receipt, context) => {
        observedReceipts.push(receipt);
        if (aftercarePort === "receipt" && receipt.method === "accept-all") {
          await invokeTerminal(context);
        }
      });

      fixture.setNow(10_000);
      const grantPromise = fixture.client.acceptAll();
      await settleWithin(terminalInvoked.promise, "grant aftercare terminal");
      if (terminalPromise === undefined) {
        throw new Error("Grant aftercare must invoke the terminal command.");
      }
      const settled = await settleWithin(
        Promise.allSettled([grantPromise, terminalPromise]),
        "grant and terminal queue cycle",
      );
      expect(settled.every(({ status }) => status === "fulfilled")).toBe(true);
      const [grantResult, terminalResult] = await Promise.all([
        grantPromise,
        terminalPromise,
      ]);

      expect(grantResult).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      expect(terminalResult.outcome).toBe("committed");
      expect(terminalResult).not.toHaveProperty("diagnostics");
      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      const terminalStatus = terminalKind === "reject" ? "active" : "withdrawn";
      const terminalSnapshot = fixture.client.getSnapshot();
      expect(terminalSnapshot).toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: terminalMethod },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();

      const grantSignals = observedSignals.filter(
        ({ effect }) => effect.record.method === "accept-all",
      );
      expect(grantSignals.map(({ port }) => port)).toEqual([
        "broadcast",
        "reconcile",
      ]);
      expect(
        observedSignals.filter(
          ({ effect }) => effect.record.method === terminalMethod,
        ),
      ).toEqual([
        expect.objectContaining({ port: "broadcast" }),
        expect.objectContaining({ port: "reconcile" }),
      ]);
      expect(observedSignals.at(-1)?.effect.record.method).toBe(terminalMethod);
      expect(observedReceipts.map(({ method }) => method)).toEqual(
        aftercarePort === "receipt"
          ? ["accept-all", terminalMethod]
          : [terminalMethod],
      );
      expect(observedReceipts.at(-1)?.method).toBe(terminalMethod);

      const signalCount = observedSignals.length;
      const receiptCount = observedReceipts.length;
      await Promise.resolve();
      await Promise.resolve();
      expect(observedSignals).toHaveLength(signalCount);
      expect(observedReceipts).toHaveLength(receiptCount);

      const reloaded = createOpenCookie({
        consentDurationMs: 9_000,
        idGenerator: (kind) => `reload-${kind}`,
        now: () => 10_001,
        ...runtimePolicy(),
        store: fixture.memory.store,
      });
      const reloadedSnapshot = await settleWithin(
        reloaded.initialize(),
        "terminal reload truth",
      );
      expect(reloadedSnapshot).toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
    },
  );

  it.each([
    ["reconcile", "reject", "direct"],
    ["reconcile", "withdraw", "direct"],
    ["receipt", "reject", "direct"],
    ["receipt", "withdraw", "direct"],
    ["reconcile", "reject", "after a microtask"],
    ["reconcile", "withdraw", "after a microtask"],
    ["receipt", "reject", "after a microtask"],
    ["receipt", "withdraw", "after a microtask"],
    ["reconcile", "reject", "after callback microtasks"],
    ["reconcile", "withdraw", "after callback microtasks"],
  ] as const)(
    "settles a grant when %s starts %s %s without awaiting it",
    async (aftercarePort, terminalKind, timing) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const observedSignals: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      const observedReceipts: ConsentReceipt[] = [];
      let terminalPromise:
        | ReturnType<typeof fixture.client.rejectAll>
        | ReturnType<typeof fixture.client.withdrawConsent>
        | undefined;

      const startTerminal = async (
        context: OpenCookiePortContext | undefined,
      ): Promise<void> => {
        if (terminalPromise !== undefined) return;
        if (timing === "after a microtask") await Promise.resolve();
        const invoke = (): void => {
          if (context === undefined) {
            throw new Error("Grant aftercare must receive a port context.");
          }
          terminalPromise =
            terminalKind === "reject"
              ? context.rejectAll()
              : context.withdrawConsent();
          terminalInvoked.resolve();
        };
        if (timing === "after callback microtasks") {
          queueMicrotask(() => {
            queueMicrotask(invoke);
          });
          return;
        }
        invoke();
      };
      fixture.broadcast.mockImplementation((effect) => {
        observedSignals.push({ effect, port: "broadcast" });
        return Promise.resolve();
      });
      fixture.reconcile.mockImplementation(async (effect, context) => {
        observedSignals.push({ effect, port: "reconcile" });
        if (
          aftercarePort === "reconcile" &&
          effect.record.method === "accept-all"
        ) {
          if (timing === "after callback microtasks") {
            void startTerminal(context);
            return;
          }
          await startTerminal(context);
        }
      });
      fixture.receipt.mockImplementation(async (receipt, context) => {
        observedReceipts.push(receipt);
        if (aftercarePort === "receipt" && receipt.method === "accept-all") {
          await startTerminal(context);
        }
      });

      fixture.setNow(10_000);
      const grantPromise = fixture.client.acceptAll();
      await settleWithin(
        terminalInvoked.promise,
        "non-awaited grant aftercare terminal",
      );
      if (terminalPromise === undefined) {
        throw new Error("Grant aftercare must start the terminal command.");
      }
      const settled = await settleWithin(
        Promise.allSettled([grantPromise, terminalPromise]),
        "non-awaited grant and terminal queue cycle",
      );
      expect(settled.every(({ status }) => status === "fulfilled")).toBe(true);
      const [grantResult, terminalResult] = await Promise.all([
        grantPromise,
        terminalPromise,
      ]);

      expect(grantResult).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      expect(terminalResult.outcome).toBe("committed");
      expect(terminalResult).not.toHaveProperty("diagnostics");
      if (terminalResult.outcome !== "committed") {
        throw new Error("Terminal overlap must commit without diagnostics.");
      }
      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      const terminalStatus = terminalKind === "reject" ? "active" : "withdrawn";
      const terminalEffects = observedSignals.filter(
        ({ effect }) => effect.record.method === terminalMethod,
      );
      expect(terminalEffects.map(({ port }) => port)).toEqual([
        "broadcast",
        "reconcile",
      ]);
      expect(terminalEffects.map(({ effect }) => effect.transitionId)).toEqual([
        terminalResult.effect.transitionId,
        terminalResult.effect.transitionId,
      ]);
      expect(
        observedSignals
          .filter(({ effect }) => effect.record.method === "accept-all")
          .map(({ port }) => port),
      ).toEqual(["broadcast", "reconcile"]);
      expect(observedSignals.at(-1)?.effect.record.method).toBe(terminalMethod);
      expect(observedReceipts.map(({ method }) => method)).toEqual(
        aftercarePort === "receipt"
          ? ["accept-all", terminalMethod]
          : [terminalMethod],
      );
      expect(observedReceipts.at(-1)).toMatchObject({
        method: terminalMethod,
        transitionId: terminalResult.effect.transitionId,
      });

      const terminalSnapshot = fixture.client.getSnapshot();
      expect(terminalSnapshot).toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: terminalMethod },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
      const reloaded = createOpenCookie({
        consentDurationMs: 9_000,
        idGenerator: (kind) => `non-awaited-reload-${kind}`,
        now: () => 10_001,
        ...runtimePolicy(),
        store: fixture.memory.store,
      });
      await expect(
        settleWithin(reloaded.initialize(), "non-awaited terminal reload"),
      ).resolves.toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });

      const signalCount = observedSignals.length;
      const receiptCount = observedReceipts.length;
      await Promise.resolve();
      await Promise.resolve();
      expect(observedSignals).toHaveLength(signalCount);
      expect(observedReceipts).toHaveLength(receiptCount);
    },
  );

  it.each([
    ["reject", "valid time"],
    ["withdraw", "valid time"],
    ["reject", "invalid time"],
    ["withdraw", "invalid time"],
  ] as const)(
    "expires %s work detached from the final receipt callback with %s",
    async (terminalKind, timeKind) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      let terminalPromise:
        | ReturnType<typeof fixture.client.rejectAll>
        | ReturnType<typeof fixture.client.withdrawConsent>
        | undefined;
      fixture.receipt.mockImplementation((receipt, context) => {
        if (receipt.method !== "accept-all") return Promise.resolve();
        queueMicrotask(() => {
          queueMicrotask(() => {
            if (timeKind === "invalid time") {
              fixture.setNow(Number.POSITIVE_INFINITY);
            }
            if (context !== undefined) {
              terminalPromise =
                terminalKind === "reject"
                  ? context.rejectAll()
                  : context.withdrawConsent();
            }
            terminalInvoked.resolve();
          });
        });
        return Promise.resolve();
      });
      fixture.setNow(10_000);

      const grant = fixture.client.acceptAll();
      await terminalInvoked.promise;
      if (terminalPromise === undefined) {
        throw new Error("The final receipt must expose its port context.");
      }
      const terminalOutcome = terminalPromise.then(
        (result) => result,
        (error: unknown) => error,
      );
      const [grantResult, terminalResult] = await Promise.all([
        grant,
        terminalOutcome,
      ]);

      expect(grantResult).toMatchObject({ outcome: "committed" });
      expect(terminalResult).toEqual(
        new Error("OpenCookie port context is no longer active."),
      );
      expect(fixture.client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        record: { method: "accept-all" },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: "accept-all" },
      });
    },
  );

  it.each([
    ["broadcast", "reject"],
    ["reconcile", "reject"],
    ["receipt", "reject"],
    ["broadcast", "withdraw"],
    ["reconcile", "withdraw"],
    ["receipt", "withdraw"],
  ] as const)(
    "settles a non-awaited terminal %s failure during grant reconcile for %s",
    async (failingPort, terminalKind) => {
      const fixture = await activeClient();
      const terminalInvoked = deferred();
      const observedSignals: {
        readonly effect: ConsentRuntimeTransitionEffect;
        readonly port: "broadcast" | "reconcile";
      }[] = [];
      const observedReceipts: ConsentReceipt[] = [];
      const failure = new Error(`${terminalKind} ${failingPort} failed`);
      let terminalPromise:
        | ReturnType<typeof fixture.client.rejectAll>
        | ReturnType<typeof fixture.client.withdrawConsent>
        | undefined;
      const scheduleTerminal = (
        context: OpenCookiePortContext | undefined,
      ): void => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            if (terminalPromise !== undefined) return;
            terminalInvoked.resolve();
            if (context === undefined) return;
            terminalPromise =
              terminalKind === "reject"
                ? context.rejectAll()
                : context.withdrawConsent();
          });
        });
      };

      fixture.broadcast.mockImplementation((effect) => {
        observedSignals.push({ effect, port: "broadcast" });
        if (
          effect.record.method !== "accept-all" &&
          failingPort === "broadcast"
        ) {
          return Promise.reject(failure);
        }
        return Promise.resolve();
      });
      fixture.reconcile.mockImplementation((effect, context) => {
        observedSignals.push({ effect, port: "reconcile" });
        if (effect.record.method === "accept-all") {
          scheduleTerminal(context);
          return Promise.resolve();
        }
        if (failingPort === "reconcile") return Promise.reject(failure);
        return Promise.resolve();
      });
      fixture.receipt.mockImplementation((receipt) => {
        observedReceipts.push(receipt);
        return failingPort === "receipt"
          ? Promise.reject(failure)
          : Promise.resolve();
      });

      fixture.setNow(10_000);
      const grantPromise = fixture.client.acceptAll();
      await settleWithin(
        terminalInvoked.promise,
        "non-awaited failing terminal invocation",
      );
      if (terminalPromise === undefined) {
        throw new Error(
          "Grant reconciliation must start the terminal command.",
        );
      }
      const [grantResult, terminalResult] = await settleWithin(
        Promise.all([grantPromise, terminalPromise]),
        "non-awaited failing terminal settlement",
      );

      expect(grantResult).toMatchObject({
        diagnostics: [
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ],
        outcome: "invalidated",
      });
      const diagnosticCode =
        failingPort === "broadcast"
          ? "denial-signal-broadcast-failed"
          : failingPort === "reconcile"
            ? "denial-reconcile-failed"
            : "denial-receipt-failed";
      expect(terminalResult).toMatchObject({
        diagnostics: [{ code: diagnosticCode }],
        outcome: "degraded",
      });
      if (terminalResult.outcome !== "degraded") {
        throw new Error("The failed terminal port must report degradation.");
      }
      const terminalMethod =
        terminalKind === "reject" ? "reject-all" : "withdrawal";
      const terminalStatus = terminalKind === "reject" ? "active" : "withdrawn";
      expect(
        observedSignals
          .filter(({ effect }) => effect.record.method === terminalMethod)
          .map(({ effect, port }) => [port, effect.transitionId]),
      ).toEqual([
        ["broadcast", terminalResult.effect.transitionId],
        ["reconcile", terminalResult.effect.transitionId],
      ]);
      expect(observedReceipts).toEqual([
        expect.objectContaining({
          method: terminalMethod,
          transitionId: terminalResult.effect.transitionId,
        }),
      ]);
      expect(fixture.client.getSnapshot()).toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { method: terminalMethod },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();

      const reloaded = createOpenCookie({
        consentDurationMs: 9_000,
        idGenerator: (kind) => `failed-terminal-reload-${kind}`,
        now: () => 10_001,
        ...runtimePolicy(),
        store: fixture.memory.store,
      });
      await expect(
        settleWithin(reloaded.initialize(), "failed terminal reload"),
      ).resolves.toMatchObject({
        record: { method: terminalMethod },
        runtime: { consentEvaluation: { status: terminalStatus } },
      });
    },
  );

  it.each(["reject", "withdraw"] as const)(
    "keeps an activated grant when reconcile starts an invalid %s without awaiting it",
    async (terminalKind) => {
      const fixture = await activeClient();
      const terminalSettled = deferred();
      let terminalFailure: unknown;
      let terminalInvoked = false;
      const invokeInvalidTerminal = (
        context: OpenCookiePortContext | undefined,
      ): void => {
        if (terminalInvoked) return;
        terminalInvoked = true;
        queueMicrotask(() => {
          queueMicrotask(() => {
            fixture.setNow(Number.POSITIVE_INFINITY);
            if (context === undefined) {
              terminalFailure = new Error(
                "Grant aftercare must receive a port context.",
              );
              terminalSettled.resolve();
              return;
            }
            const terminalPromise =
              terminalKind === "reject"
                ? context.rejectAll()
                : context.withdrawConsent();
            void terminalPromise.then(
              () => {
                terminalSettled.resolve();
              },
              (error: unknown) => {
                terminalFailure = error;
                terminalSettled.resolve();
              },
            );
          });
        });
      };
      fixture.reconcile.mockImplementation((effect, context) => {
        if (effect.record.method === "accept-all") {
          invokeInvalidTerminal(context);
        }
        return Promise.resolve();
      });
      fixture.setNow(10_000);

      const grantResult = await settleWithin(
        fixture.client.acceptAll(),
        "grant after invalid non-awaited terminal",
      );
      await settleWithin(terminalSettled.promise, "invalid terminal rejection");

      expect(terminalFailure).toBeInstanceOf(TypeError);
      expect(grantResult.outcome).toBe("committed");
      expect(grantResult).not.toHaveProperty("diagnostics");
      expect(fixture.client.getSnapshot()).toMatchObject({
        grantActivation: "active",
        record: { decidedAt: 10_000, method: "accept-all" },
        runtime: { consentEvaluation: { status: "active" } },
      });
      expect(fixture.memory.stored()).toMatchObject({
        record: { decidedAt: 10_000, method: "accept-all" },
      });
      expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
      expect(fixture.broadcast).toHaveBeenCalledTimes(1);
      expect(fixture.reconcile).toHaveBeenCalledTimes(1);
      expect(fixture.receipt).toHaveBeenCalledTimes(1);
      await expect(fixture.client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "not-applicable",
      });
    },
  );

  it("resumes a durable deferred grant after its queued activation is interrupted", async () => {
    const fixture = await activeClient();
    const publicGrantSettled = deferred();
    const queuedGrantStarted = deferred();
    const interruption = new Error("queued grant broadcast interrupted");
    let entered = false;
    let interrupted = false;
    let publicGrantResult:
      Awaited<ReturnType<typeof fixture.client.savePreferences>> | undefined;
    fixture.broadcast.mockImplementation(async (effect) => {
      if (effect.runtime.consentEvaluation.status === "expired" && !entered) {
        entered = true;
        publicGrantResult = await fixture.client.savePreferences(["analytics"]);
        publicGrantSettled.resolve();
        return;
      }
      if (
        effect.record.decidedAt === 10_000 &&
        effect.runtime.consentEvaluation.status === "active" &&
        !interrupted
      ) {
        interrupted = true;
        queuedGrantStarted.resolve();
        throw interruption;
      }
    });
    fixture.setNow(10_000);

    const refresh = fixture.client.refresh();
    await settleWithin(publicGrantSettled.promise, "interrupted public grant");
    if (publicGrantResult === undefined) {
      throw new Error("Interrupted grant must return its pending result.");
    }
    expect(publicGrantResult.outcome).toBe("pending");
    if (publicGrantResult.outcome !== "pending") {
      throw new Error("Interrupted grant must remain pending.");
    }
    await settleWithin(queuedGrantStarted.promise, "interrupted queued grant");
    const interruptedCompletion = await settleWithin(
      fixture.client.retryPendingGrant(),
      "interrupted queued completion",
    );
    await settleWithin(refresh, "expiry before reload");
    expect(interruptedCompletion).toMatchObject({
      diagnostics: [{ code: "grant-signal-broadcast-failed" }],
      outcome: "pending",
    });
    const pendingState = fixture.memory.stored();
    expect(pendingState?.pendingGrant).toMatchObject({
      candidate: { decidedAt: 10_000, method: "granular" },
      transitionId: publicGrantResult.transition.transitionId,
    });
    expect(resourceAccess(fixture.client.getSnapshot())).toBe("blocked");

    const resumedBroadcast = vi.fn<
      (effect: ConsentRuntimeTransitionEffect) => Promise<void>
    >(() => Promise.resolve());
    const resumedReconcile = vi.fn<
      (effect: ConsentRuntimeTransitionEffect) => Promise<void>
    >(() => Promise.resolve());
    const resumedReceipt = vi.fn<(receipt: ConsentReceipt) => Promise<void>>(
      () => Promise.resolve(),
    );
    const resumed = createOpenCookie({
      broadcast: resumedBroadcast,
      consentDurationMs: 9_000,
      idGenerator: (kind) =>
        kind === "record" ? "reload-record" : "reload-transition",
      now: () => 10_001,
      receipt: resumedReceipt,
      reconcile: resumedReconcile,
      ...runtimePolicy(),
      store: fixture.memory.store,
    });

    const resumedSnapshot = await settleWithin(
      resumed.initialize(),
      "deferred grant reload",
    );
    expect(resumedSnapshot).toMatchObject({
      grantActivation: "active",
      record: { decidedAt: 10_000, method: "granular" },
    });
    expect(resourceAccess(resumedSnapshot)).toBe("allowed");
    expect(fixture.memory.stored()).toMatchObject({
      record: { decidedAt: 10_000, method: "granular" },
    });
    expect(fixture.memory.stored()?.pendingGrant).toBeUndefined();
    expect(resumedBroadcast).toHaveBeenCalledTimes(1);
    expect(resumedReconcile).toHaveBeenCalledTimes(1);
    expect(resumedReceipt).toHaveBeenCalledTimes(1);
    expect(resumedBroadcast.mock.calls[0]?.[0].transitionId).toBe(
      publicGrantResult.transition.transitionId,
    );
    expect(resumedReconcile.mock.calls[0]?.[0].transitionId).toBe(
      publicGrantResult.transition.transitionId,
    );
  });
});
