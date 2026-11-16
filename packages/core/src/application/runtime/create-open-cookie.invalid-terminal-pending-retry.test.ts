import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
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
      {
        access: "optional",
        id: "personalization-script",
        purposeIds: ["personalization"],
        serviceId: "personalization",
      },
    ],
    services: [{ id: "metrics" }, { id: "personalization" }],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function retainedGrantRecord(): PersistedDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "denied" },
    expiresAt: 86_401_000,
    method: "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-retained",
    revision: 1,
  };
}

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function firstWriteFailsStore(): {
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
} {
  let durable: PersistedConsentState | null = null;
  let writes = 0;
  return {
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (durable === null) {
          return Promise.resolve("cleared" as const);
        }
        if (!statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        writes += 1;
        if (writes === 1) {
          return Promise.reject(new Error("first write unavailable"));
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
    stored: () => durable,
  };
}

describe("createOpenCookie invalid terminal over a persistence-pending grant", () => {
  it("releases an older unmaterialized grant when terminal validation fails", async () => {
    let durable: PersistedConsentState | null = {
      record: retainedGrantRecord(),
    };
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (!statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
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
    };
    let generated = 0;
    let rejectNextTransition = false;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => {
        if (kind === "transition" && rejectNextTransition) {
          rejectNextTransition = false;
          return " ";
        }
        return `${kind}-${String(++generated)}`;
      },
      now: () => now,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    now = 2_000;
    const grant = client.acceptAll();
    rejectNextTransition = true;
    const terminal = client.rejectAll();

    await expect(terminal).rejects.toThrow(
      "Generated transition identifier cannot be blank.",
    );
    await expect(grant).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        record: {
          decisions: { analytics: "granted", personalization: "granted" },
          method: "accept-all",
          revision: 2,
        },
      },
    });
    expect(durable).toMatchObject({
      record: {
        decisions: { analytics: "granted", personalization: "granted" },
        method: "accept-all",
        revision: 2,
      },
    });
  });

  it("restores the exact pending grant identity after the terminal clock fails", async () => {
    const memory = firstWriteFailsStore();
    const signaled = {
      broadcast: [] as ("allowed" | "blocked")[],
      reconcile: [] as ("allowed" | "blocked")[],
    };
    const access = (effect: ConsentRuntimeTransitionEffect) => {
      const resource = effect.runtime.effectiveAccess.resources.find(
        ({ resourceId }) => resourceId === "analytics-script",
      );
      if (!resource) throw new Error("Expected analytics resource.");
      return resource.access;
    };
    let recordIds = 0;
    let transitionIds = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        signaled.broadcast.push(access(effect));
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record"
          ? `record-${String((recordIds += 1))}`
          : `transition-${String((transitionIds += 1))}`,
      now: () => now,
      reconcile: (effect) => {
        signaled.reconcile.push(access(effect));
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store: memory.store,
    });
    await client.initialize();

    const pending = await client.acceptAll();
    expect(pending).toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
    });
    if (pending.outcome !== "pending") {
      throw new Error("The failed stage must retain a pending grant identity.");
    }
    const original = pending.transition;
    signaled.broadcast.length = 0;
    signaled.reconcile.length = 0;

    now = Number.POSITIVE_INFINITY;
    await expect(client.rejectAll()).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );

    now = 2_000;
    const retried = await client.retryPendingGrant();
    expect(retried.outcome).not.toBe("not-applicable");
    expect(retried).toMatchObject({
      outcome: "committed",
      transition: {
        record: {
          recordId: original.record.recordId,
          revision: original.record.revision,
        },
        transitionId: original.transitionId,
      },
    });
    expect(memory.stored()).toMatchObject({
      record: {
        recordId: original.record.recordId,
        revision: original.record.revision,
      },
    });
    expect(signaled.broadcast).toContain("allowed");
    expect(signaled.reconcile).toContain("allowed");
  });

  it("replays retained conservative access after the invalid terminal rolls back", async () => {
    const retained = retainedGrantRecord();
    let durable: PersistedConsentState | null = { record: retained };
    let failNextWrite = false;
    const store: DecisionStore = {
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
        if (failNextWrite) {
          failNextWrite = false;
          return Promise.reject(new Error("broader write unavailable"));
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
    };
    const effects = {
      broadcast: [] as ConsentRuntimeTransitionEffect[],
      reconcile: [] as ConsentRuntimeTransitionEffect[],
    };
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => {
        effects.broadcast.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect) => {
        effects.reconcile.push(effect);
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    now = 2_000;
    failNextWrite = true;
    const pending = await client.acceptAll();
    expect(pending).toMatchObject({ outcome: "pending" });
    effects.broadcast.length = 0;
    effects.reconcile.length = 0;

    now = Number.POSITIVE_INFINITY;
    await expect(client.rejectAll()).rejects.toThrow(
      "Current time must be a finite safe integer.",
    );

    const expectedAccess = [
      { access: "allowed", resourceId: "analytics-script" },
      { access: "blocked", resourceId: "personalization-script" },
    ];
    expect(
      client.getSnapshot().runtime.effectiveAccess.resources,
    ).toMatchObject(expectedAccess);
    expect(
      effects.broadcast.at(-1)?.runtime.effectiveAccess.resources,
    ).toMatchObject(expectedAccess);
    expect(
      effects.reconcile.at(-1)?.runtime.effectiveAccess.resources,
    ).toMatchObject(expectedAccess);
  });
});
