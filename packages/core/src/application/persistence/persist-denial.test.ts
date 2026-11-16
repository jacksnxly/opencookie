import { expect, it } from "vitest";

import {
  persistDenial,
  type DecisionStore,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../application.js";

const rejection: PersistedDecisionRecord = {
  catalogueDigest: "catalogue-1",
  decidedAt: 1_000,
  decisionSurfaceDigest: "surface-1",
  decisions: { ads: "denied", analytics: "denied" },
  expiresAt: 2_000,
  method: "reject-all",
  policyVersion: "policy-1",
  recordId: "record-1",
  revision: 2,
};

const previous: PersistedDecisionRecord = {
  ...rejection,
  decisions: { ads: "granted", analytics: "granted" },
  method: "accept-all",
  revision: 1,
};

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function stateRecord(state: PersistedConsentState): PersistedDecisionRecord {
  if (state.record === undefined) throw new Error("fixture requires a record");
  return state.record;
}

it("refuses to replace a concurrent aggregate during a denial retry", async () => {
  const concurrent: PersistedDecisionRecord = {
    ...rejection,
    recordId: "record-concurrent",
  };
  let record: PersistedDecisionRecord = concurrent;
  let writes = 0;
  const store = {
    clear: () => Promise.resolve(),
    clearIfCurrent: () => Promise.resolve("conflict" as const),
    compareAndSet: (_expected: unknown, next: PersistedConsentState) => {
      writes += 1;
      record = stateRecord(next);
      return Promise.resolve({ status: "written" as const });
    },
    read: () =>
      Promise.resolve({ state: state(record), status: "stored" as const }),
  };

  await expect(persistDenial(store, concurrent, rejection)).resolves.toEqual({
    diagnostics: [{ code: "denial-persistence-conflict" }],
    effectiveRecord: rejection,
    outcome: "degraded",
  });
  expect(writes).toBe(0);
  expect(record).toBe(concurrent);
});

it("keeps reject-all effective when persistence throws", async () => {
  const operations: string[] = [];
  const store = {
    clear: () => {
      operations.push("clear");
      return Promise.resolve();
    },
    clearIfCurrent: () => {
      operations.push("clear");
      return Promise.resolve("cleared" as const);
    },
    compareAndSet: () => {
      operations.push("persist");
      return Promise.reject(new Error("quota exceeded"));
    },
    read: () => Promise.reject(new Error("readback must not gate denial")),
  };

  await expect(persistDenial(store, previous, rejection)).resolves.toEqual({
    diagnostics: [{ code: "denial-persistence-failed" }],
    effectiveRecord: rejection,
    outcome: "degraded",
  });
  expect(Object.values(rejection.decisions)).toEqual(["denied", "denied"]);
  expect(operations).toEqual(["persist", "clear"]);
});

it("degrades a denial when storage reports a readback mismatch", async () => {
  let cleared = false;
  const store = {
    clear: () => {
      cleared = true;
      return Promise.resolve();
    },
    clearIfCurrent: () => {
      cleared = true;
      return Promise.resolve("cleared" as const);
    },
    compareAndSet: () =>
      Promise.resolve({ status: "readback-mismatch" as const }),
    read: () => Promise.reject(new Error("store already reported mismatch")),
  };

  await expect(persistDenial(store, previous, rejection)).resolves.toEqual({
    diagnostics: [{ code: "denial-readback-mismatch" }],
    effectiveRecord: rejection,
    outcome: "degraded",
  });
  expect(cleared).toBe(true);
});

it("clears the exact previous grant after candidate cleanup readback is unconfirmed", async () => {
  const cleanupCandidates: PersistedDecisionRecord[] = [];
  const store: DecisionStore = {
    clear: () => Promise.resolve(),
    clearIfCurrent: (expected) => {
      const expectedRecord = stateRecord(expected);
      cleanupCandidates.push(expectedRecord);
      return Promise.resolve(
        expectedRecord === rejection ? "readback-mismatch" : "cleared",
      );
    },
    compareAndSet: () => Promise.resolve({ status: "readback-mismatch" }),
    read: () => Promise.resolve({ state: state(previous), status: "stored" }),
  };

  await expect(persistDenial(store, previous, rejection)).resolves.toEqual({
    diagnostics: [{ code: "denial-readback-mismatch" }],
    effectiveRecord: rejection,
    outcome: "degraded",
  });
  expect(cleanupCandidates).toEqual([rejection, previous]);
});

it("reports when a failed denial cannot clear an older durable grant", async () => {
  const store = {
    clear: () => Promise.reject(new Error("clear denied")),
    clearIfCurrent: () => Promise.reject(new Error("clear denied")),
    compareAndSet: () => Promise.reject(new Error("quota exceeded")),
    read: () => Promise.reject(new Error("readback must not gate denial")),
  };

  await expect(persistDenial(store, previous, rejection)).resolves.toEqual({
    diagnostics: [
      { code: "denial-persistence-failed" },
      { code: "denial-clear-failed" },
    ],
    effectiveRecord: rejection,
    outcome: "degraded",
  });
});

it("reports when a store cannot clear after a failed denial", async () => {
  const store = {
    compareAndSet: () => Promise.reject(new Error("quota exceeded")),
    read: () => Promise.reject(new Error("readback must not gate denial")),
  } as unknown as DecisionStore;

  await expect(persistDenial(store, previous, rejection)).resolves.toEqual({
    diagnostics: [
      { code: "denial-persistence-failed" },
      { code: "denial-clear-unavailable" },
    ],
    effectiveRecord: rejection,
    outcome: "degraded",
  });
});
