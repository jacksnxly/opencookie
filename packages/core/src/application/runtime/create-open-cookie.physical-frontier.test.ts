import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
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
        serviceId: "analytics-service",
      },
      {
        access: "optional",
        id: "personalization-script",
        purposeIds: ["personalization"],
        serviceId: "personalization-service",
      },
    ],
    services: [{ id: "analytics-service" }, { id: "personalization-service" }],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function completedRecord(
  policy: ReturnType<typeof runtimePolicy>["policySnapshot"],
  options: {
    readonly decidedAt: number;
    readonly decisions: Readonly<
      Record<"analytics" | "personalization", "denied" | "granted">
    >;
    readonly method: "accept-all" | "granular" | "reject-all";
    readonly recordId: string;
    readonly revision: number;
  },
): PersistedDecisionRecord {
  return {
    catalogueDigest: policy.catalogueDigest,
    decidedAt: options.decidedAt,
    decisionSurfaceDigest: policy.decisionSurfaceDigest,
    decisions: options.decisions,
    expiresAt: 100_000,
    method: options.method,
    policyVersion: policy.policyVersion,
    recordId: options.recordId,
    revision: options.revision,
  };
}

function same(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function stored(state: PersistedConsentState | null) {
  return state === null
    ? ({ status: "missing" } as const)
    : ({ state, status: "stored" } as const);
}

describe("createOpenCookie physical persistence frontier", () => {
  it("keeps a concurrently restored predecessor in terminal authority", async () => {
    const policy = runtimePolicy();
    const previous = completedRecord(policy.policySnapshot, {
      decidedAt: 1_000,
      decisions: { analytics: "granted", personalization: "denied" },
      method: "granular",
      recordId: "record-previous",
      revision: 1,
    });
    let durable: PersistedConsentState | null = { record: previous };
    const store: DecisionStore = {
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
        durable = candidate;
        return Promise.resolve({ status: "written" });
      },
      read: () => Promise.resolve(stored(durable)),
    };
    const transitionIds = [
      "transition-restore",
      "transition-grant",
      "transition-terminal",
    ];
    let terminal:
      ReturnType<ReturnType<typeof createOpenCookie>["rejectAll"]> | undefined;
    const client = createOpenCookie({
      broadcast: async (effect, context) => {
        if (effect.transitionId !== "transition-grant") return;
        if (context === undefined) {
          throw new Error("Grant context is required.");
        }
        const staged = durable;
        if (staged?.pendingGrant?.kind !== "decision") {
          throw new Error("Decision must be durably staged.");
        }
        await expect(
          store.compareAndSet(staged, { record: previous }),
        ).resolves.toEqual({ status: "written" });
        terminal = context.rejectAll();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "transition"
          ? (transitionIds.shift() ?? "unexpected-transition")
          : "unexpected-record",
      now: () => 2_000,
      ...policy,
      store,
    });
    await client.initialize();

    const grant = client.acceptAll();
    await vi.waitFor(() => {
      expect(terminal).toBeDefined();
    });
    if (terminal === undefined) {
      throw new Error("Terminal decision was not reserved.");
    }
    const [, terminalResult] = await Promise.all([grant, terminal]);

    expect(terminalResult).toMatchObject({ outcome: "committed" });
    expect(durable).toMatchObject({
      record: { method: "reject-all", revision: 2 },
    });
  });

  it("keeps retry work bounded after an ambiguous write and unavailable recovery reads", async () => {
    const policy = runtimePolicy();
    const unrelated: PersistedConsentState = {
      record: completedRecord(policy.policySnapshot, {
        decidedAt: 900,
        decisions: { analytics: "denied", personalization: "denied" },
        method: "reject-all",
        recordId: "record-unrelated",
        revision: 1,
      }),
    };
    let durable: PersistedConsentState | null = null;
    let recoveryUnavailable = false;
    let firstCleanup = true;
    let now = 1_000;
    const compareExpected: (PersistedConsentState | null)[] = [];
    const clearExpected: PersistedConsentState[] = [];
    const store: DecisionStore = {
      clear: () => Promise.resolve(),
      clearIfCurrent: (expected) => {
        clearExpected.push(expected);
        if (firstCleanup) {
          firstCleanup = false;
          durable = unrelated;
        }
        return Promise.resolve("conflict" as const);
      },
      compareAndSet: (expected, candidate) => {
        compareExpected.push(expected);
        durable = candidate;
        recoveryUnavailable = true;
        return Promise.reject(new Error("write acknowledgement unavailable"));
      },
      read: () => {
        if (recoveryUnavailable) {
          return Promise.reject(new Error("recovery read unavailable"));
        }
        return Promise.resolve(stored(durable));
      },
    };
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 50_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...policy,
      store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
    });
    expect(compareExpected).toHaveLength(1);
    expect(clearExpected).toHaveLength(1);

    const firstPredecessor = clearExpected[0];
    if (firstPredecessor === undefined) {
      throw new Error("The ambiguous stage must have a cleanup candidate.");
    }
    let immediatePredecessor: PersistedConsentState = firstPredecessor;
    const compareDeltas: number[] = [];
    const clearDeltas: number[] = [];
    const transitiveTargets: number[] = [];
    for (const retryTime of [1_100, 1_200, 1_300]) {
      now = retryTime;
      const compareMarker = compareExpected.length;
      const clearMarker = clearExpected.length;

      await expect(client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "pending",
      });

      const batch = clearExpected.slice(clearMarker);
      const candidate = batch[0];
      if (candidate === undefined) {
        throw new Error("A failed retry must expose its cleanup candidate.");
      }
      compareDeltas.push(compareExpected.length - compareMarker);
      clearDeltas.push(batch.length);
      transitiveTargets.push(
        batch.filter(
          (target) =>
            !same(target, candidate) && !same(target, immediatePredecessor),
        ).length,
      );
      immediatePredecessor = candidate;
    }

    expect(compareDeltas).toEqual([0, 0, 0]);
    expect(Math.max(...clearDeltas)).toBeLessThanOrEqual(2);
    expect(transitiveTargets).toEqual([0, 0, 0]);
  });

  it("uses only null as CAS authority after cleanup proves the store missing", async () => {
    const policy = runtimePolicy();
    const competing: PersistedConsentState = {
      record: completedRecord(policy.policySnapshot, {
        decidedAt: 1_500,
        decisions: { analytics: "denied", personalization: "denied" },
        method: "reject-all",
        recordId: "record-competing",
        revision: 1,
      }),
    };
    let durable: PersistedConsentState | null = null;
    let loseFirstAcknowledgement = true;
    let failRecoveryRead = false;
    let raceDistinctGrant = false;
    const compareExpected: (PersistedConsentState | null)[] = [];
    const compareCandidates: PersistedConsentState[] = [];
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (!same(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        compareExpected.push(expected);
        compareCandidates.push(candidate);
        if (loseFirstAcknowledgement) {
          loseFirstAcknowledgement = false;
          durable = candidate;
          failRecoveryRead = true;
          return Promise.reject(new Error("write acknowledgement unavailable"));
        }
        if (raceDistinctGrant && expected === null) {
          raceDistinctGrant = false;
          durable = competing;
        }
        return Promise.resolve({ status: "conflict" as const });
      },
      read: () => {
        if (failRecoveryRead) {
          failRecoveryRead = false;
          return Promise.reject(new Error("recovery read unavailable"));
        }
        return Promise.resolve(stored(durable));
      },
    };
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 50_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...policy,
      store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      outcome: "pending",
    });
    expect(durable).toBeNull();
    const removedStage = compareCandidates[0];
    if (removedStage?.pendingGrant?.kind !== "decision") {
      throw new Error("The first grant must stage a decision candidate.");
    }
    const removedActivation: PersistedConsentState = {
      record: removedStage.pendingGrant.candidate,
    };
    const marker = compareExpected.length;
    raceDistinctGrant = true;
    now = 2_000;

    await expect(client.savePreferences(["analytics"])).resolves.toMatchObject({
      outcome: "pending",
    });

    const distinctAuthorities = compareExpected.slice(marker);
    expect(distinctAuthorities).toEqual([null]);
    expect(
      distinctAuthorities.some(
        (expected) =>
          same(expected, removedStage) || same(expected, removedActivation),
      ),
    ).toBe(false);
    expect(durable).toEqual(competing);
  });

  it("does not retain an unrelated observation as cleanup or fallback CAS authority", async () => {
    const policy = runtimePolicy();
    const unrelated: PersistedConsentState = {
      record: completedRecord(policy.policySnapshot, {
        decidedAt: 1_100,
        decisions: { analytics: "granted", personalization: "granted" },
        method: "accept-all",
        recordId: "record-unrelated",
        revision: 7,
      }),
    };
    const successor: PersistedConsentState = {
      record: completedRecord(policy.policySnapshot, {
        decidedAt: 1_900,
        decisions: { analytics: "denied", personalization: "denied" },
        method: "reject-all",
        recordId: "record-successor",
        revision: 1,
      }),
    };
    let durable: PersistedConsentState | null = null;
    let compareCount = 0;
    let advanceUnrelated = true;
    let now = 1_000;
    const compareExpected: (PersistedConsentState | null)[] = [];
    const clearExpected: PersistedConsentState[] = [];
    const store: DecisionStore = {
      clear: () => Promise.resolve(),
      clearIfCurrent: (expected) => {
        clearExpected.push(expected);
        return Promise.resolve("conflict" as const);
      },
      compareAndSet: (expected, candidate) => {
        compareCount += 1;
        compareExpected.push(expected);
        if (compareCount === 1) {
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        }
        if (compareCount === 2) {
          durable = unrelated;
          return Promise.resolve({ status: "readback-mismatch" as const });
        }
        if (advanceUnrelated && same(expected, unrelated)) {
          advanceUnrelated = false;
          durable = successor;
        }
        return Promise.resolve({ status: "conflict" as const });
      },
      read: () => Promise.resolve(stored(durable)),
    };
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 50_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...policy,
      store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-activation-unconfirmed" }],
      outcome: "pending",
    });
    const authorityMarker = compareExpected.length;
    const clearMarker = clearExpected.length;
    now = 2_000;
    await expect(client.savePreferences(["analytics"])).resolves.toMatchObject({
      outcome: "pending",
    });
    now = 3_000;
    await expect(
      client.savePreferences(["personalization"]),
    ).resolves.toMatchObject({ outcome: "pending" });

    const laterAuthorities = compareExpected.slice(authorityMarker);
    const unrelatedAuthorityUses = laterAuthorities.filter((expected) =>
      same(expected, unrelated),
    );
    const unrelatedCleanupUses = clearExpected
      .slice(clearMarker)
      .filter((expected) => same(expected, unrelated));
    expect.soft(unrelatedAuthorityUses).toHaveLength(1);
    expect.soft(unrelatedCleanupUses).toEqual([]);
    expect(durable).toEqual(successor);
  });
});
