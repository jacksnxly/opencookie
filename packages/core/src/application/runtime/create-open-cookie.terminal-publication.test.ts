import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type OpenCookieSnapshot,
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

function deferred(): {
  readonly promise: Promise<void>;
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
} {
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((done, fail) => {
    reject = fail;
    resolve = done;
  });
  return { promise, reject, resolve };
}

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function controlledStore(failTerminalWrite = false): {
  readonly store: DecisionStore;
  readonly terminalPersistenceStarted: Promise<void>;
} {
  let durable: PersistedConsentState | null = null;
  const persistenceStarted = deferred();
  return {
    store: {
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
        const terminal = candidate.record?.method === "reject-all";
        if (terminal) persistenceStarted.resolve();
        if (terminal && failTerminalWrite) {
          return Promise.reject(new Error("terminal storage unavailable"));
        }
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
    terminalPersistenceStarted: persistenceStarted.promise,
  };
}

type Publication = Readonly<{
  method: string | undefined;
  persistence: OpenCookieSnapshot["lastPersistenceStatus"];
}>;

function observePublications(
  client: ReturnType<typeof createOpenCookie>,
): readonly [Publication[], () => void] {
  const publications: Publication[] = [];
  const unsubscribe = client.subscribe(() => {
    const snapshot = client.getSnapshot();
    publications.push({
      method: snapshot.record?.method,
      persistence: snapshot.lastPersistenceStatus,
    });
  });
  return [publications, unsubscribe];
}

function terminalPublications(publications: readonly Publication[]) {
  return publications.filter(({ method }) => method === "reject-all");
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

async function allowQueuedContinuations(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("createOpenCookie superseding terminal publication", () => {
  it("publishes only pending until the older grant and every terminal stage settle", async () => {
    const memory = controlledStore();
    const grantBroadcastStarted = deferred();
    const releaseGrantBroadcast = deferred();
    const terminalBroadcastStarted = deferred();
    const releaseTerminalBroadcast = deferred();
    const terminalReconcileStarted = deferred();
    const releaseTerminalReconcile = deferred();
    const terminalReceiptStarted = deferred();
    const releaseTerminalReceipt = deferred();
    let generated = 0;
    const client = createOpenCookie({
      broadcast: (effect) => {
        if (
          effect.record.method === "accept-all" &&
          accessOf(effect) === "allowed"
        ) {
          grantBroadcastStarted.resolve();
          return releaseGrantBroadcast.promise;
        }
        if (effect.record.method === "reject-all") {
          terminalBroadcastStarted.resolve();
          return releaseTerminalBroadcast.promise;
        }
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 1_000,
      receipt: (receipt) => {
        if (receipt.method === "reject-all") {
          terminalReceiptStarted.resolve();
          return releaseTerminalReceipt.promise;
        }
        return Promise.resolve();
      },
      reconcile: (effect) => {
        if (effect.record.method === "reject-all") {
          terminalReconcileStarted.resolve();
          return releaseTerminalReconcile.promise;
        }
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const grant = client.acceptAll();
    await grantBroadcastStarted.promise;
    const [publications, unsubscribe] = observePublications(client);
    const terminal = client.rejectAll();

    try {
      await memory.terminalPersistenceStarted;
      await allowQueuedContinuations();
      expect
        .soft(terminalPublications(publications))
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseGrantBroadcast.resolve();
      await grant;
      await terminalBroadcastStarted.promise;
      expect
        .soft(terminalPublications(publications))
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseTerminalBroadcast.resolve();
      await terminalReconcileStarted.promise;
      expect
        .soft(terminalPublications(publications))
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseTerminalReconcile.resolve();
      await terminalReceiptStarted.promise;
      expect
        .soft(terminalPublications(publications))
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseTerminalReceipt.resolve();
      await expect(terminal).resolves.toMatchObject({ outcome: "committed" });
      expect.soft(terminalPublications(publications)).toEqual([
        { method: "reject-all", persistence: "pending" },
        { method: "reject-all", persistence: "confirmed" },
      ]);
    } finally {
      releaseGrantBroadcast.resolve();
      releaseTerminalBroadcast.resolve();
      releaseTerminalReconcile.resolve();
      releaseTerminalReceipt.resolve();
      unsubscribe();
      await Promise.allSettled([grant, terminal]);
    }
  });

  it("does not publish failed persistence until terminal aftercare finishes", async () => {
    const memory = controlledStore(true);
    const terminalBroadcastStarted = deferred();
    const releaseTerminalBroadcast = deferred();
    const terminalReconcileStarted = deferred();
    const releaseTerminalReconcile = deferred();
    const terminalReceiptStarted = deferred();
    const releaseTerminalReceipt = deferred();
    let generated = 0;
    const client = createOpenCookie({
      broadcast: () => {
        terminalBroadcastStarted.resolve();
        return releaseTerminalBroadcast.promise;
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 1_000,
      receipt: () => {
        terminalReceiptStarted.resolve();
        return releaseTerminalReceipt.promise;
      },
      reconcile: () => {
        terminalReconcileStarted.resolve();
        return releaseTerminalReconcile.promise;
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const [publications, unsubscribe] = observePublications(client);
    const terminal = client.rejectAll();

    try {
      await terminalBroadcastStarted.promise;
      expect
        .soft(publications)
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseTerminalBroadcast.resolve();
      await terminalReconcileStarted.promise;
      expect
        .soft(publications)
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseTerminalReconcile.resolve();
      await terminalReceiptStarted.promise;
      expect
        .soft(publications)
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseTerminalReceipt.resolve();
      await expect(terminal).resolves.toMatchObject({
        outcome: "degraded",
        transition: { persistenceStatus: "failed" },
      });
      expect.soft(publications).toEqual([
        { method: "reject-all", persistence: "pending" },
        { method: "reject-all", persistence: "failed" },
      ]);
    } finally {
      releaseTerminalBroadcast.resolve();
      releaseTerminalReconcile.resolve();
      releaseTerminalReceipt.resolve();
      unsubscribe();
      await Promise.allSettled([terminal]);
    }
  });

  it("publishes exactly pending then confirmed when receipt delivery rejects", async () => {
    const memory = controlledStore();
    const receiptStarted = deferred();
    const releaseReceipt = deferred();
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 1_000,
      receipt: async () => {
        receiptStarted.resolve();
        await releaseReceipt.promise;
        throw new Error("receipt unavailable");
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();
    const [publications, unsubscribe] = observePublications(client);
    const terminal = client.rejectAll();

    try {
      await receiptStarted.promise;
      expect
        .soft(publications)
        .toEqual([{ method: "reject-all", persistence: "pending" }]);
      expect.soft(client.getSnapshot().lastPersistenceStatus).toBe("pending");

      releaseReceipt.resolve();
      await expect(terminal).resolves.toMatchObject({
        diagnostics: [{ code: "denial-receipt-failed" }],
        outcome: "degraded",
        transition: { persistenceStatus: "confirmed" },
      });
      expect.soft(publications).toEqual([
        { method: "reject-all", persistence: "pending" },
        { method: "reject-all", persistence: "confirmed" },
      ]);
    } finally {
      releaseReceipt.resolve();
      unsubscribe();
      await Promise.allSettled([terminal]);
    }
  });
});
