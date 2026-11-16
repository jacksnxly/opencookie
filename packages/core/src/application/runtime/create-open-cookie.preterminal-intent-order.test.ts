import { describe, expect, it } from "vitest";

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

function completedAnalyticsRecord(): PersistedActiveDecisionRecord {
  const { policySnapshot } = runtimePolicy();
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decidedAt: 1_000,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    decisions: { analytics: "granted", personalization: "denied" },
    expiresAt: 86_401_000,
    method: "granular",
    policyVersion: policySnapshot.policyVersion,
    recordId: "record-intent-order",
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

async function progressesBeforeRelease(
  progress: Promise<void>,
  timeoutMs = 300,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      progress.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
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

function accessOf(client: ReturnType<typeof createOpenCookie>) {
  const resource = client
    .getSnapshot()
    .runtime.effectiveAccess.resources.find(
      ({ resourceId }) => resourceId === "analytics-script",
    );
  if (resource === undefined) throw new Error("Expected analytics resource.");
  return resource.access;
}

describe("createOpenCookie pre-terminal intent order", () => {
  it.each([
    ["grant", "granular", "allowed"],
    ["withdraw", "withdrawal", "blocked"],
  ] as const)(
    "keeps a newer %s authoritative when an older rejection read resumes",
    async (action, expectedMethod, expectedAccess) => {
      const completed = completedAnalyticsRecord();
      let durable: PersistedConsentState | null = { record: completed };
      const stored = (): PersistedConsentState | null => durable;
      let failBroaderGrantStage = false;
      let parkNextRead = false;
      let trackAuthority = false;
      const parkedReadStarted = deferred();
      const releaseParkedRead = deferred();
      const olderReservationApplied = deferred();
      const newerSignalStarted = deferred();
      const receipts: string[] = [];
      const signals: string[] = [];
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
            failBroaderGrantStage &&
            candidate.pendingGrant?.kind === "decision" &&
            candidate.pendingGrant.candidate.method === "accept-all"
          ) {
            failBroaderGrantStage = false;
            return Promise.reject(new Error("grant storage unavailable"));
          }
          if (!statesEqual(durable, expected)) {
            return Promise.resolve({ status: "conflict" as const });
          }
          durable = candidate;
          return Promise.resolve({ status: "written" as const });
        },
        read: async () => {
          if (parkNextRead) {
            parkNextRead = false;
            parkedReadStarted.resolve();
            await releaseParkedRead.promise;
          }
          return durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const };
        },
      };
      const observe = (
        port: "broadcast" | "reconcile",
        effect: ConsentRuntimeTransitionEffect,
      ) => {
        if (!trackAuthority) return;
        signals.push(`${port}:${effect.record.method}`);
        if (port === "reconcile" && effect.record.method === "reject-all") {
          olderReservationApplied.resolve();
        }
        if (effect.record.method === expectedMethod) {
          newerSignalStarted.resolve();
        }
      };
      let generated = 0;
      let now = 1_000;
      const client = createOpenCookie({
        broadcast: (effect) => {
          observe("broadcast", effect);
          return Promise.resolve();
        },
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-${String(++generated)}`,
        now: () => now,
        receipt: (receipt) => {
          if (trackAuthority) receipts.push(receipt.method);
          return Promise.resolve();
        },
        reconcile: (effect) => {
          observe("reconcile", effect);
          return Promise.resolve();
        },
        ...runtimePolicy(),
        store,
      });
      await within(client.initialize(), "initialization");
      now = 2_000;
      failBroaderGrantStage = true;
      await expect(
        within(client.acceptAll(), "failed broader grant"),
      ).resolves.toMatchObject({ outcome: "pending" });
      expect(accessOf(client)).toBe("allowed");

      trackAuthority = true;
      parkNextRead = true;
      now = 3_000;
      const olderRejection = client.rejectAll();
      let newerIntent:
        | ReturnType<typeof client.savePreferences>
        | ReturnType<typeof client.withdrawConsent>
        | undefined;
      let newerBoundary: number;
      let progressed: boolean;
      try {
        await within(parkedReadStarted.promise, "older rejection read");
        await within(
          olderReservationApplied.promise,
          "older rejection reservation",
          300,
        );
        expect(accessOf(client)).toBe("blocked");
        newerBoundary = signals.length;
        now = 4_000;
        newerIntent =
          action === "grant"
            ? client.savePreferences(["analytics"])
            : client.withdrawConsent();
        progressed = await progressesBeforeRelease(newerSignalStarted.promise);
      } finally {
        releaseParkedRead.resolve();
        await within(
          Promise.allSettled(
            newerIntent === undefined
              ? [olderRejection]
              : [olderRejection, newerIntent],
          ),
          "competing user intents",
        );
      }

      expect.soft(progressed).toBe(true);
      expect
        .soft(
          signals
            .slice(newerBoundary)
            .filter((value) => value.endsWith("reject-all")),
        )
        .toEqual([]);
      expect.soft(receipts).not.toContain("reject-all");
      expect.soft(stored()?.record?.method).toBe(expectedMethod);
      expect.soft(stored()).not.toHaveProperty("pendingGrant");
      expect.soft(client.getSnapshot().record?.method).toBe(expectedMethod);
      expect.soft(accessOf(client)).toBe(expectedAccess);

      const reloaded = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: (kind) => `${kind}-reload`,
        now: () => 5_000,
        ...runtimePolicy(),
        store,
      });
      await within(reloaded.initialize(), "reload");
      expect.soft(reloaded.getSnapshot().record?.method).toBe(expectedMethod);
      expect.soft(accessOf(reloaded)).toBe(expectedAccess);
    },
  );
});
