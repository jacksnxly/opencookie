import { describe, expect, it } from "vitest";

import {
  createCookieDecisionStore,
  createLocalStorageDecisionStore,
  type CookieJarLike,
  type StorageLike,
} from "../../infrastructure.js";
import type {
  PersistedConsentState,
  PersistedDecisionRecord,
} from "../../application.js";
import {
  decodeDecisionRecordEnvelope,
  encodeDecisionRecordEnvelope,
} from "./decision-record-codec.js";

const activeRecord: PersistedDecisionRecord = {
  catalogueDigest: "catalogue-1",
  decidedAt: 1_000,
  decisionSurfaceDigest: "surface-1",
  decisions: { analytics: "granted", marketing: "denied" },
  expiresAt: 10_000,
  method: "granular",
  policyVersion: "policy-1",
  recordId: "record-1",
  revision: 1,
};

const replacementCandidate: PersistedDecisionRecord = {
  ...activeRecord,
  decidedAt: 2_000,
  decisions: { analytics: "granted", marketing: "granted" },
  expiresAt: 11_000,
  revision: 2,
};

const firstCandidate: PersistedDecisionRecord = {
  ...activeRecord,
  recordId: "record-first",
};

const activeState: PersistedConsentState = { record: activeRecord };
const firstPendingState: PersistedConsentState = {
  pendingGrant: {
    candidate: firstCandidate,
    kind: "decision",
    receiptOccurredAt: 1_100,
    transitionId: "transition-first",
  },
};
const replacementPendingState: PersistedConsentState = {
  pendingGrant: {
    candidate: replacementCandidate,
    kind: "decision",
    receiptOccurredAt: 2_100,
    transitionId: "transition-replacement",
  },
  record: activeRecord,
};
const restorePendingState: PersistedConsentState = {
  pendingGrant: {
    kind: "restore",
    transitionId: "transition-restore",
  },
  record: activeRecord,
};

const deniedRecord: PersistedDecisionRecord = {
  ...activeRecord,
  decisions: { analytics: "denied", marketing: "denied" },
  method: "granular",
};

const withdrawnRecord: PersistedDecisionRecord = {
  ...deniedRecord,
  method: "withdrawal",
  withdrawnAt: 1_500,
};

function envelope(state: object): string {
  return JSON.stringify({ ...state, schemaVersion: 1 });
}

function memoryStorage(initial?: string): StorageLike & {
  readonly current: () => string | null;
} {
  let value = initial ?? null;
  return {
    current: () => value,
    getItem: () => value,
    removeItem: () => {
      value = null;
    },
    setItem: (_key, next) => {
      value = next;
    },
  };
}

function memoryCookieJar(initial = ""): CookieJarLike {
  let cookieHeader = initial;
  return {
    read: () => cookieHeader,
    write: (serializedCookie) => {
      const [pair] = serializedCookie.split(";");
      cookieHeader = /Max-Age=0/i.test(serializedCookie) ? "" : (pair ?? "");
    },
  };
}

