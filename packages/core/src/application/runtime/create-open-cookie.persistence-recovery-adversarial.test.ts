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

function grantRecord() {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "granted" },
    expiresAt: 86_401_000,
    method: "accept-all",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-restored",
    revision: 1,
  } satisfies PersistedDecisionRecord;
}

function denialRecord(
  overrides: Partial<
    Pick<
      PersistedDecisionRecord,
      "decidedAt" | "expiresAt" | "recordId" | "revision"
    >
  > = {},
) {
  return {
    ...grantRecord(),
    decisions: { analytics: "denied", personalization: "denied" },
    method: "reject-all",
    ...overrides,
  } satisfies PersistedDecisionRecord;
}

function same(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

interface WriteObservation {
  readonly candidate: PersistedConsentState;
  readonly expected: PersistedConsentState | null;
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

describe("createOpenCookie persistence recovery adversarial cases", () => {
  it.each(["reject", "withdraw"] as const)(
    "supersedes an ambiguously staged restore marker with an immediate %s",
    async (action) => {
      const active = grantRecord();
      let durable: PersistedConsentState | null = { record: active };
      let readCount = 0;
      let lostRestoreAcknowledgement = false;
      const writes: WriteObservation[] = [];
      const clears: PersistedConsentState[] = [];
      const store: DecisionStore = {
        clear: () => {
          durable = null;
          return Promise.resolve();
        },
        clearIfCurrent: (expected) => {
          clears.push(expected);
          if (!same(durable, expected)) {
            return Promise.resolve("conflict" as const);
          }
          durable = null;
          return Promise.resolve("cleared" as const);
        },
        compareAndSet: (expected, candidate) => {
          writes.push({ candidate, expected });
          if (!same(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          if (
            !lostRestoreAcknowledgement &&
            candidate.pendingGrant?.kind === "restore"
          ) {
            lostRestoreAcknowledgement = true;
            return Promise.reject(
              new Error("restore marker acknowledgement unavailable"),
            );
          }
          return Promise.resolve({ status: "written" as const });
        },
        read: () => {
          readCount += 1;
          if (readCount === 2) {
            return Promise.reject(new Error("recovery read unavailable"));
          }
          return Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: durable, status: "stored" as const },
          );
        },
      };
      const effects: ConsentRuntimeTransitionEffect[] = [];
      const transitionIds = ["transition-restore", "transition-terminal"];
      const client = createOpenCookie({
        broadcast: (effect) => {
          effects.push(effect);
          return Promise.resolve();
        },
        consentDurationMs: 86_400_000,
        idGenerator: (kind) =>
          kind === "transition"
            ? (transitionIds.shift() ?? "unexpected-transition")
            : "unexpected-record",
        now: () => 2_000,
        ...runtimePolicy(),
        store,
      });

      await expect(client.initialize()).resolves.toMatchObject({
        grantActivation: "pending",
        pendingGrant: {
          phase: "persistence",
          transitionId: "transition-restore",
        },
        record: { recordId: active.recordId, revision: 1 },
      });
      const restoreMarker = durable;
      expect(restoreMarker).toEqual({
        pendingGrant: {
          kind: "restore",
          transitionId: "transition-restore",
        },
        record: active,
      });
      expect(client.getSnapshot().runtime.effectiveAccess.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            access: "blocked",
            resourceId: "analytics-script",
          }),
        ]),
      );

      const terminal = await (action === "reject"
        ? client.rejectAll()
        : client.withdrawConsent());

      expect(terminal).toMatchObject({
        outcome: "committed",
        transition: {
          persistenceStatus: "confirmed",
          record: {
            method: action === "reject" ? "reject-all" : "withdrawal",
            recordId: active.recordId,
            revision: 2,
          },
          transitionId: "transition-terminal",
        },
      });
      expect(durable).toMatchObject({
        record: {
          method: action === "reject" ? "reject-all" : "withdrawal",
          recordId: active.recordId,
          revision: 2,
        },
      });
      expect(durable).not.toHaveProperty("pendingGrant");
      expect(clears).toEqual([]);
      expect(
        writes.some(
          ({ candidate, expected }) =>
            same(expected, restoreMarker) &&
            candidate.pendingGrant === undefined &&
            candidate.record?.method ===
              (action === "reject" ? "reject-all" : "withdrawal"),
        ),
      ).toBe(true);

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
      await expect(reloaded.initialize()).resolves.toMatchObject({
        grantActivation: "not-applicable",
        record: {
          method: action === "reject" ? "reject-all" : "withdrawal",
          recordId: active.recordId,
          revision: 2,
        },
      });
      expect(
        reloadEffects.some((effect) => accessOf(effect) === "allowed"),
      ).toBe(false);
    },
  );

  it("advances a new grant from a future durable record adopted after terminal failure", async () => {
    const future = denialRecord({
      decidedAt: 10_000,
      expiresAt: 86_410_000,
      recordId: "record-external",
      revision: 7,
    });
    let durable: PersistedConsentState | null = null;
    let injectFutureOnTerminalFailure = true;
    const writes: WriteObservation[] = [];
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
        writes.push({ candidate, expected });
        if (injectFutureOnTerminalFailure) {
          injectFutureOnTerminalFailure = false;
          durable = { record: future };
          return Promise.reject(new Error("terminal write unavailable"));
        }
        if (!same(durable, expected)) {
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
    let transitionNumber = 0;
    const idGenerator = vi.fn((kind: "record" | "transition") => {
      if (kind === "record") return "record-failed-terminal";
      transitionNumber += 1;
      return `transition-${String(transitionNumber)}`;
    });
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator,
      now: () => 2_000,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    await expect(client.rejectAll()).resolves.toMatchObject({
      diagnostics: [
        { code: "denial-persistence-failed" },
        { code: "denial-clear-failed" },
      ],
      outcome: "degraded",
    });
    expect(durable).toEqual({ record: future });

    const grant = client.acceptAll();
    await expect(grant).resolves.toMatchObject({
      outcome: "committed",
      transition: {
        persistenceStatus: "confirmed",
        record: {
          decidedAt: future.decidedAt,
          method: "accept-all",
          recordId: future.recordId,
          revision: future.revision + 1,
        },
      },
    });
    const result = await grant;
    if (!("transition" in result)) {
      throw new Error("Committed grant must expose its transition.");
    }
    expect(result.transition.record.decidedAt).toBeGreaterThanOrEqual(
      future.decidedAt,
    );
    expect(durable).toMatchObject({
      record: {
        decidedAt: future.decidedAt,
        method: "accept-all",
        recordId: future.recordId,
        revision: future.revision + 1,
      },
    });
    expect(durable).not.toHaveProperty("pendingGrant");
    expect(
      writes.some(
        ({ candidate, expected }) =>
          same(expected, { record: future }) &&
          candidate.pendingGrant?.kind === "decision" &&
          candidate.pendingGrant.candidate.recordId === future.recordId &&
          candidate.pendingGrant.candidate.revision === future.revision + 1 &&
          candidate.pendingGrant.candidate.decidedAt >= future.decidedAt,
      ),
    ).toBe(true);
  });
});
