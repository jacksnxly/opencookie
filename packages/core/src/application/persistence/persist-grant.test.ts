import { describe, expect, it } from "vitest";

import {
  persistGrant,
  type DecisionStore,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../application.js";
import { decisionRecordsEqual } from "./persist-grant.js";

const candidate: PersistedDecisionRecord = {
  catalogueDigest: "catalogue-1",
  consentId: "consent-1",
  decidedAt: 1_000,
  decisionSurfaceDigest: "surface-1",
  decisions: { ads: "denied", analytics: "granted" },
  expiresAt: 2_000,
  locale: "en-GB",
  method: "granular",
  policyVersion: "policy-1",
  recordId: "record-1",
  revision: 1,
};

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function stateRecord(state: PersistedConsentState): PersistedDecisionRecord {
  if (state.record === undefined) throw new Error("fixture requires a record");
  return state.record;
}

function storeWithReadback(
  initialRecord: PersistedDecisionRecord | undefined,
): DecisionStore {
  let record = initialRecord;
  return {
    clear: () => {
      record = undefined;
      return Promise.resolve();
    },
    clearIfCurrent: (expected) => {
      if (record === undefined) {
        return Promise.resolve("cleared" as const);
      }
      if (record !== stateRecord(expected)) {
        return Promise.resolve("conflict" as const);
      }
      record = undefined;
      return Promise.resolve("cleared" as const);
    },
    compareAndSet: () => Promise.resolve({ status: "written" }),
    read: () =>
      Promise.resolve(
        record === undefined
          ? { status: "missing" as const }
          : { state: state(record), status: "stored" as const },
      ),
  };
}

const mismatchCases = [
  ["record identity", { recordId: "another-record" }],
  ["revision", { revision: 2 }],
  ["policy version", { policyVersion: "policy-2" }],
  ["catalogue identity", { catalogueDigest: "catalogue-2" }],
  ["decision surface", { decisionSurfaceDigest: "surface-2" }],
  ["decision timestamp", { decidedAt: 1_001 }],
  ["expiry", { expiresAt: 2_001 }],
  ["method", { method: "accept-all" }],
  ["consent identity", { consentId: "consent-2" }],
  ["locale", { locale: "de-DE" }],
  ["decisions", { decisions: { ads: "granted", analytics: "granted" } }],
] satisfies readonly (readonly [string, Partial<PersistedDecisionRecord>])[];

describe("persistGrant", () => {
  it("canonicalizes key order and distinguishes every optional record field", () => {
    const reordered = Object.fromEntries(
      Object.entries(candidate).reverse(),
    ) as unknown as PersistedDecisionRecord;
    const withoutConsentId = {
      ...candidate,
      consentId: undefined,
    } as unknown as PersistedDecisionRecord;
    const withoutLocale = {
      ...candidate,
      locale: undefined,
    } as unknown as PersistedDecisionRecord;
    const withdrawal: PersistedDecisionRecord = {
      ...withoutConsentId,
      method: "withdrawal",
      withdrawnAt: 1_500,
    };

    expect(decisionRecordsEqual(candidate, reordered)).toBe(true);
    expect(decisionRecordsEqual(candidate, withoutConsentId)).toBe(false);
    expect(decisionRecordsEqual(candidate, withoutLocale)).toBe(false);
    expect(
      decisionRecordsEqual(withdrawal, { ...withdrawal, withdrawnAt: 1_501 }),
    ).toBe(false);
  });

  it("preserves a concurrent record when an ambiguous grant cleanup loses its exact match", async () => {
    const concurrent: PersistedDecisionRecord = {
      ...candidate,
      recordId: "record-concurrent",
      revision: 2,
    };
    let record: PersistedDecisionRecord | undefined;
    let unconditionalClears = 0;
    const cleanupCandidates: PersistedDecisionRecord[] = [];
    const store = {
      clear: () => {
        unconditionalClears += 1;
        record = undefined;
        return Promise.resolve();
      },
      clearIfCurrent: (expected: PersistedConsentState) => {
        const expectedRecord = stateRecord(expected);
        cleanupCandidates.push(expectedRecord);
        if (record !== expectedRecord) {
          return Promise.resolve("conflict" as const);
        }
        record = undefined;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (_expected: unknown, next: PersistedConsentState) => {
        record = stateRecord(next);
        record = concurrent;
        return Promise.reject(new Error("writer failed after mutation"));
      },
      read: () =>
        Promise.resolve(
          record === undefined
            ? { status: "missing" as const }
            : { state: state(record), status: "stored" as const },
        ),
    };

    await expect(persistGrant(store, null, candidate)).resolves.toEqual({
      diagnostics: [
        { code: "grant-write-failed" },
        { code: "grant-clear-conflict" },
      ],
      outcome: "grant-persistence-unconfirmed",
    });
    expect(unconditionalClears).toBe(0);
    expect(cleanupCandidates).toEqual([candidate]);
    expect(record).toBe(concurrent);
  });

  it("returns the final exact-previous conflict after candidate cleanup is unconfirmed", async () => {
    const previous: PersistedDecisionRecord = {
      ...candidate,
      decisions: { ads: "granted", analytics: "granted" },
    };
    const narrowing: PersistedDecisionRecord = {
      ...previous,
      decidedAt: 1_500,
      decisions: { ads: "denied", analytics: "granted" },
      expiresAt: 2_500,
      revision: 2,
    };
    const cleanupCandidates: PersistedDecisionRecord[] = [];
    const store: DecisionStore = {
      clear: () => Promise.resolve(),
      clearIfCurrent: (expected) => {
        const expectedRecord = stateRecord(expected);
        cleanupCandidates.push(expectedRecord);
        return Promise.resolve(
          expectedRecord === narrowing ? "readback-mismatch" : "conflict",
        );
      },
      compareAndSet: () => Promise.resolve({ status: "readback-mismatch" }),
      read: () => Promise.resolve({ state: state(previous), status: "stored" }),
    };

    await expect(persistGrant(store, previous, narrowing)).resolves.toEqual({
      diagnostics: [
        { code: "grant-readback-mismatch" },
        { code: "grant-clear-conflict" },
      ],
      outcome: "grant-persistence-unconfirmed",
    });
    expect(cleanupCandidates).toEqual([narrowing, previous]);
  });

  it("refuses to replace a concurrent aggregate even at the same revision", async () => {
    const concurrent: PersistedDecisionRecord = {
      ...candidate,
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

    await expect(persistGrant(store, concurrent, candidate)).resolves.toEqual({
      diagnostics: [{ code: "grant-write-conflict" }],
      outcome: "grant-persistence-unconfirmed",
    });
    expect(writes).toBe(0);
    expect(record).toBe(concurrent);
  });

  it("does not confirm a grant when write succeeds but readback is absent", async () => {
    await expect(
      persistGrant(storeWithReadback(undefined), null, candidate),
    ).resolves.toEqual({
      diagnostics: [{ code: "grant-readback-missing" }],
      outcome: "grant-persistence-unconfirmed",
    });
  });

  it.each(mismatchCases)(
    "rejects a %s readback mismatch",
    async (_label, difference) => {
      const mismatched = { ...candidate, ...difference };

      await expect(
        persistGrant(storeWithReadback(mismatched), null, candidate),
      ).resolves.toEqual({
        diagnostics: [
          { code: "grant-readback-mismatch" },
          { code: "grant-clear-conflict" },
        ],
        outcome: "grant-persistence-unconfirmed",
      });
    },
  );

  it("confirms canonical equality independent of decision key order", async () => {
    const reordered: PersistedDecisionRecord = {
      ...candidate,
      decisions: { analytics: "granted", ads: "denied" },
    };

    await expect(
      persistGrant(storeWithReadback(reordered), null, candidate),
    ).resolves.toEqual({ outcome: "confirmed", record: candidate });
  });

  it("clears and verifies a candidate after the later semantic read fails", async () => {
    let record: PersistedDecisionRecord | undefined;
    let failSemanticRead = true;
    let reads = 0;
    let clears = 0;
    const store: DecisionStore = {
      clear: () => {
        clears += 1;
        record = undefined;
        return Promise.resolve();
      },
      clearIfCurrent: () => {
        clears += 1;
        record = undefined;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (_expected, next) => {
        record = stateRecord(next);
        return Promise.resolve({ status: "written" });
      },
      read: () => {
        reads += 1;
        if (failSemanticRead) {
          failSemanticRead = false;
          return Promise.reject(new Error("semantic decoder unavailable"));
        }
        return Promise.resolve(
          record === undefined
            ? { status: "missing" as const }
            : { state: state(record), status: "stored" as const },
        );
      },
    };

    await expect(persistGrant(store, null, candidate)).resolves.toEqual({
      diagnostics: [{ code: "grant-readback-invalid" }],
      outcome: "grant-persistence-unconfirmed",
    });
    expect(clears).toBe(1);
    expect(reads).toBe(1);
    expect(record).toBeUndefined();
  });

  it("clears and verifies an ambiguous write-then-throw outcome", async () => {
    let record: PersistedDecisionRecord | undefined;
    let clears = 0;
    const store: DecisionStore = {
      clear: () => {
        clears += 1;
        record = undefined;
        return Promise.resolve();
      },
      clearIfCurrent: () => {
        clears += 1;
        record = undefined;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (_expected, next) => {
        record = stateRecord(next);
        return Promise.reject(new Error("writer failed after mutation"));
      },
      read: () =>
        Promise.resolve(
          record === undefined
            ? { status: "missing" as const }
            : { state: state(record), status: "stored" as const },
        ),
    };

    await expect(persistGrant(store, null, candidate)).resolves.toEqual({
      diagnostics: [{ code: "grant-write-failed" }],
      outcome: "grant-persistence-unconfirmed",
    });
    expect(clears).toBe(1);
    await expect(store.read()).resolves.toEqual({ status: "missing" });
  });
});