describe("persisted pending consent state", () => {
  it.each([
    ["first grant", firstPendingState],
    ["replacement grant", replacementPendingState],
    ["restored grant", restorePendingState],
  ])("round-trips an immutable detached %s state", (_name, state) => {
    const raw = encodeDecisionRecordEnvelope(state, 1);
    const decoded = decodeDecisionRecordEnvelope(raw, 1);

    expect(decoded).toEqual({ state, status: "stored" });
    if (decoded.status !== "stored") throw new Error("fixture must decode");
    expect(decoded.state).not.toBe(state);
    expect(Object.isFrozen(decoded.state)).toBe(true);
    expect(Object.isFrozen(decoded.state.pendingGrant)).toBe(true);
    if (decoded.state.pendingGrant?.kind === "decision") {
      expect(decoded.state.pendingGrant.candidate).not.toBe(
        state.pendingGrant?.kind === "decision"
          ? state.pendingGrant.candidate
          : undefined,
      );
      expect(Object.isFrozen(decoded.state.pendingGrant.candidate)).toBe(true);
      expect(
        Object.isFrozen(decoded.state.pendingGrant.candidate.decisions),
      ).toBe(true);
    }
  });

  it("reads the legacy flattened record-only envelope as an active state", () => {
    const legacyRaw = JSON.stringify({
      record: activeRecord,
      schemaVersion: 1,
    });

    expect(decodeDecisionRecordEnvelope(legacyRaw, 1)).toEqual({
      state: activeState,
      status: "stored",
    });
    expect(JSON.parse(encodeDecisionRecordEnvelope(activeState, 1))).toEqual(
      JSON.parse(legacyRaw),
    );
  });

  it.each([
    ["missing state", {}],
    [
      "restore without an active record",
      { pendingGrant: { kind: "restore", transitionId: "transition-1" } },
    ],
    [
      "missing decision candidate",
      {
        pendingGrant: {
          kind: "decision",
          receiptOccurredAt: 1_100,
          transitionId: "transition-1",
        },
      },
    ],
    [
      "malformed pending kind",
      {
        pendingGrant: {
          candidate: firstCandidate,
          kind: "callback",
          receiptOccurredAt: 1_100,
          transitionId: "transition-1",
        },
      },
    ],
    [
      "blank transition identifier",
      {
        pendingGrant: {
          candidate: firstCandidate,
          kind: "decision",
          receiptOccurredAt: 1_100,
          transitionId: "  ",
        },
      },
    ],
    [
      "denial candidate",
      {
        pendingGrant: {
          candidate: {
            ...firstCandidate,
            decisions: { analytics: "denied", marketing: "denied" },
            method: "reject-all",
          },
          kind: "decision",
          receiptOccurredAt: 1_100,
          transitionId: "transition-1",
        },
      },
    ],
    [
      "unsafe receipt occurrence",
      {
        pendingGrant: {
          candidate: firstCandidate,
          kind: "decision",
          receiptOccurredAt: Number.MAX_SAFE_INTEGER + 1,
          transitionId: "transition-1",
        },
      },
    ],
    [
      "receipt before the decision",
      {
        pendingGrant: {
          candidate: firstCandidate,
          kind: "decision",
          receiptOccurredAt: firstCandidate.decidedAt - 1,
          transitionId: "transition-1",
        },
      },
    ],
    ["extra state key", { ...activeState, unexpected: true }],
    [
      "extra pending key",
      {
        ...firstPendingState,
        pendingGrant: { ...firstPendingState.pendingGrant, callback: "later" },
      },
    ],
    [
      "extra candidate key",
      {
        pendingGrant: {
          ...firstPendingState.pendingGrant,
          candidate: { ...firstCandidate, unexpected: true },
        },
      },
    ],
    [
      "sparse candidate decisions",
      {
        pendingGrant: {
          ...firstPendingState.pendingGrant,
          candidate: {
            ...firstCandidate,
            decisions: new Array<"granted">(1),
          },
        },
      },
    ],
  ])("rejects a malformed %s envelope", (_name, state) => {
    expect(decodeDecisionRecordEnvelope(envelope(state), 1)).toEqual({
      reason: "invalid-record",
      status: "invalid",
    });
  });

  it.each([
    [
      "first grant whose candidate revision is not one",
      {
        pendingGrant: {
          ...firstPendingState.pendingGrant,
          candidate: { ...firstCandidate, revision: 2 },
        },
      },
    ],
    [
      "replacement grant with a different record identifier",
      {
        ...replacementPendingState,
        pendingGrant: {
          ...replacementPendingState.pendingGrant,
          candidate: {
            ...replacementCandidate,
            recordId: "record-other",
          },
        },
      },
    ],
    [
      "replacement grant that repeats the active revision",
      {
        ...replacementPendingState,
        pendingGrant: {
          ...replacementPendingState.pendingGrant,
          candidate: { ...replacementCandidate, revision: 1 },
        },
      },
    ],
    [
      "replacement grant that skips an active revision",
      {
        ...replacementPendingState,
        pendingGrant: {
          ...replacementPendingState.pendingGrant,
          candidate: { ...replacementCandidate, revision: 3 },
        },
      },
    ],
    [
      "replacement grant decided before the active transition",
      {
        pendingGrant: {
          candidate: {
            ...replacementCandidate,
            decidedAt: 1_499,
          },
          kind: "decision",
          receiptOccurredAt: 1_600,
          transitionId: "transition-after-withdrawal",
        },
        record: withdrawnRecord,
      },
    ],
    [
      "restore marker for an active record without a grant",
      {
        pendingGrant: {
          kind: "restore",
          transitionId: "transition-restore-denied",
        },
        record: deniedRecord,
      },
    ],
    [
      "restore marker for a withdrawn active record",
      {
        pendingGrant: {
          kind: "restore",
          transitionId: "transition-restore-withdrawn",
        },
        record: withdrawnRecord,
      },
    ],
  ])("rejects impossible pending lineage: %s", (_name, state) => {
    expect(decodeDecisionRecordEnvelope(envelope(state), 1)).toEqual({
      reason: "invalid-record",
      status: "invalid",
    });
  });

  it("rejects accessor, inherited, method, symbol, and hostile state values without invoking them", () => {
    let accessorReads = 0;
    let methodCalls = 0;
    const accessorState = Object.defineProperty({}, "pendingGrant", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return firstPendingState.pendingGrant;
      },
    });
    const inheritedState = Object.create({
      pendingGrant: firstPendingState.pendingGrant,
    }) as PersistedConsentState;
    const methodState = {
      ...firstPendingState,
      toJSON: () => {
        methodCalls += 1;
        return firstPendingState;
      },
    };
    const symbolState = Object.assign({}, firstPendingState, {
      [Symbol("unexpected")]: true,
    });
    const hostileState = new Proxy(firstPendingState, {
      ownKeys: () => {
        throw new Error("private hostile detail");
      },
    });

    for (const candidate of [
      accessorState,
      inheritedState,
      methodState,
      symbolState,
      hostileState,
    ]) {
      expect(() =>
        encodeDecisionRecordEnvelope(candidate as PersistedConsentState, 1),
      ).toThrow(TypeError);
    }
    expect(accessorReads).toBe(0);
    expect(methodCalls).toBe(0);
  });

  it("rejects a revoked Proxy with a defined error before storage writes", async () => {
    let writes = 0;
    const store = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => {
          writes += 1;
        },
      },
    });
    const revoked = Proxy.revocable(firstPendingState, {});
    revoked.revoke();

    await expect(store.compareAndSet(null, revoked.proxy)).rejects.toThrow(
      "Persisted consent state is invalid.",
    );
    expect(writes).toBe(0);
  });
});

