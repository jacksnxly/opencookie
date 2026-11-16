import { describe, expect, it } from "vitest";

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

function malformedStoredState(): PersistedConsentState {
  const { policySnapshot } = runtimePolicy();
  const malformed = {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted" },
    expiresAt: 86_401_000,
    method: "accept-all",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-malformed",
    revision: Number.MAX_SAFE_INTEGER + 1,
  } as unknown as PersistedDecisionRecord;
  return { record: malformed };
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

describe("createOpenCookie invalid cold terminal initialization", () => {
  it("rejects a terminal command before any effect when stored consent is malformed", async () => {
    const malformed = malformedStoredState();
    const readStarted = deferred();
    const releaseRead = deferred();
    const calls = {
      broadcast: 0,
      clear: 0,
      clearIfCurrent: 0,
      compareAndSet: 0,
      receipt: 0,
      reconcile: 0,
    };
    const store: DecisionStore = {
      clear: () => {
        calls.clear += 1;
        return Promise.resolve();
      },
      clearIfCurrent: () => {
        calls.clearIfCurrent += 1;
        return Promise.resolve("conflict" as const);
      },
      compareAndSet: () => {
        calls.compareAndSet += 1;
        return Promise.resolve({ status: "written" as const });
      },
      read: async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return { state: malformed, status: "stored" as const };
      },
    };
    let generated = 0;
    const client = createOpenCookie({
      broadcast: () => {
        calls.broadcast += 1;
        return Promise.resolve();
      },
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      receipt: () => {
        calls.receipt += 1;
        return Promise.resolve();
      },
      reconcile: () => {
        calls.reconcile += 1;
        return Promise.resolve();
      },
      ...runtimePolicy(),
      store,
    });

    const command = client.rejectAll();
    await within(readStarted.promise, "malformed initialization read");
    const notifications: Array<{
      readonly diagnosticCodes: readonly string[];
      readonly readiness: string;
    }> = [];
    const unsubscribe = client.subscribe(() => {
      const snapshot = client.getSnapshot();
      notifications.push({
        diagnosticCodes: snapshot.diagnostics.map(({ code }) => code),
        readiness: snapshot.readiness,
      });
    });
    releaseRead.resolve();

    const settlement = await within(
      command.then(
        (result) => ({ result, status: "resolved" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      ),
      "terminal command rejection",
    );
    unsubscribe();

    expect.soft(settlement.status).toBe("rejected");
    expect.soft(client.getSnapshot()).toMatchObject({
      diagnostics: [
        { code: "stored-consent-invalid", reason: "invalid-record" },
      ],
      grantActivation: "not-applicable",
      readiness: "invalid",
    });
    expect.soft(client.getSnapshot()).not.toHaveProperty("record");
    expect.soft(notifications).toEqual([
      {
        diagnosticCodes: ["stored-consent-invalid"],
        readiness: "invalid",
      },
    ]);
    expect.soft(calls).toEqual({
      broadcast: 0,
      clear: 0,
      clearIfCurrent: 0,
      compareAndSet: 0,
      receipt: 0,
      reconcile: 0,
    });
  });
});
