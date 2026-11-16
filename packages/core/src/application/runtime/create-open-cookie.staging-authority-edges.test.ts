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
  timeoutMs = 1_000,
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

describe("createOpenCookie staging authority edges", () => {
  it("starts a fresh grant after an expired retry is invalidated", async () => {
    const policy = runtimePolicy();
    const transitionIds = ["transition-expired", "transition-fresh"];
    let durable: PersistedConsentState | null = null;
    let storageAvailable = false;
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
        if (!same(durable, expected)) {
          return Promise.resolve({ status: "conflict" });
        }
        if (!storageAvailable) {
          return Promise.reject(new Error("storage unavailable"));
        }
        durable = candidate;
        return Promise.resolve({ status: "written" });
      },
      read: () => Promise.resolve(stored(durable)),
    };
    const client = createOpenCookie({
      consentDurationMs: 1_000,
      idGenerator: (kind) =>
        kind === "record"
          ? "record-grant"
          : (transitionIds.shift() ?? "unexpected-transition"),
      now: () => now,
      ...policy,
      store,
    });
    await client.initialize();

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "pending",
      transition: {
        record: { decidedAt: 1_000, expiresAt: 2_000 },
        transitionId: "transition-expired",
      },
    });

    storageAvailable = true;
    now = 2_500;
    const expired = await client.retryPendingGrant();
    expect(expired).toMatchObject({
      outcome: "invalidated",
      transition: { transitionId: "transition-expired" },
    });
    if (!("diagnostics" in expired)) {
      throw new Error("Expired retry must expose diagnostics.");
    }
    expect(expired.diagnostics.map(({ code }) => code)).toContain(
      "grant-expired-before-activation",
    );
    expect(accessOf(client.getSnapshot())).toBe("blocked");

    now = 3_000;
    const fresh = await client.acceptAll();

    expect(fresh).toMatchObject({
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: {
          decidedAt: 3_000,
          expiresAt: 4_000,
          method: "accept-all",
          recordId: "record-grant",
        },
        transitionId: "transition-fresh",
      },
    });
    expect(durable).toMatchObject({
      record: {
        decidedAt: 3_000,
        expiresAt: 4_000,
        method: "accept-all",
        recordId: "record-grant",
      },
    });
    expect(durableState()?.pendingGrant).toBeUndefined();
    expect(client.getSnapshot()).toMatchObject({ grantActivation: "active" });
    expect(client.getSnapshot()).not.toHaveProperty("pendingGrant");
    expect(accessOf(client.getSnapshot())).toBe("allowed");
  });

  it("keeps the snapshot blocked when terminal authority is reserved during activation readback", async () => {
    const policy = runtimePolicy();
    const finalActivationReadStarted = deferred();
    const releaseFinalActivationRead = deferred();
    const terminalWritten = deferred();
    const transitionIds = ["transition-grant", "transition-terminal"];
    const terminalExpectedStates: PersistedConsentState[] = [];
    let durable: PersistedConsentState | null = null;
    let readCount = 0;
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
        if (!same(durable, expected)) {
          return Promise.resolve({ status: "conflict" });
        }
        durable = candidate;
        if (candidate.record?.method === "reject-all") {
          if (expected === null) {
            throw new Error("Terminal must replace the active grant.");
          }
          terminalExpectedStates.push(expected);
          terminalWritten.resolve();
        }
        return Promise.resolve({ status: "written" });
      },
      read: () => {
        readCount += 1;
        const captured = durable;
        if (readCount === 4) {
          finalActivationReadStarted.resolve();
          return releaseFinalActivationRead.promise.then(() =>
            stored(captured),
          );
        }
        return Promise.resolve(stored(captured));
      },
    };
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record"
          ? "record-grant"
          : (transitionIds.shift() ?? "unexpected-transition"),
      now: () => 1_000,
      ...policy,
      store,
    });
    await client.initialize();

    const grant = client.acceptAll();
    await within(finalActivationReadStarted.promise, "final activation read");
    const activeBeforeTerminal = durableState();
    expect(activeBeforeTerminal).toMatchObject({
      record: { method: "accept-all", recordId: "record-grant" },
    });
    expect(activeBeforeTerminal?.pendingGrant).toBeUndefined();

    const terminal = client.rejectAll();
    await within(terminalWritten.promise, "terminal write");
    const terminalResult = await within(
      terminal,
      "terminal settlement before activation read release",
    );

    expect(terminalResult).toMatchObject({ outcome: "committed" });
    expect(terminalExpectedStates).toEqual([activeBeforeTerminal]);
    expect(client.getSnapshot().record?.method).toBe("reject-all");
    expect(accessOf(client.getSnapshot())).toBe("blocked");

    releaseFinalActivationRead.resolve();
    const grantResult = await within(grant, "superseded grant settlement");

    expect(grantResult).toMatchObject({ outcome: "invalidated" });
    if (!("diagnostics" in grantResult)) {
      throw new Error("Superseded grant must expose diagnostics.");
    }
    expect(grantResult.diagnostics.map(({ code }) => code)).toContain(
      "grant-superseded",
    );
    expect(durableState()).toMatchObject({
      record: { method: "reject-all", recordId: "record-grant" },
    });
    expect(durableState()?.pendingGrant).toBeUndefined();
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "not-applicable",
      record: { method: "reject-all", recordId: "record-grant" },
    });
    expect(client.getSnapshot()).not.toHaveProperty("pendingGrant");
    expect(accessOf(client.getSnapshot())).toBe("blocked");
  });
});
