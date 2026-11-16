import { describe, expect, it } from "vitest";

import {
  evaluateConsent,
  recordConsentDecision,
  withdrawConsent,
  type ConsentPolicyInput,
  type ConsentRecord,
} from "./index.js";

const policy = Object.freeze({
  catalogueDigest: "catalogue-v1",
  decisionSurfaceDigest: "surface-v1",
  optionalPurposeIds: Object.freeze(["analytics", "functional", "marketing"]),
  policyVersion: "policy-v1",
}) satisfies ConsentPolicyInput;

function createRecord(method: "accept-all" | "reject-all"): ConsentRecord {
  const result = recordConsentDecision(undefined, policy, {
    decidedAt: 1_000,
    expiresAt: 2_000,
    method,
    recordId: "record-1",
  });
  if (!result.ok || result.outcome !== "changed") {
    throw new Error("fixture record must be created");
  }
  return result.record;
}

describe("withdrawConsent", () => {
  it("denies every grant in exactly one new revision without re-prompting", () => {
    const current = createRecord("accept-all");
    const result = withdrawConsent(current, 1_500);
    if (!result.ok || result.outcome !== "changed") {
      throw new Error("granted fixture must change");
    }

    expect(result.record).toEqual({
      decidedAt: 1_000,
      decisions: [
        { purposeId: "analytics", value: "denied" },
        { purposeId: "functional", value: "denied" },
        { purposeId: "marketing", value: "denied" },
      ],
      expiresAt: 2_000,
      method: "withdrawal",
      policy: {
        catalogueDigest: "catalogue-v1",
        decisionSurfaceDigest: "surface-v1",
        policyVersion: "policy-v1",
      },
      recordId: "record-1",
      revision: 2,
      schemaVersion: 1,
      withdrawnAt: 1_500,
    });
    expect(evaluateConsent(result.record, policy, 1_600)).toEqual({
      issues: [],
      prompt: false,
      status: "withdrawn",
    });
    expect(result.record).not.toHaveProperty("erasedPastTransmission");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.record)).toBe(true);
  });

  it("is unchanged when every purpose is already denied", () => {
    const current = structuredClone(createRecord("reject-all"));
    const result = withdrawConsent(current, 1_500);

    expect(result).toEqual({
      ok: true,
      outcome: "unchanged",
      record: current,
    });
    if (!result.ok) throw new Error("valid withdrawal must be accepted");
    expect(result.record).not.toBe(current);
    expect(result.record.revision).toBe(1);
    expect(result.record.method).toBe("reject-all");
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.decisions)).toBe(true);
  });

  it("rejects an unsafe or pre-decision withdrawal time", () => {
    const current = createRecord("accept-all");

    for (const withdrawnAt of [
      Number.NaN,
      1_500.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(withdrawConsent(current, withdrawnAt)).toEqual({
        issues: [{ code: "invalid-withdrawal-time", path: "withdrawnAt" }],
        ok: false,
      });
    }
    expect(withdrawConsent(current, current.decidedAt - 1)).toEqual({
      issues: [{ code: "invalid-withdrawal-time", path: "withdrawnAt" }],
      ok: false,
    });
  });

  it.each([1_000.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe current decision timestamp: %s",
    (decidedAt) => {
      expect(
        withdrawConsent(
          { ...createRecord("accept-all"), decidedAt },
          Number.MAX_SAFE_INTEGER,
        ),
      ).toEqual({
        issues: [{ code: "invalid-current-record", path: "current.decidedAt" }],
        ok: false,
      });
    },
  );

  it.each([2_000.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe current expiry timestamp: %s",
    (expiresAt) => {
      expect(
        withdrawConsent({ ...createRecord("accept-all"), expiresAt }, 1_500),
      ).toEqual({
        issues: [{ code: "invalid-current-record", path: "current.expiresAt" }],
        ok: false,
      });
    },
  );

  it("rejects a current aggregate without a positive decision interval", () => {
    const current = createRecord("accept-all");

    expect(
      withdrawConsent({ ...current, expiresAt: current.decidedAt }, 1_500),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.expiresAt" }],
      ok: false,
    });
  });

  it.each([1_500.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe current withdrawal timestamp: %s",
    (withdrawnAt) => {
      expect(
        withdrawConsent(
          {
            ...createRecord("accept-all"),
            method: "withdrawal",
            withdrawnAt,
          },
          2_000,
        ),
      ).toEqual({
        issues: [
          { code: "invalid-current-record", path: "current.withdrawnAt" },
        ],
        ok: false,
      });
    },
  );

  it("rejects a withdrawal aggregate containing a grant", () => {
    const current = createRecord("accept-all");

    expect(
      withdrawConsent(
        {
          ...current,
          decisions: current.decisions.map((decision, index) => ({
            ...decision,
            value: index === 0 ? ("denied" as const) : decision.value,
          })),
          method: "withdrawal",
          withdrawnAt: 1_500,
        },
        1_600,
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.decisions" }],
      ok: false,
    });
  });

  it("rejects a repeated withdrawal before the current withdrawal time", () => {
    const current = {
      ...createRecord("reject-all"),
      method: "withdrawal" as const,
      revision: 2,
      withdrawnAt: 1_500,
    };

    expect(withdrawConsent(current, 1_499)).toEqual({
      issues: [{ code: "invalid-withdrawal-time", path: "withdrawnAt" }],
      ok: false,
    });
  });

  it.each([1_000, 1_500])(
    "accepts an idempotent withdrawal at the current transition time: %s",
    (withdrawnAt) => {
      const current = {
        ...createRecord("reject-all"),
        method: "withdrawal" as const,
        revision: 2,
        withdrawnAt,
      };

      expect(withdrawConsent(current, withdrawnAt)).toEqual({
        ok: true,
        outcome: "unchanged",
        record: current,
      });
    },
  );

  it("withdraws a mixed decision set when any grant remains", () => {
    const current = createRecord("accept-all");
    const result = withdrawConsent(
      {
        ...current,
        decisions: current.decisions.map((decision, index) => ({
          ...decision,
          value: index === 0 ? ("denied" as const) : decision.value,
        })),
      },
      1_500,
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "changed",
      record: {
        decisions: [
          { purposeId: "analytics", value: "denied" },
          { purposeId: "functional", value: "denied" },
          { purposeId: "marketing", value: "denied" },
        ],
      },
    });
  });

  it("does not delegate withdrawal projection to a caller-owned map", () => {
    const created = createRecord("accept-all");
    const decisions = created.decisions.map((decision) => ({ ...decision }));
    let mapCalls = 0;
    Object.defineProperty(decisions, "map", {
      value: () => {
        mapCalls += 1;
        return [...decisions];
      },
    });
    const current = { ...created, decisions } as ConsentRecord;

    let result: ReturnType<typeof withdrawConsent> | undefined;
    expect(() => {
      result = withdrawConsent(current, 1_500);
    }).not.toThrow();
    expect(result).toMatchObject({
      ok: true,
      outcome: "changed",
      record: {
        decisions: [
          { purposeId: "analytics", value: "denied" },
          { purposeId: "functional", value: "denied" },
          { purposeId: "marketing", value: "denied" },
        ],
        method: "withdrawal",
      },
    });
    expect(mapCalls).toBe(0);
  });

  it("rejects a forged current method without throwing", () => {
    expect(
      withdrawConsent(
        {
          ...createRecord("accept-all"),
          method: "forged",
        } as unknown as ConsentRecord,
        1_500,
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.method" }],
      ok: false,
    });
  });

  it.each([0, Number.NaN, Number.MAX_SAFE_INTEGER])(
    "rejects a current revision that cannot advance safely: %s",
    (revision) => {
      const current = {
        ...createRecord("accept-all"),
        revision,
      } satisfies ConsentRecord;

      expect(withdrawConsent(current, 1_500)).toEqual({
        issues: [{ code: "invalid-current-record", path: "current.revision" }],
        ok: false,
      });
    },
  );
});
