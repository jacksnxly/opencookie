import { describe, expect, it, vi } from "vitest";

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

type PersistedActiveDecisionRecord = Exclude<
  PersistedDecisionRecord,
  { readonly method: "withdrawal" }
>;

function runtimePolicy() {
  const catalogue = definePolicy(
    completeTestPolicyDefinition({
      purposes: [{ id: "ads" }, { id: "analytics" }, { id: "personalization" }],
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
    resources: [],
    services: [],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function completedAnalyticsRecord(): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: {
      ads: "denied",
      analytics: "granted",
      personalization: "denied",
    },
    expiresAt: 86_401_000,
    method: "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-stale-consent",
    revision: 1,
  };
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

async function within<Result>(
  promise: Promise<Result>,
  label: string,
  timeoutMs = 2_000,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out.`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function grantedPurposeIds(effect: ConsentRuntimeTransitionEffect) {
  return effect.runtime.accessConsent.decisions
    .filter(({ decision }) => decision === "granted")
    .map(({ purposeId }) => purposeId)
    .sort();
}

describe("createOpenCookie stale consent signal filtering", () => {
  it("does not widen stale correction signals after terminal reservation", async () => {
    const completed = completedAnalyticsRecord();
    let durable: PersistedConsentState | null = { record: completed };
    let failNarrowerStage = false;
    const narrowerStageFailed = deferred();
    const firstGrantReconcileStarted = deferred();
    const releaseFirstGrantReconcile = deferred();
    let holdFirstGrant = false;
    let firstGrantTransitionId: string | undefined;
    let terminalReserved = false;
    let narrowerTransitionId: string | undefined;
    const staleGrantedCallbacks: Array<{
      readonly grantedPurposeIds: readonly string[];
      readonly port: "broadcast" | "reconcile";
      readonly transitionId: string;
    }> = [];
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
        if (
          failNarrowerStage &&
          candidate.pendingGrant?.kind === "decision" &&
          candidate.pendingGrant.candidate.method === "granular" &&
          candidate.pendingGrant.candidate.decisions["personalization"] ===
            "granted"
        ) {
          failNarrowerStage = false;
          narrowerStageFailed.resolve();
          return Promise.reject(
            new Error("narrower grant storage unavailable"),
          );
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
    const observe = async (
      port: "broadcast" | "reconcile",
      effect: ConsentRuntimeTransitionEffect,
    ) => {
      const granted = grantedPurposeIds(effect);
      if (
        terminalReserved &&
        effect.transitionId === narrowerTransitionId &&
        granted.length > 0
      ) {
        staleGrantedCallbacks.push({
          grantedPurposeIds: granted,
          port,
          transitionId: effect.transitionId,
        });
      }
      if (
        holdFirstGrant &&
        port === "reconcile" &&
        effect.record.method === "accept-all" &&
        granted.length > 0
      ) {
        holdFirstGrant = false;
        firstGrantTransitionId = effect.transitionId;
        firstGrantReconcileStarted.resolve();
        await releaseFirstGrantReconcile.promise;
      }
    };
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: (effect) => observe("broadcast", effect),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      reconcile: (effect) => observe("reconcile", effect),
      ...runtimePolicy(),
      store,
    });
    await within(client.initialize(), "initialization");
    expect(client.getSnapshot().runtime.effectiveAccess.resources).toEqual([]);
    expect(
      client
        .getSnapshot()
        .runtime.accessConsent.decisions.find(
          ({ purposeId }) => purposeId === "analytics",
        )?.decision,
    ).toBe("granted");

    holdFirstGrant = true;
    now = 2_000;
    const firstGrant = client.acceptAll();
    await within(firstGrantReconcileStarted.promise, "first grant reconcile");
    if (firstGrantTransitionId === undefined) {
      throw new Error("First grant must expose its pending transition.");
    }

    failNarrowerStage = true;
    now = 3_000;
    const narrowerGrant = client.savePreferences([
      "analytics",
      "personalization",
    ]);
    await within(narrowerStageFailed.promise, "narrower grant stage failure");
    await vi.waitFor(() => {
      const transitionId = client.getSnapshot().pendingGrant?.transitionId;
      expect(transitionId).toBeDefined();
      expect(transitionId).not.toBe(firstGrantTransitionId);
      narrowerTransitionId = transitionId;
    });
    expect(
      client
        .getSnapshot()
        .runtime.accessConsent.decisions.find(
          ({ purposeId }) => purposeId === "analytics",
        )?.decision,
    ).toBe("granted");

    terminalReserved = true;
    now = 4_000;
    const terminal = client.rejectAll();
    try {
      await vi.waitFor(() => {
        expect(
          client
            .getSnapshot()
            .runtime.accessConsent.decisions.some(
              ({ decision }) => decision === "granted",
            ),
        ).toBe(false);
      });
    } finally {
      releaseFirstGrantReconcile.resolve();
      await within(
        Promise.allSettled([firstGrant, narrowerGrant, terminal]),
        "superseded grants and terminal",
      );
    }

    expect(client.getSnapshot().record?.method).toBe("reject-all");
    expect(
      client
        .getSnapshot()
        .record?.decisions.map(({ purposeId, value }) => [purposeId, value]),
    ).toEqual([
      ["ads", "denied"],
      ["analytics", "denied"],
      ["personalization", "denied"],
    ]);
    expect(
      client
        .getSnapshot()
        .runtime.accessConsent.decisions.some(
          ({ decision }) => decision === "granted",
        ),
    ).toBe(false);
    expect(staleGrantedCallbacks).toEqual([]);
  });
});
