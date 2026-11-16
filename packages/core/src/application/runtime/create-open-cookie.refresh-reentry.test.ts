import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
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

function activeRecord(
  policy: ReturnType<typeof runtimePolicy>["policySnapshot"],
): PersistedDecisionRecord {
  return {
    catalogueDigest: policy.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policy.decisionSurfaceDigest,
    decisions: { analytics: "granted" },
    expiresAt: 2_000,
    method: "accept-all",
    policyVersion: policy.policyVersion,
    recordId: "record-active",
    revision: 1,
  };
}

function memoryStore(initial: PersistedConsentState | null): DecisionStore {
  let durable = structuredClone(initial);
  const same = (
    left: PersistedConsentState | null,
    right: PersistedConsentState | null,
  ) =>
    left === null || right === null
      ? left === right
      : persistedConsentStatesEqual(left, right);

  return {
    clear: () => {
      durable = null;
      return Promise.resolve();
    },
    clearIfCurrent: (expected) => {
      if (!same(durable, expected)) return Promise.resolve("conflict");
      durable = null;
      return Promise.resolve("cleared");
    },
    compareAndSet: (expected, candidate) => {
      if (!same(durable, expected)) {
        return Promise.resolve({ status: "conflict" });
      }
      durable = structuredClone(candidate);
      return Promise.resolve({ status: "written" });
    },
    read: () =>
      Promise.resolve(
        durable === null
          ? { status: "missing" as const }
          : {
              state: structuredClone(durable),
              status: "stored" as const,
            },
      ),
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
          reject(new Error(`${label} did not settle within 250ms.`));
        }, 250);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function resourceAccess(
  source: ConsentRuntimeTransitionEffect | OpenCookieSnapshot,
): string | undefined {
  const runtime = "runtime" in source ? source.runtime : source;
  return runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  )?.access;
}

describe("createOpenCookie refresh re-entry", () => {
  it("settles a refresh awaited by its own expiry broadcast without duplicating expiry ports", async () => {
    const policy = runtimePolicy();
    let now = 1_500;
    let generated = 0;
    let nestedRefresh: Promise<OpenCookieSnapshot> | undefined;
    const broadcastEntered = deferred();
    const observed: string[] = [];
    const broadcast = vi.fn(
      async (effect: ConsentRuntimeTransitionEffect): Promise<void> => {
        observed.push(`${effect.runtime.consentEvaluation.status}:broadcast`);
        if (
          effect.runtime.consentEvaluation.status === "expired" &&
          nestedRefresh === undefined
        ) {
          nestedRefresh = client.refresh();
          broadcastEntered.resolve();
          await nestedRefresh;
        }
      },
    );
    const reconcile = vi.fn(
      (effect: ConsentRuntimeTransitionEffect): Promise<void> => {
        observed.push(`${effect.runtime.consentEvaluation.status}:reconcile`);
        return Promise.resolve();
      },
    );
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile,
      ...policy,
      store: memoryStore({ record: activeRecord(policy.policySnapshot) }),
    });
    await client.initialize();
    broadcast.mockClear();
    reconcile.mockClear();
    observed.length = 0;
    now = 2_000;

    const outerRefresh = client.refresh();
    await settleWithin(broadcastEntered.promise, "expiry broadcast callback");
    const innerRefresh = nestedRefresh;
    if (innerRefresh === undefined) {
      throw new Error("Expiry broadcast must invoke a nested refresh.");
    }

    const [outerSnapshot, innerSnapshot] = await settleWithin(
      Promise.all([outerRefresh, innerRefresh]),
      "outer and nested expiry refreshes",
    );

    expect(outerSnapshot).toBe(innerSnapshot);
    expect(innerSnapshot.runtime.consentEvaluation.status).toBe("expired");
    expect(resourceAccess(innerSnapshot)).toBe("blocked");
    expect(observed).toEqual(["expired:reconcile", "expired:broadcast"]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);

    await expect(
      settleWithin(client.refresh(), "refresh after expiry re-entry"),
    ).resolves.toBe(innerSnapshot);
    expect(observed).toEqual(["expired:reconcile", "expired:broadcast"]);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("drains expiry ports after a successful grant reconcile callback awaits refresh", async () => {
    const policy = runtimePolicy();
    let now = 1_000;
    let generated = 0;
    let nestedRefresh: Promise<OpenCookieSnapshot> | undefined;
    let insideGrantReconcile = false;
    const reconcileEntered = deferred();
    const expiryDrained = deferred();
    const observed: {
      readonly duringGrantReconcile: boolean;
      readonly port: "broadcast" | "reconcile";
      readonly status: string;
    }[] = [];
    const broadcast = vi.fn(
      (effect: ConsentRuntimeTransitionEffect): Promise<void> => {
        observed.push({
          duringGrantReconcile: insideGrantReconcile,
          port: "broadcast",
          status: effect.runtime.consentEvaluation.status,
        });
        return Promise.resolve();
      },
    );
    const reconcile = vi.fn(
      async (effect: ConsentRuntimeTransitionEffect): Promise<void> => {
        observed.push({
          duringGrantReconcile: insideGrantReconcile,
          port: "reconcile",
          status: effect.runtime.consentEvaluation.status,
        });
        if (
          effect.runtime.consentEvaluation.status === "active" &&
          nestedRefresh === undefined
        ) {
          insideGrantReconcile = true;
          now = 2_001;
          nestedRefresh = client.refresh();
          reconcileEntered.resolve();
          try {
            await nestedRefresh;
          } finally {
            insideGrantReconcile = false;
          }
        }
        if (effect.runtime.consentEvaluation.status === "expired") {
          expiryDrained.resolve();
        }
      },
    );
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 1_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile,
      ...policy,
      store: memoryStore(null),
    });
    await client.initialize();

    const grant = client.acceptAll();
    await settleWithin(reconcileEntered.promise, "grant reconcile callback");
    const innerRefresh = nestedRefresh;
    if (innerRefresh === undefined) {
      throw new Error("Grant reconciliation must invoke a nested refresh.");
    }

    const [grantResult, nestedSnapshot] = await settleWithin(
      Promise.all([grant, innerRefresh]),
      "grant and nested expiry refresh",
    );
    await settleWithin(expiryDrained.promise, "queued expiry ports");

    expect(grantResult).toHaveProperty("outcome");
    expect(nestedSnapshot.runtime.consentEvaluation.status).toBe("expired");
    expect(resourceAccess(nestedSnapshot)).toBe("blocked");
    expect(client.getSnapshot().runtime.consentEvaluation.status).toBe(
      "expired",
    );
    expect(resourceAccess(client.getSnapshot())).toBe("blocked");
    expect(observed).toEqual([
      {
        duringGrantReconcile: false,
        port: "broadcast",
        status: "active",
      },
      {
        duringGrantReconcile: false,
        port: "reconcile",
        status: "active",
      },
      {
        duringGrantReconcile: false,
        port: "reconcile",
        status: "expired",
      },
      {
        duringGrantReconcile: false,
        port: "broadcast",
        status: "expired",
      },
    ]);
  });
});
