import { describe, expect, it } from "vitest";

import {
  initializeConsent,
  type DecisionStoreReadResult,
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

async function initialize(readResult: DecisionStoreReadResult) {
  return initializeConsent({ read: () => Promise.resolve(readResult) });
}

describe("initializeConsent", () => {
  it("treats missing storage as a normal first visit", async () => {
    await expect(initialize({ status: "missing" })).resolves.toEqual({
      diagnostics: [],
      status: "first-visit",
    });
  });

  it("restores the active record while retaining the complete state", async () => {
    const state: PersistedConsentState = {
      pendingGrant: { kind: "restore", transitionId: "transition-restore" },
      record,
    };

    await expect(initialize({ state, status: "stored" })).resolves.toEqual({
      diagnostics: [],
      record,
      state,
      status: "restored",
    });
  });

  it("retains a pending-only first grant without treating it as active", async () => {
    const state = {
      pendingGrant: {
        candidate: record,
        kind: "decision",
        receiptOccurredAt: 1_100,
        transitionId: "transition-first",
      },
    } satisfies PersistedConsentState;

    await expect(initialize({ state, status: "stored" })).resolves.toEqual({
      diagnostics: [],
      state,
      status: "pending",
    });
  });

  it("captures custom-store state once without retaining source identity", async () => {
    const mutableRecord = {
      ...record,
      decisions: { ...record.decisions },
    };
    const source = { record: mutableRecord };
    let propertyReads = 0;
    let ownKeyReads = 0;
    const proxied = new Proxy(source, {
      get: (target, property, receiver) => {
        propertyReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
      ownKeys: (target) => {
        ownKeyReads += 1;
        return Reflect.ownKeys(target);
      },
    });

    const result = await initialize({ state: proxied, status: "stored" });

    expect(result.status).toBe("restored");
    if (result.status !== "restored") throw new Error("fixture must restore");
    expect(propertyReads).toBe(0);
    expect(ownKeyReads).toBe(1);
    expect(result.state).not.toBe(source);
    expect(result.state).not.toBe(proxied);
    expect(result.record).toBe(result.state.record);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);

    mutableRecord.decisions["analytics"] = "denied";
    expect(result.record.decisions["analytics"]).toBe("granted");
  });

  it("maps an accessor-bearing custom-store state to invalid-record without invoking it", async () => {
    let accessorReads = 0;
    const state = Object.defineProperty({}, "record", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return record;
      },
    });

    await expect(
      initialize({
        state: state as PersistedConsentState,
        status: "stored",
      }),
    ).resolves.toEqual({
      diagnostics: [
        { code: "stored-consent-invalid", reason: "invalid-record" },
      ],
      status: "invalid",
    });
    expect(accessorReads).toBe(0);
  });

  it("fails closed with a sanitized diagnostic for invalid storage", async () => {
    await expect(
      initialize({ reason: "malformed-json", status: "invalid" }),
    ).resolves.toEqual({
      diagnostics: [
        {
          code: "stored-consent-invalid",
          reason: "malformed-json",
        },
      ],
      status: "invalid",
    });
  });

  it("keeps ambiguous duplicate storage distinct from invalid bytes", async () => {
    await expect(
      initialize({ candidateCount: 2, status: "ambiguous-duplicate" }),
    ).resolves.toEqual({
      diagnostics: [
        {
          candidateCount: 2,
          code: "stored-consent-ambiguous-duplicate",
        },
      ],
      status: "invalid",
    });
  });
});
