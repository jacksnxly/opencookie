import { describe, expect, it } from "vitest";

import {
  createLocalStorageDecisionStore,
  type StorageLike,
} from "../../infrastructure.js";
import {
  persistDenial,
  persistGrant,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../application.js";

const record: PersistedDecisionRecord = {
  catalogueDigest: "catalogue-1",
  decidedAt: 1_000,
  decisionSurfaceDigest: "surface-1",
  decisions: { analytics: "granted" },
  expiresAt: 2_000,
  method: "accept-all",
  policyVersion: "policy-1",
  recordId: "record-1",
  revision: 1,
};

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function memoryStorage(initial?: string): StorageLike {
  let value = initial ?? null;
  return {
    getItem: () => value,
    removeItem: () => {
      value = null;
    },
    setItem: (_key, next) => {
      value = next;
    },
  };
}

describe("local storage decision store", () => {
  it("distinguishes missing, malformed, and future-schema values", async () => {
    await expect(
      createLocalStorageDecisionStore({
        key: "oc-consent",
        schemaVersion: 1,
        storage: memoryStorage(),
      }).read(),
    ).resolves.toEqual({ status: "missing" });

    await expect(
      createLocalStorageDecisionStore({
        key: "oc-consent",
        schemaVersion: 1,
        storage: memoryStorage("not-json secret-value"),
      }).read(),
    ).resolves.toEqual({ reason: "malformed-json", status: "invalid" });

    await expect(
      createLocalStorageDecisionStore({
        key: "oc-consent",
        schemaVersion: 1,
        storage: memoryStorage(JSON.stringify({ record, schemaVersion: 2 })),
      }).read(),
    ).resolves.toEqual({ reason: "future-schema", status: "invalid" });
  });

  it.each([
    ["a read failure", undefined],
    ["a malformed value", "not-json private-value"],
  ] as const)(
    "reports %s as ambiguous instead of a proven conflict",
    async (_label, initial) => {
      const storage: StorageLike =
        initial === undefined
          ? {
              getItem: () => {
                throw new Error("storage read failed");
              },
              removeItem: () => undefined,
              setItem: () => undefined,
            }
          : memoryStorage(initial);
      const store = createLocalStorageDecisionStore({
        key: "oc-consent",
        schemaVersion: 1,
        storage,
      });

      await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
        status: "readback-mismatch",
      });
      await expect(store.clearIfCurrent(state(record))).resolves.toBe(
        "readback-mismatch",
      );
    },
  );

  it("cleans up a grant whose immediate readback mismatches so reload cannot restore it", async () => {
    let obscureNextRead = false;
    let value: string | null = null;
    const storage: StorageLike = {
      getItem: () => {
        if (obscureNextRead) {
          obscureNextRead = false;
          return "corrupted-after-write private-value";
        }
        return value;
      },
      removeItem: () => {
        value = null;
      },
      setItem: (_key, next) => {
        value = next;
        obscureNextRead = true;
      },
    };
    const store = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage,
    });

    await expect(persistGrant(store, null, record)).resolves.toMatchObject({
      outcome: "grant-persistence-unconfirmed",
    });

    const reloaded = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage,
    });
    await expect(reloaded.read()).resolves.toEqual({ status: "missing" });
  });

  it("round-trips a closed valid record", async () => {
    const store = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage: memoryStorage(),
    });

    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "written",
    });
    await expect(store.read()).resolves.toEqual({
      state: state(record),
      status: "stored",
    });
  });

  it("conditionally clears only the exact durable record token", async () => {
    const storage = memoryStorage();
    const store = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage,
    });
    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "written",
    });

    await expect(
      store.clearIfCurrent(
        state({ ...record, decisions: { analytics: "denied" } }),
      ),
    ).resolves.toBe("conflict");
    await expect(store.read()).resolves.toEqual({
      state: state(record),
      status: "stored",
    });
    await expect(store.clearIfCurrent(state(record))).resolves.toBe("cleared");
    await expect(store.read()).resolves.toEqual({ status: "missing" });
  });

  it("reports an unconfirmed clear without deleting a concurrent replacement", async () => {
    const concurrent: PersistedDecisionRecord = {
      ...record,
      recordId: "record-concurrent",
      revision: 2,
    };
    let value: string | null = null;
    let replaceDuringClear = false;
    const storage: StorageLike = {
      getItem: () => value,
      removeItem: () => {
        value = replaceDuringClear
          ? JSON.stringify({ record: concurrent, schemaVersion: 1 })
          : null;
      },
      setItem: (_key, next) => {
        value = next;
      },
    };
    const store = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage,
    });
    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "written",
    });
    replaceDuringClear = true;

    await expect(store.clearIfCurrent(state(record))).resolves.toBe(
      "readback-mismatch",
    );
    await expect(store.read()).resolves.toEqual({
      state: state(concurrent),
      status: "stored",
    });
  });

  it.each(["grant", "denial"] as const)(
    "preserves a concurrent replacement installed between the rollback guard and write during %s persistence",
    async (kind) => {
      const candidate: PersistedDecisionRecord = {
        ...record,
        decidedAt: 1_500,
        decisions: {
          analytics: kind === "grant" ? "granted" : "denied",
        },
        expiresAt: 2_500,
        method: kind === "grant" ? "granular" : "reject-all",
        revision: 2,
      };
      const concurrent: PersistedDecisionRecord = {
        ...candidate,
        decidedAt: 1_750,
        expiresAt: 2_750,
        recordId: "record-concurrent",
        revision: 7,
      };
      const concurrentRaw = JSON.stringify({
        record: concurrent,
        schemaVersion: 1,
      });
      let installConcurrentBeforeRollback = false;
      let obscureCandidateReadback = false;
      let concurrentInstalled = false;
      let value: string | null = null;
      const storage: StorageLike = {
        getItem: () => {
          if (obscureCandidateReadback) {
            obscureCandidateReadback = false;
            installConcurrentBeforeRollback = true;
            return "corrupted-after-candidate-write";
          }
          const observed = value;
          if (installConcurrentBeforeRollback) {
            installConcurrentBeforeRollback = false;
            concurrentInstalled = true;
            value = concurrentRaw;
          }
          return observed;
        },
        removeItem: () => {
          value = null;
        },
        setItem: (_key, next) => {
          if (installConcurrentBeforeRollback) {
            installConcurrentBeforeRollback = false;
            concurrentInstalled = true;
            value = concurrentRaw;
          }
          value = next;
          const envelope = JSON.parse(next) as {
            readonly record: PersistedDecisionRecord;
          };
          if (envelope.record.revision === candidate.revision) {
            obscureCandidateReadback = true;
          }
        },
      };
      const store = createLocalStorageDecisionStore({
        key: "oc-consent",
        schemaVersion: 1,
        storage,
      });
      await expect(persistGrant(store, null, record)).resolves.toMatchObject({
        outcome: "confirmed",
      });

      const result =
        kind === "grant"
          ? await persistGrant(store, record, candidate)
          : await persistDenial(store, record, candidate);

      expect(result.outcome).toBe(
        kind === "grant" ? "grant-persistence-unconfirmed" : "degraded",
      );
      expect(concurrentInstalled).toBe(true);
      await expect(store.read()).resolves.toEqual({
        state: state(concurrent),
        status: "stored",
      });
    },
  );

  it("does not restore an older grant after a mixed narrowing readback mismatch", async () => {
    let obscureSecondWriteReadback = false;
    let value: string | null = null;
    let writes = 0;
    const storage: StorageLike = {
      getItem: () => {
        if (obscureSecondWriteReadback) {
          obscureSecondWriteReadback = false;
          return "corrupted-after-narrowing";
        }
        return value;
      },
      removeItem: () => {
        value = null;
      },
      setItem: (_key, next) => {
        value = next;
        writes += 1;
        if (writes === 2) obscureSecondWriteReadback = true;
      },
    };
    const options = {
      key: "oc-consent",
      schemaVersion: 1,
      storage,
    };
    const store = createLocalStorageDecisionStore(options);
    const previous: PersistedDecisionRecord = {
      ...record,
      decisions: { analytics: "granted", personalization: "granted" },
    };
    const narrowing: PersistedDecisionRecord = {
      ...previous,
      decidedAt: 1_500,
      decisions: { analytics: "granted", personalization: "denied" },
      expiresAt: 2_500,
      method: "granular",
      revision: 2,
    };

    await expect(persistGrant(store, null, previous)).resolves.toMatchObject({
      outcome: "confirmed",
    });
    await expect(persistGrant(store, previous, narrowing)).resolves.toEqual({
      diagnostics: [{ code: "grant-readback-mismatch" }],
      outcome: "grant-persistence-unconfirmed",
    });

    await expect(
      createLocalStorageDecisionStore(options).read(),
    ).resolves.toEqual({ status: "missing" });
  });

  it("clears the exact previous grant when it reappears during denial cleanup", async () => {
    const previous: PersistedDecisionRecord = {
      ...record,
      decisions: { analytics: "granted", personalization: "granted" },
    };
    const rejection: PersistedDecisionRecord = {
      ...previous,
      decidedAt: 1_500,
      decisions: { analytics: "denied", personalization: "denied" },
      expiresAt: 2_500,
      method: "reject-all",
      revision: 2,
    };
    const previousRaw = JSON.stringify({ record: previous, schemaVersion: 1 });
    let value: string | null = null;
    let writes = 0;
    let obscureDenialReadback = false;
    let restorePreviousDuringClear = false;
    const storage: StorageLike = {
      getItem: () => {
        if (obscureDenialReadback) {
          obscureDenialReadback = false;
          restorePreviousDuringClear = true;
          return "unconfirmed-denial-readback";
        }
        return value;
      },
      removeItem: () => {
        value = restorePreviousDuringClear ? previousRaw : null;
        restorePreviousDuringClear = false;
      },
      setItem: (_key, next) => {
        value = next;
        writes += 1;
        if (writes === 2) obscureDenialReadback = true;
      },
    };
    const store = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage,
    });

    await expect(persistGrant(store, null, previous)).resolves.toMatchObject({
      outcome: "confirmed",
    });
    await expect(persistDenial(store, previous, rejection)).resolves.toEqual({
      diagnostics: [{ code: "denial-readback-mismatch" }],
      effectiveRecord: rejection,
      outcome: "degraded",
    });
    await expect(store.read()).resolves.toEqual({ status: "missing" });
  });

  it.each(["grant", "denial"] as const)(
    "clears an older wider grant after a transient initial read during %s persistence",
    async (kind) => {
      let failNextRead = false;
      let value: string | null = null;
      const storage: StorageLike = {
        getItem: () => {
          if (failNextRead) {
            failNextRead = false;
            throw new Error("transient read failure");
          }
          return value;
        },
        removeItem: () => {
          value = null;
        },
        setItem: (_key, next) => {
          value = next;
        },
      };
      const store = createLocalStorageDecisionStore({
        key: "oc-consent",
        schemaVersion: 1,
        storage,
      });
      const previous: PersistedDecisionRecord = {
        ...record,
        decisions: { analytics: "granted", personalization: "granted" },
      };
      const next: PersistedDecisionRecord = {
        ...previous,
        decidedAt: 1_500,
        decisions:
          kind === "grant"
            ? { analytics: "granted", personalization: "denied" }
            : { analytics: "denied", personalization: "denied" },
        expiresAt: 2_500,
        method: kind === "grant" ? "granular" : "reject-all",
        revision: 2,
      };

      await expect(persistGrant(store, null, previous)).resolves.toMatchObject({
        outcome: "confirmed",
      });
      failNextRead = true;

      const result =
        kind === "grant"
          ? await persistGrant(store, previous, next)
          : await persistDenial(store, previous, next);
      expect(result).toMatchObject({
        diagnostics: [
          {
            code:
              kind === "grant"
                ? "grant-readback-mismatch"
                : "denial-readback-mismatch",
          },
        ],
        outcome:
          kind === "grant" ? "grant-persistence-unconfirmed" : "degraded",
      });
      await expect(store.read()).resolves.toEqual({ status: "missing" });
    },
  );
});
