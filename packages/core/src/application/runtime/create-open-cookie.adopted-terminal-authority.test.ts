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
import { persistedConsentStatesEqual } from "./persisted-consent-record.js";

type PersistedActiveDecisionRecord = Exclude<
  PersistedDecisionRecord,
  { readonly method: "withdrawal" }
>;

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

function completedLocalRecord(): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "denied" },
    expiresAt: 86_401_000,
    method: "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-local",
    revision: 1,
  };
}

function unrelatedActiveRecord(): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 3_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "granted" },
    expiresAt: 86_403_000,
    method: "accept-all",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-unrelated",
    revision: 7,
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

function snapshotAccess(client: ReturnType<typeof createOpenCookie>) {
  const resource = client
    .getSnapshot()
    .runtime.effectiveAccess.resources.find(
      ({ resourceId }) => resourceId === "analytics-script",
    );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

describe("createOpenCookie adopted terminal authority", () => {
  it("never republishes an adopted grant while its terminal command owns authority", async () => {
    const local = completedLocalRecord();
    const unrelated = unrelatedActiveRecord();
    let durable: PersistedConsentState | null = { record: local };
    let failBroaderStage = false;
    let terminalReadsArmed = false;
    let terminalReadCount = 0;
    const secondTerminalReadStarted = deferred();
    const releaseSecondTerminalRead = deferred();
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
          failBroaderStage &&
          candidate.pendingGrant?.kind === "decision" &&
          candidate.pendingGrant.candidate.method === "accept-all"
        ) {
          failBroaderStage = false;
          return Promise.reject(new Error("broader grant storage unavailable"));
        }
        if (!statesEqual(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        durable = candidate;
        return Promise.resolve({ status: "written" as const });
      },
      read: async () => {
        if (terminalReadsArmed) {
          terminalReadCount += 1;
          if (terminalReadCount === 2) {
            secondTerminalReadStarted.resolve();
            await releaseSecondTerminalRead.promise;
          }
        }
        return durable === null
          ? { status: "missing" as const }
          : { state: durable, status: "stored" as const };
      },
    };
    let generated = 0;
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => now,
      ...runtimePolicy(),
      store,
    });
    await within(client.initialize(), "initialization");
    now = 2_000;
    failBroaderStage = true;
    await expect(
      within(client.acceptAll(), "failed broader grant"),
    ).resolves.toMatchObject({ outcome: "pending" });
    expect(client.getSnapshot()).toMatchObject({
      pendingGrant: { phase: "persistence" },
      record: { recordId: local.recordId, revision: local.revision },
    });
    expect(snapshotAccess(client)).toBe("allowed");

    durable = { record: unrelated };
    const publications: Array<{
      readonly access: "allowed" | "blocked";
      readonly recordId: string | undefined;
    }> = [];
    let terminalReserved = false;
    let terminalSettled = false;
    const unsubscribe = client.subscribe(() => {
      if (!terminalReserved || terminalSettled) return;
      publications.push({
        access: snapshotAccess(client),
        recordId: client.getSnapshot().record?.recordId,
      });
    });
    terminalReadsArmed = true;
    now = 4_000;
    terminalReserved = true;
    const terminal = client.rejectAll().then((result) => {
      terminalSettled = true;
      return result;
    });
    let heldSnapshot:
      | {
          readonly access: "allowed" | "blocked";
          readonly recordId: string | undefined;
        }
      | undefined;
    try {
      await within(
        secondTerminalReadStarted.promise,
        "terminal reread after adoption",
      );
      heldSnapshot = {
        access: snapshotAccess(client),
        recordId: client.getSnapshot().record?.recordId,
      };
    } finally {
      releaseSecondTerminalRead.resolve();
      await within(terminal, "terminal completion");
      unsubscribe();
    }

    expect.soft(heldSnapshot).toEqual({
      access: "blocked",
      recordId: unrelated.recordId,
    });
    expect.soft(publications).not.toContainEqual({
      access: "allowed",
      recordId: unrelated.recordId,
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "not-applicable",
      record: {
        method: "reject-all",
        recordId: unrelated.recordId,
        revision: 8,
      },
    });
    expect(snapshotAccess(client)).toBe("blocked");
    expect(durable).toMatchObject({
      record: {
        method: "reject-all",
        recordId: unrelated.recordId,
        revision: 8,
      },
    });
  });
});
