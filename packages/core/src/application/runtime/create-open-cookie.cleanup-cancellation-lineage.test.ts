import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
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

function rejectionGate(): {
  readonly promise: Promise<never>;
  readonly reject: () => void;
} {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  return {
    promise,
    reject: () => {
      reject(new Error("staged cleanup unavailable"));
    },
  };
}

async function within<Result>(
  promise: Promise<Result>,
  label: string,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out.`));
    }, 2_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function isActivatableAnalyticsGrant(
  state: PersistedConsentState | null,
): boolean {
  return (
    state?.pendingGrant?.kind === "decision" &&
    state.pendingGrant.candidate.decisions["analytics"] === "granted"
  );
}

describe("createOpenCookie cancelled cleanup lineage", () => {
  it("does not strand an ambiguously staged grant when a terminal waits on its cleanup", async () => {
    let durable: PersistedConsentState | null = null;
    let failNextGrantStage = false;
    let failReads = false;
    let failedReads = 0;
    let releaseRequested = false;
    let staged: PersistedConsentState | undefined;
    const cleanupStarted = deferred();
    const releaseCleanup = rejectionGate();
    const terminalReadStarted = deferred();
    const store: DecisionStore = {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: async (expected) => {
        if (
          staged !== undefined &&
          statesEqual(expected, staged) &&
          !releaseRequested
        ) {
          cleanupStarted.resolve();
          await releaseCleanup.promise;
        }
        if (!statesEqual(durable, expected)) {
          return "conflict" as const;
        }
        durable = null;
        return "cleared" as const;
      },
      compareAndSet: (expected, candidate) => {
        if (!statesEqual(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        durable = candidate;
        if (failNextGrantStage && candidate.pendingGrant?.kind === "decision") {
          failNextGrantStage = false;
          staged = candidate;
          return Promise.resolve({ status: "readback-mismatch" as const });
        }
        return Promise.resolve({ status: "written" as const });
      },
      read: () => {
        if (failReads) {
          failedReads += 1;
          terminalReadStarted.resolve();
          return Promise.reject(
            new Error("terminal recovery read unavailable"),
          );
        }
        return Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const },
        );
      },
    };
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...runtimePolicy(),
      store,
    });
    await within(client.initialize(), "initialization");
    await expect(
      within(
        client.savePreferences(["personalization"]),
        "completed baseline grant",
      ),
    ).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        record: {
          decisions: { analytics: "denied", personalization: "granted" },
          revision: 1,
        },
      },
    });
    const completed = durable;
    expect(completed).toMatchObject({
      record: { method: "granular", revision: 1 },
    });

    failNextGrantStage = true;
    const grant = client.acceptAll();
    await within(cleanupStarted.promise, "ambiguous-stage cleanup start");
    expect(durable).toMatchObject({
      pendingGrant: {
        candidate: {
          decisions: { analytics: "granted", personalization: "granted" },
          revision: 2,
        },
        kind: "decision",
      },
      record: { method: "granular", revision: 1 },
    });

    failReads = true;
    const terminal = client.rejectAll();
    await within(terminalReadStarted.promise, "terminal persisted-base read");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    releaseRequested = true;
    releaseCleanup.reject();

    const [grantResult, terminalResult] = await within(
      Promise.all([grant, terminal]),
      "cancelled cleanup and terminal settlement",
    );
    expect(grantResult).toMatchObject({ outcome: "invalidated" });
    expect(["committed", "degraded"]).toContain(terminalResult.outcome);
    expect(failedReads).toBeGreaterThanOrEqual(2);

    const durableBeforeReload = durable;
    failReads = false;
    const reloadEffects: ConsentRuntimeTransitionEffect[] = [];
    const reloaded = createOpenCookie({
      broadcast: (effect) => {
        reloadEffects.push(effect);
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-reload`,
      now: () => 3_000,
      ...runtimePolicy(),
      store,
    });
    const reloadSnapshot = await within(reloaded.initialize(), "reload");

    const strandedActivatableGrant =
      isActivatableAnalyticsGrant(durableBeforeReload);
    expect.soft(strandedActivatableGrant).toBe(false);
    expect.soft(reloadSnapshot.grantActivation).not.toBe("active");
    expect
      .soft(reloadEffects.some((effect) => accessOf(effect) === "allowed"))
      .toBe(false);
  });
});
