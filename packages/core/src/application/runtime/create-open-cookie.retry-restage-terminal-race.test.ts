import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
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
        serviceId: "analytics-service",
      },
    ],
    services: [{ id: "analytics-service" }],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
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

function accessOf(snapshot: OpenCookieSnapshot): "allowed" | "blocked" {
  const resource = snapshot.runtime.effectiveAccess.resources.find(
    ({ resourceId }) => resourceId === "analytics-script",
  );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

function within<Result>(
  promise: Promise<Result>,
  label: string,
  timeoutMs = 500,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${label}.`));
    }, timeoutMs);
    void promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new Error("Timed operation rejected.", { cause: error }),
        );
      },
    );
  });
}

describe("createOpenCookie retry restaging terminal race", () => {
  it("lets a terminal overtake a written retry stage whose acknowledgement is parked", async () => {
    const policy = runtimePolicy();
    const retryStageWritten = deferred();
    const releaseRetryAcknowledgement = deferred();
    const transitions = ["transition-grant", "transition-terminal"];
    const terminalExpectedStates: PersistedConsentState[] = [];
    let durable: PersistedConsentState | null = null;
    let compareCount = 0;
    let retryStage: PersistedConsentState | undefined;
    let retryAcknowledgementReleased = false;
    let now = 1_000;
    const durableState = () => durable;

    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (durable === null) return Promise.resolve("cleared");
        if (!same(durable, expected)) return Promise.resolve("conflict");
        durable = null;
        return Promise.resolve("cleared");
      },
      compareAndSet: (expected, candidate) => {
        compareCount += 1;
        if (compareCount === 1) {
          return Promise.reject(new Error("initial stage unavailable"));
        }
        if (!same(durable, expected)) {
          return Promise.resolve({ status: "conflict" });
        }
        durable = candidate;
        if (compareCount === 2 && candidate.pendingGrant?.kind === "decision") {
          retryStage = candidate;
          retryStageWritten.resolve();
          return releaseRetryAcknowledgement.promise.then(() => ({
            status: "written" as const,
          }));
        }
        if (candidate.record?.method === "reject-all") {
          if (expected === null) {
            throw new Error("Terminal must replace the exact retry stage.");
          }
          terminalExpectedStates.push(expected);
        }
        return Promise.resolve({ status: "written" });
      },
      read: () => Promise.resolve(stored(durable)),
    };
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record"
          ? "record-grant"
          : (transitions.shift() ?? "unexpected-transition"),
      now: () => now,
      ...policy,
      store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
    });
    expect(durable).toBeNull();

    now = 2_000;
    const retry = client.retryPendingGrant();
    await within(retryStageWritten.promise, "retry stage write");
    expect(retryStage).toMatchObject({
      pendingGrant: {
        candidate: { method: "accept-all", recordId: "record-grant" },
        receiptOccurredAt: 2_000,
        transitionId: "transition-grant",
      },
    });
    expect(durable).toBe(retryStage);

    const terminal = client.rejectAll();
    let terminalResult: Awaited<typeof terminal>;
    try {
      terminalResult = await within(
        terminal,
        "terminal persistence while retry acknowledgement is parked",
      );
      expect(retryAcknowledgementReleased).toBe(false);
      expect(terminalResult).toMatchObject({ outcome: "committed" });
      expect(terminalExpectedStates).toHaveLength(1);
      expect(terminalExpectedStates[0]).toBe(retryStage);
      expect(durable).toMatchObject({
        record: {
          decisions: { analytics: "denied", personalization: "denied" },
          method: "reject-all",
          recordId: "record-grant",
        },
      });
      expect(durableState()?.pendingGrant).toBeUndefined();
    } finally {
      retryAcknowledgementReleased = true;
      releaseRetryAcknowledgement.resolve();
    }
    expect(retryAcknowledgementReleased).toBe(true);

    const retryResult = await within(retry, "invalidated retry");
    expect(retryResult).toMatchObject({ outcome: "invalidated" });
    if (!("diagnostics" in retryResult)) {
      throw new Error("Invalidated retry must expose diagnostics.");
    }
    expect(retryResult.diagnostics.map(({ code }) => code)).toContain(
      "grant-superseded",
    );
    expect(durableState()?.pendingGrant).toBeUndefined();
    expect(durableState()?.record?.method).toBe("reject-all");

    const reloaded = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `reload-${kind}`,
      now: () => now,
      ...policy,
      store,
    });
    const snapshot = await reloaded.initialize();

    expect(snapshot.grantActivation).toBe("not-applicable");
    expect(snapshot.pendingGrant).toBeUndefined();
    expect(snapshot.record?.method).toBe("reject-all");
    expect(accessOf(snapshot)).toBe("blocked");
  });
});
