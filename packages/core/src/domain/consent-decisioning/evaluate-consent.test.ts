import { describe, expect, it } from "vitest";

import {
  evaluateConsent,
  type ConsentPolicyInput,
  type ConsentRecord,
} from "./index.js";

const policy = Object.freeze({
  catalogueDigest: "catalogue-v1",
  decisionSurfaceDigest: "surface-v1",
  optionalPurposeIds: Object.freeze(["analytics", "functional"]),
  policyVersion: "policy-v1",
}) satisfies ConsentPolicyInput;

const record = Object.freeze({
  decidedAt: 1_000,
  decisions: Object.freeze([
    Object.freeze({ purposeId: "functional", value: "denied" as const }),
    Object.freeze({ purposeId: "analytics", value: "granted" as const }),
  ]),
  expiresAt: 2_000,
  method: "granular" as const,
  policy: Object.freeze({
    catalogueDigest: "catalogue-v1",
    decisionSurfaceDigest: "surface-v1",
    policyVersion: "policy-v1",
  }),
  recordId: "record-1",
  revision: 1,
  schemaVersion: 1 as const,
}) satisfies ConsentRecord;

describe("evaluateConsent", () => {
  it("is active one millisecond before expiry and expired at the boundary", () => {
    expect(evaluateConsent(record, policy, 1_999)).toEqual({
      issues: [],
      prompt: false,
      status: "active",
    });
    expect(evaluateConsent(record, policy, 2_000)).toEqual({
      issues: [],
      prompt: true,
      status: "expired",
    });
  });

  it("treats a missing record as first visit", () => {
    expect(evaluateConsent(undefined, policy, 1_500)).toEqual({
      issues: [],
      prompt: true,
      status: "first-visit",
    });
    expect(evaluateConsent(undefined, policy, 1_500.5)).toEqual({
      issues: [{ code: "invalid-timestamp", path: "now" }],
      prompt: true,
      status: "invalid",
    });
  });

  it("invalidates future decisions and non-positive validity intervals", () => {
    expect(evaluateConsent(record, policy, 999)).toEqual({
      issues: [{ code: "decision-in-future", path: "decidedAt" }],
      prompt: true,
      status: "invalid",
    });
    expect(
      evaluateConsent(
        { ...record, expiresAt: record.decidedAt },
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [{ code: "invalid-decision-interval", path: "expiresAt" }],
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed on non-finite record and evaluation timestamps", () => {
    expect(
      evaluateConsent({ ...record, expiresAt: Number.NaN }, policy, 1_500),
    ).toEqual({
      issues: [{ code: "invalid-timestamp", path: "expiresAt" }],
      prompt: true,
      status: "invalid",
    });
    expect(evaluateConsent(record, policy, Number.NaN)).toEqual({
      issues: [{ code: "invalid-timestamp", path: "now" }],
      prompt: true,
      status: "invalid",
    });
  });

  it.each([
    ["now", 1_500.5],
    ["now", Number.MAX_SAFE_INTEGER + 1],
    ["decidedAt", 1_000.5],
    ["decidedAt", Number.MAX_SAFE_INTEGER + 1],
    ["expiresAt", 2_000.5],
    ["expiresAt", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("fails closed on an unsafe %s timestamp: %s", (path, value) => {
    expect(
      evaluateConsent(
        path === "now" ? record : { ...record, [path]: value },
        policy,
        path === "now" ? value : 1_500,
      ),
    ).toEqual({
      issues: [{ code: "invalid-timestamp", path }],
      prompt: true,
      status: "invalid",
    });
  });

  it("invalidates future schemas and incomplete or unknown purpose sets", () => {
    const futureSchema = {
      ...record,
      schemaVersion: 2,
    } as unknown as ConsentRecord;
    expect(evaluateConsent(futureSchema, policy, 1_500)).toEqual({
      issues: [{ code: "unsupported-schema-version", path: "schemaVersion" }],
      prompt: true,
      status: "invalid",
    });

    expect(
      evaluateConsent(
        {
          ...record,
          decisions: [
            { purposeId: "functional", value: "denied" },
            { purposeId: "unknown", value: "granted" },
          ],
        },
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [
        {
          code: "unknown-purpose-id",
          path: "decisions[1].purposeId",
          purposeId: "unknown",
        },
        {
          code: "missing-purpose-decision",
          path: "decisions",
          purposeId: "analytics",
        },
      ],
      prompt: true,
      status: "invalid",
    });
  });

  it("rejects malformed aggregate identity and provenance fields", () => {
    const malformed = {
      ...record,
      method: "bogus",
      recordId: "",
      revision: -1,
    } as unknown as ConsentRecord;

    expect(evaluateConsent(malformed, policy, 1_500)).toEqual({
      issues: [
        { code: "invalid-record-id", path: "recordId" },
        { code: "invalid-record-revision", path: "revision" },
        { code: "invalid-decision-method", path: "method" },
      ],
      prompt: true,
      status: "invalid",
    });

    expect(
      evaluateConsent({ ...record, recordId: "   " }, policy, 1_500),
    ).toEqual({
      issues: [{ code: "invalid-record-id", path: "recordId" }],
      prompt: true,
      status: "invalid",
    });
  });

  it("rejects revisions that cannot remain monotonic in JSON numbers", () => {
    expect(
      evaluateConsent(
        { ...record, revision: Number.MAX_SAFE_INTEGER + 1 },
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [{ code: "invalid-record-revision", path: "revision" }],
      prompt: true,
      status: "invalid",
    });
  });

  it("rejects duplicate and malformed purpose decisions", () => {
    expect(
      evaluateConsent(
        {
          ...record,
          decisions: [
            { purposeId: "analytics", value: "granted" },
            { purposeId: "analytics", value: "denied" },
            { purposeId: "functional", value: "denied" },
          ],
        },
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [
        {
          code: "duplicate-purpose-decision",
          path: "decisions[1].purposeId",
          purposeId: "analytics",
        },
      ],
      prompt: true,
      status: "invalid",
    });

    const malformed = {
      ...record,
      decisions: [
        { purposeId: "analytics", value: "bogus" },
        { purposeId: "functional", value: "denied" },
      ],
    } as unknown as ConsentRecord;
    expect(evaluateConsent(malformed, policy, 1_500)).toEqual({
      issues: [
        {
          code: "invalid-decision-value",
          path: "decisions[0].value",
        },
      ],
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed when the persisted decision set is not an array", () => {
    const malformed = {
      ...record,
      decisions: undefined,
    } as unknown as ConsentRecord;

    expect(evaluateConsent(malformed, policy, 1_500)).toEqual({
      issues: [{ code: "invalid-decision-set", path: "decisions" }],
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed when a persisted decision entry is null", () => {
    const malformed = {
      ...record,
      decisions: [null],
    } as unknown as ConsentRecord;

    expect(evaluateConsent(malformed, policy, 1_500)).toEqual({
      issues: [
        { code: "invalid-decision-set", path: "decisions[0]" },
        {
          code: "missing-purpose-decision",
          path: "decisions",
          purposeId: "analytics",
        },
        {
          code: "missing-purpose-decision",
          path: "decisions",
          purposeId: "functional",
        },
      ],
      prompt: true,
      status: "invalid",
    });
  });

  it.each(["decisionSurfaceDigest", "policyVersion"] as const)(
    "invalidates a mismatched policy %s",
    (field) => {
      expect(
        evaluateConsent(
          {
            ...record,
            policy: { ...record.policy, [field]: `wrong-${field}` },
          },
          policy,
          1_500,
        ),
      ).toEqual({
        issues: [
          {
            code: "policy-identity-mismatch",
            path: `policy.${field}`,
          },
        ],
        prompt: true,
        status: "invalid",
      });
    },
  );

  it("keeps consent active across an editorial-only catalogue revision", () => {
    expect(
      evaluateConsent(
        record,
        { ...policy, catalogueDigest: "catalogue-editorial-v2" },
        1_500,
      ),
    ).toEqual({
      issues: [],
      prompt: false,
      status: "active",
    });
  });

  it("returns a deeply frozen result without changing the record", () => {
    const before = structuredClone(record);
    const result = evaluateConsent(record, policy, 1_500);

    expect(record).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.issues)).toBe(true);
  });

  it("requires a finite, temporally valid withdrawal timestamp", () => {
    const missingTimestamp = {
      ...record,
      decisions: record.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      method: "withdrawal",
    } as unknown as ConsentRecord;
    expect(evaluateConsent(missingTimestamp, policy, 1_500)).toEqual({
      issues: [{ code: "missing-withdrawal-timestamp", path: "withdrawnAt" }],
      prompt: true,
      status: "invalid",
    });
    expect(
      evaluateConsent(
        {
          ...missingTimestamp,
          withdrawnAt: Number.NaN,
        } as unknown as ConsentRecord,
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [{ code: "invalid-timestamp", path: "withdrawnAt" }],
      prompt: true,
      status: "invalid",
    });
    expect(
      evaluateConsent(
        {
          ...missingTimestamp,
          withdrawnAt: record.decidedAt - 1,
        } as unknown as ConsentRecord,
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [{ code: "invalid-withdrawal-time", path: "withdrawnAt" }],
      prompt: true,
      status: "invalid",
    });
  });

  it.each([1_250.5, Number.MAX_SAFE_INTEGER + 1])(
    "fails closed on an unsafe withdrawal timestamp: %s",
    (withdrawnAt) => {
      expect(
        evaluateConsent(
          {
            ...record,
            decisions: record.decisions.map(({ purposeId }) => ({
              purposeId,
              value: "denied" as const,
            })),
            method: "withdrawal",
            withdrawnAt,
          },
          policy,
          1_500,
        ),
      ).toEqual({
        issues: [{ code: "invalid-timestamp", path: "withdrawnAt" }],
        prompt: true,
        status: "invalid",
      });
    },
  );

  it("rejects a withdrawal record that still contains a grant", () => {
    expect(
      evaluateConsent(
        {
          ...record,
          method: "withdrawal",
          withdrawnAt: 1_500,
        },
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [{ code: "withdrawal-has-grant", path: "decisions" }],
      prompt: true,
      status: "invalid",
    });
  });

  it("rejects a withdrawal timestamp on a non-withdrawal record", () => {
    expect(
      evaluateConsent(
        { ...record, withdrawnAt: 1_250 } as unknown as ConsentRecord,
        policy,
        1_500,
      ),
    ).toEqual({
      issues: [
        { code: "unexpected-withdrawal-timestamp", path: "withdrawnAt" },
      ],
      prompt: true,
      status: "invalid",
    });
  });
});