describe("complete-state browser storage preconditions", () => {
  it("compares the complete localStorage state for CAS and conditional clear", async () => {
    const storage = memoryStorage();
    const store = createLocalStorageDecisionStore({
      key: "oc-consent",
      schemaVersion: 1,
      storage,
    });
    const pending = replacementPendingState.pendingGrant;
    if (pending?.kind !== "decision")
      throw new Error("fixture must be pending");
    const stale = {
      ...replacementPendingState,
      pendingGrant: {
        ...pending,
        receiptOccurredAt: 2_050,
      },
    } satisfies PersistedConsentState;

    await expect(store.compareAndSet(null, activeState)).resolves.toEqual({
      status: "written",
    });
    await expect(
      store.compareAndSet(activeState, replacementPendingState),
    ).resolves.toEqual({ status: "written" });
    const bytes = storage.current();

    await expect(store.compareAndSet(stale, activeState)).resolves.toEqual({
      status: "conflict",
    });
    await expect(store.clearIfCurrent(stale)).resolves.toBe("conflict");
    expect(storage.current()).toBe(bytes);
    await expect(store.read()).resolves.toEqual({
      state: replacementPendingState,
      status: "stored",
    });
  });

  it("rejects a stale cookie transition even when record and candidate revisions match", async () => {
    const store = createCookieDecisionStore({
      hostname: "localhost",
      jar: memoryCookieJar(),
      key: "oc-consent",
      schemaVersion: 1,
    });
    const pending = replacementPendingState.pendingGrant;
    if (pending?.kind !== "decision")
      throw new Error("fixture must be pending");
    const stale = {
      ...replacementPendingState,
      pendingGrant: {
        ...pending,
        transitionId: "transition-stale",
      },
    } satisfies PersistedConsentState;

    await expect(store.compareAndSet(null, activeState)).resolves.toEqual({
      status: "written",
    });
    await expect(
      store.compareAndSet(activeState, replacementPendingState),
    ).resolves.toEqual({ status: "written" });
    await expect(store.compareAndSet(stale, activeState)).resolves.toEqual({
      status: "conflict",
    });
    await expect(store.read()).resolves.toEqual({
      state: replacementPendingState,
      status: "stored",
    });
  });
});
