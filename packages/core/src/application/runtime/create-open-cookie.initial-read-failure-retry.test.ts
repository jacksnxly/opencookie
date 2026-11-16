import { describe, expect, it } from "vitest";

import {
  createOpenCookie,
  type DecisionStore,
  type PersistedConsentState,
  type StoredConsentInvalidReason,
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

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function recoverableInitialReadStore(): {
  readonly compareAttempts: () => number;
  readonly recover: () => void;
  readonly store: DecisionStore;
  readonly stored: () => PersistedConsentState | null;
  readonly writeCount: () => number;
  readonly writtenStates: () => readonly PersistedConsentState[];
} {
  let compareAttempts = 0;
  let durable: PersistedConsentState | null = null;
  let readable = false;
  const writtenStates: PersistedConsentState[] = [];
  return {
    compareAttempts: () => compareAttempts,
    recover: () => {
      readable = true;
    },
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (!readable) return Promise.resolve("readback-mismatch" as const);
        if (durable === null) return Promise.resolve("cleared" as const);
        if (!statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        compareAttempts += 1;
        if (!readable) {
          return Promise.resolve({ status: "readback-mismatch" as const });
        }
        if (!statesEqual(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        durable = candidate;
        writtenStates.push(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          !readable
            ? { reason: "read-failed" as const, status: "invalid" as const }
            : durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
        ),
    },
    stored: () => durable,
    writeCount: () => writtenStates.length,
    writtenStates: () => writtenStates,
  };
}

function access(client: ReturnType<typeof createOpenCookie>) {
  return client
    .getSnapshot()
    .runtime.effectiveAccess.resources.find(
      ({ resourceId }) => resourceId === "analytics-script",
    )?.access;
}

const STRUCTURAL_INVALID_REASONS = [
  "future-schema",
  "invalid-record",
  "malformed-json",
  "readback-mismatch",
] as const satisfies readonly Exclude<
  StoredConsentInvalidReason,
  "read-failed"
>[];

describe("createOpenCookie initial read failure recovery", () => {
  it("keeps an unreadable Accept pending until the first recovered retry persists", async () => {
    const memory = recoverableInitialReadStore();
    let generated = 0;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-${String(++generated)}`,
      now: () => 2_000,
      ...runtimePolicy(),
      store: memory.store,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      diagnostics: [{ code: "stored-consent-invalid", reason: "read-failed" }],
      readiness: "invalid",
    });
    expect(access(client)).toBe("blocked");

    await expect(client.acceptAll()).resolves.toMatchObject({
      diagnostics: [
        { code: "grant-readback-mismatch" },
        { code: "grant-clear-unconfirmed" },
      ],
      outcome: "pending",
    });
    expect(memory.compareAttempts()).toBeGreaterThan(0);
    expect(memory.writeCount()).toBe(0);
    expect(memory.stored()).toBeNull();
    expect(access(client)).toBe("blocked");
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });

    memory.recover();
    await expect(client.retryPendingGrant()).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: { method: "accept-all" },
      },
    });
    expect(memory.writeCount()).toBe(2);
    expect(memory.writtenStates()).toMatchObject([
      {
        pendingGrant: {
          candidate: { method: "accept-all" },
          kind: "decision",
        },
      },
      { record: { method: "accept-all" } },
    ]);
    expect(memory.writtenStates()[0]?.record).toBeUndefined();
    expect(memory.writtenStates()[1]?.pendingGrant).toBeUndefined();
    expect(memory.stored()).toMatchObject({
      record: { method: "accept-all" },
    });
    expect(access(client)).toBe("allowed");
  });

  it.each(STRUCTURAL_INVALID_REASONS)(
    "keeps structural invalid reason %s blocked",
    async (reason) => {
      let writes = 0;
      const store: DecisionStore = {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared" as const),
        compareAndSet: () => {
          writes += 1;
          return Promise.resolve({ status: "written" as const });
        },
        read: () =>
          Promise.resolve({
            reason,
            status: "invalid" as const,
          }),
      };
      const client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-invalid`,
        now: () => 2_000,
        ...runtimePolicy(),
        store,
      });

      await expect(client.initialize()).resolves.toMatchObject({
        diagnostics: [{ code: "stored-consent-invalid", reason }],
        readiness: "invalid",
      });
      await expect(client.acceptAll()).rejects.toThrow(
        "Stored consent state is invalid.",
      );
      await expect(client.retryPendingGrant()).resolves.toMatchObject({
        outcome: "not-applicable",
      });
      expect(access(client)).toBe("blocked");
      expect(writes).toBe(0);
    },
  );
});
