import { describe, expect, it } from "vitest";

import {
  createConsentEventBatch,
  recordConsentDecision,
  withdrawConsent,
  type ConsentPolicyInput,
  type ConsentRecord,
} from "./index.js";

const policy = Object.freeze({
  catalogueDigest: "catalogue-v1",
  decisionSurfaceDigest: "surface-v1",
  optionalPurposeIds: Object.freeze(["marketing", "analytics"]),
  policyVersion: "policy-v1",
}) satisfies ConsentPolicyInput;

type NonWithdrawalConsentRecord = ConsentRecord & {
  readonly method: Exclude<ConsentRecord["method"], "withdrawal">;
  readonly withdrawnAt?: never;
};

function firstDecision(
  method: "accept-all" | "reject-all",
): NonWithdrawalConsentRecord {
  const result = recordConsentDecision(undefined, policy, {
    decidedAt: 1_000,
    expiresAt: 2_000,
    method,
    recordId: "record-1",
  });
  if (!result.ok || result.outcome !== "changed") {
    throw new Error("fixture must create a record");
  }
  if (result.record.method === "withdrawal") {
    throw new Error("fixture must not create a withdrawal");
  }
  return result.record;
}

describe("createConsentEventBatch", () => {
  it("emits exactly record-created then consent-granted for first accept", () => {
    const record = firstDecision("accept-all");
    const events = createConsentEventBatch({
      committed: true,
      previousRecord: null,
      record,
    });

    expect(events).toEqual([
      {
        occurredAt: 1_000,
        policy: {
          catalogueDigest: "catalogue-v1",
          decisionSurfaceDigest: "surface-v1",
          policyVersion: "policy-v1",
        },
        recordId: "record-1",
        revision: 1,
        type: "ConsentRecordCreated",
      },
      {
        changes: [
          { from: "unresolved", purposeId: "analytics", to: "granted" },
          { from: "unresolved", purposeId: "marketing", to: "granted" },
        ],
        occurredAt: 1_000,
        policy: {
          catalogueDigest: "catalogue-v1",
          decisionSurfaceDigest: "surface-v1",
          policyVersion: "policy-v1",
        },
        recordId: "record-1",
        revision: 1,
        type: "ConsentGranted",
      },
    ]);
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.policy)).toBe(true);
    expect(Object.isFrozen(events[1])).toBe(true);
    if (events[1]?.type !== "ConsentGranted") {
      throw new Error("second event must describe the grant");
    }
    expect(Object.isFrozen(events[1].changes)).toBe(true);
    expect(Object.isFrozen(events[1].changes[0])).toBe(true);
  });

  it("emits record-created then consent-denied for first reject", () => {
    const record = firstDecision("reject-all");

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: null,
        record,
      }).map(({ type }) => type),
    ).toEqual(["ConsentRecordCreated", "ConsentDenied"]);
  });

  it("does not delegate event classification to a caller-owned some", () => {
    const created = firstDecision("accept-all");
    const decisions = created.decisions.map((decision) => ({ ...decision }));
    let someCalls = 0;
    Object.defineProperty(decisions, "some", {
      value: () => {
        someCalls += 1;
        return false;
      },
    });

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: null,
        record: { ...created, decisions },
      }),
    ).toMatchObject([
      { type: "ConsentRecordCreated" },
      {
        changes: [
          { from: "unresolved", purposeId: "analytics", to: "granted" },
          { from: "unresolved", purposeId: "marketing", to: "granted" },
        ],
        type: "ConsentGranted",
      },
    ]);
    expect(someCalls).toBe(0);
  });

  it("emits one changed event for a later decision revision", () => {
    const previousRecord = firstDecision("accept-all");
    const result = recordConsentDecision(previousRecord, policy, {
      decidedAt: 1_500,
      expiresAt: 2_500,
      grantedPurposeIds: ["analytics"],
      method: "granular",
    });
    if (!result.ok || result.outcome !== "changed") {
      throw new Error("fixture decision must change");
    }

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: result.record,
      }),
    ).toEqual([
      {
        changes: [{ from: "granted", purposeId: "marketing", to: "denied" }],
        occurredAt: 1_500,
        policy: {
          catalogueDigest: "catalogue-v1",
          decisionSurfaceDigest: "surface-v1",
          policyVersion: "policy-v1",
        },
        recordId: "record-1",
        revision: 2,
        type: "ConsentChanged",
      },
    ]);
  });

  it("emits one withdrawal event for the withdrawal revision", () => {
    const previousRecord = firstDecision("accept-all");
    const result = withdrawConsent(previousRecord, 1_500);
    if (!result.ok || result.outcome !== "changed") {
      throw new Error("fixture withdrawal must change");
    }

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: result.record,
      }),
    ).toEqual([
      {
        changes: [
          { from: "granted", purposeId: "analytics", to: "denied" },
          { from: "granted", purposeId: "marketing", to: "denied" },
        ],
        occurredAt: 1_500,
        policy: {
          catalogueDigest: "catalogue-v1",
          decisionSurfaceDigest: "surface-v1",
          policyVersion: "policy-v1",
        },
        recordId: "record-1",
        revision: 2,
        type: "ConsentWithdrawn",
      },
    ]);
  });

  it("emits no committed events for an unconfirmed grant", () => {
    const record = firstDecision("accept-all");

    expect(
      createConsentEventBatch({
        committed: false,
        previousRecord: null,
        record,
      }),
    ).toEqual([]);
  });

  it("emits nothing when a committed transition has no decision change", () => {
    const record = firstDecision("accept-all");

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: record,
        record,
      }),
    ).toEqual([]);
  });

  it("rejects unrelated, skipped, and non-initial aggregate revisions", () => {
    const previousRecord = firstDecision("accept-all");
    const nextRecord = {
      ...previousRecord,
      decidedAt: 1_500,
      decisions: previousRecord.decisions.map((decision) => ({
        ...decision,
        value:
          decision.purposeId === "marketing"
            ? ("denied" as const)
            : decision.value,
      })),
      method: "granular" as const,
      revision: 2,
    } satisfies ConsentRecord;

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: { ...nextRecord, recordId: "record-2" },
      }),
    ).toEqual([]);
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: { ...nextRecord, revision: 3 },
      }),
    ).toEqual([]);
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: null,
        record: nextRecord,
      }),
    ).toEqual([]);

    const unsafeRevision = Number.MAX_SAFE_INTEGER + 1;
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: { ...previousRecord, revision: unsafeRevision },
        record: { ...nextRecord, revision: unsafeRevision },
      }),
    ).toEqual([]);
  });

  it("rejects non-finite and chronologically reversed event revisions", () => {
    const previousRecord = firstDecision("accept-all");
    const backdatedRecord = {
      ...previousRecord,
      decidedAt: previousRecord.decidedAt - 1,
      decisions: previousRecord.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      method: "reject-all" as const,
      revision: 2,
    } satisfies ConsentRecord;

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: backdatedRecord,
      }),
    ).toEqual([]);
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: { ...backdatedRecord, decidedAt: Number.NaN },
      }),
    ).toEqual([]);
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: {
          ...backdatedRecord,
          decidedAt: 1_500,
          withdrawnAt: 1_250,
        } as unknown as ConsentRecord,
      }),
    ).toEqual([]);

    const withdrawal = withdrawConsent(previousRecord, 1_500);
    if (!withdrawal.ok || withdrawal.outcome !== "changed") {
      throw new Error("fixture withdrawal must change");
    }
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: withdrawal.record,
        record: {
          ...backdatedRecord,
          decidedAt: 1_499,
          revision: 3,
        },
      }),
    ).toEqual([]);
  });

  it("rejects unsafe-integer decision and withdrawal event times", () => {
    const initial = firstDecision("accept-all");
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: null,
        record: { ...initial, decidedAt: 1_000.5 },
      }),
    ).toEqual([]);

    const withdrawal = withdrawConsent(initial, 1_500);
    if (!withdrawal.ok || withdrawal.outcome !== "changed") {
      throw new Error("fixture withdrawal must change");
    }
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: initial,
        record: {
          ...withdrawal.record,
          withdrawnAt: 1_500.5,
        } as ConsentRecord,
      }),
    ).toEqual([]);
  });

  it("rejects an event aggregate without a positive decision interval", () => {
    const record = firstDecision("accept-all");

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: null,
        record: { ...record, expiresAt: record.decidedAt },
      }),
    ).toEqual([]);
  });

  it("emits a complete batch for policy-only and purpose-removal revisions", () => {
    const previousRecord = firstDecision("accept-all");
    const policyOnlyRecord = {
      ...previousRecord,
      decidedAt: 1_500,
      policy: {
        catalogueDigest: "catalogue-v2",
        decisionSurfaceDigest: "surface-v2",
        policyVersion: "policy-v2",
      },
      revision: 2,
    } satisfies ConsentRecord;

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: policyOnlyRecord,
      }),
    ).toEqual([
      {
        changes: [],
        occurredAt: 1_500,
        policy: policyOnlyRecord.policy,
        recordId: "record-1",
        revision: 2,
        type: "ConsentChanged",
      },
    ]);

    const purposeRemovalRecord = {
      ...previousRecord,
      decidedAt: 1_500,
      decisions: previousRecord.decisions.filter(
        ({ purposeId }) => purposeId !== "marketing",
      ),
      method: "granular" as const,
      revision: 2,
    } satisfies ConsentRecord;
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: purposeRemovalRecord,
      }),
    ).toEqual([
      {
        changes: [
          { from: "granted", purposeId: "marketing", to: "unresolved" },
        ],
        occurredAt: 1_500,
        policy: previousRecord.policy,
        recordId: "record-1",
        revision: 2,
        type: "ConsentChanged",
      },
    ]);
  });

  it("rejects a withdrawal event without an exact withdrawal timestamp", () => {
    const previousRecord = firstDecision("accept-all");
    const record = {
      ...previousRecord,
      decisions: previousRecord.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      method: "withdrawal" as const,
      revision: 2,
    } as unknown as ConsentRecord;

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record,
      }),
    ).toEqual([]);
  });

  it("rejects a withdrawal event that introduces or preserves a grant", () => {
    const previousRecord = firstDecision("reject-all");
    const contradictory = {
      ...previousRecord,
      decisions: previousRecord.decisions.map(({ purposeId }, index) => ({
        purposeId,
        value: index === 0 ? ("granted" as const) : ("denied" as const),
      })),
      method: "withdrawal" as const,
      revision: 2,
      withdrawnAt: 1_500,
    } satisfies ConsentRecord;

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: contradictory,
      }),
    ).toEqual([]);
  });

  it("rejects malformed current and previous aggregates without throwing", () => {
    const previousRecord = firstDecision("accept-all");
    const record = {
      ...previousRecord,
      decidedAt: 1_500,
      decisions: previousRecord.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      method: "reject-all" as const,
      revision: 2,
    };

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord: {
          ...previousRecord,
          decisions: null,
        } as unknown as ConsentRecord,
        record,
      }),
    ).toEqual([]);
    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record: {
          ...record,
          decisions: [{ purposeId: "analytics", value: "forged" }],
        } as unknown as ConsentRecord,
      }),
    ).toEqual([]);
  });

  it("emits the final structurally valid safe-integer revision", () => {
    const previousRecord = {
      ...firstDecision("accept-all"),
      revision: Number.MAX_SAFE_INTEGER - 1,
    };
    const record = {
      ...previousRecord,
      decidedAt: 1_500,
      decisions: previousRecord.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      expiresAt: 2_500,
      method: "reject-all" as const,
      revision: Number.MAX_SAFE_INTEGER,
    };

    expect(
      createConsentEventBatch({
        committed: true,
        previousRecord,
        record,
      }),
    ).toMatchObject([
      {
        occurredAt: 1_500,
        revision: Number.MAX_SAFE_INTEGER,
        type: "ConsentChanged",
      },
    ]);
  });
});
