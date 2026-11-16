import { describe, expect, it } from "vitest";

import {
  toConsentRecord,
  toPersistedDecisionRecord,
  type PersistedDecisionRecord,
} from "../../application.js";
import {
  CONSENT_RECORD_SCHEMA_VERSION,
  type ConsentRecord,
} from "../../domain.js";
import {
  decodeDecisionRecordEnvelope,
  encodeDecisionRecordEnvelope,
} from "./decision-record-codec.js";

const identity = {
  catalogueDigest: "catalogue-1",
  decisionSurfaceDigest: "surface-1",
  policyVersion: "policy-1",
} as const;

function record(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    consentId: "consent-1",
    decidedAt: 1_000,
    decisions: [
      { purposeId: "ads", value: "denied" },
      { purposeId: "analytics", value: "granted" },
    ],
    expiresAt: 2_000,
    locale: "en-GB",
    method: "granular",
    policy: identity,
    recordId: "record-1",
    revision: 2,
    schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
    ...overrides,
  } as ConsentRecord;
}

function recordEnvelope(record: PersistedDecisionRecord): string {
  return JSON.stringify({ record, schemaVersion: 1 });
}

describe("persisted consent record codec", () => {
  it.each([
    ["active", record()],
    ["expired", record({ decidedAt: 500, expiresAt: 900 })],
    ["imported", record({ method: "imported" })],
    [
      "withdrawn",
      record({
        decidedAt: 1_500,
        decisions: [
          { purposeId: "ads", value: "denied" },
          { purposeId: "analytics", value: "denied" },
        ],
        expiresAt: 2_500,
        method: "withdrawal",
        withdrawnAt: 1_500,
      }),
    ],
  ])("round-trips a complete %s aggregate", (_name, aggregate) => {
    const persisted = toPersistedDecisionRecord(aggregate);
    const raw = encodeDecisionRecordEnvelope({ record: persisted }, 1);
    const decoded = decodeDecisionRecordEnvelope(raw, 1);

    expect(decoded).toEqual({ state: { record: persisted }, status: "stored" });
    if (decoded.status !== "stored" || decoded.state.record === undefined) {
      throw new Error("fixture must decode an active record");
    }
    expect(toConsentRecord(decoded.state.record)).toEqual(aggregate);
  });

  it.each([
    ["decidedAt", 1_000.5],
    ["decidedAt", Number.MAX_SAFE_INTEGER + 1],
    ["expiresAt", 2_000.5],
    ["expiresAt", Number.MAX_SAFE_INTEGER + 1],
  ] as const)(
    "rejects an unsafe persisted %s timestamp: %s",
    (field, value) => {
      const persisted = toPersistedDecisionRecord(record());
      const raw = recordEnvelope({ ...persisted, [field]: value });

      expect(decodeDecisionRecordEnvelope(raw, 1)).toEqual({
        reason: "invalid-record",
        status: "invalid",
      });
    },
  );

  it("rejects a persisted record without a positive decision interval", () => {
    const persisted = toPersistedDecisionRecord(
      record({ decidedAt: 1_000, expiresAt: 1_000 }),
    );

    expect(decodeDecisionRecordEnvelope(recordEnvelope(persisted), 1)).toEqual({
      reason: "invalid-record",
      status: "invalid",
    });
  });

  it.each([1_500.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe persisted withdrawal timestamp: %s",
    (withdrawnAt) => {
      const persisted = toPersistedDecisionRecord(
        record({
          decisions: [
            { purposeId: "ads", value: "denied" },
            { purposeId: "analytics", value: "denied" },
          ],
          method: "withdrawal",
          withdrawnAt,
        }),
      );
      const raw = recordEnvelope(persisted);

      expect(decodeDecisionRecordEnvelope(raw, 1)).toEqual({
        reason: "invalid-record",
        status: "invalid",
      });
    },
  );

  it("rejects a persisted withdrawal record containing a grant", () => {
    const persisted = toPersistedDecisionRecord(
      record({ method: "withdrawal", withdrawnAt: 1_500 }),
    );

    expect(decodeDecisionRecordEnvelope(recordEnvelope(persisted), 1)).toEqual({
      reason: "invalid-record",
      status: "invalid",
    });
  });

  it.each([
    ["catalogueDigest", ""],
    ["catalogueDigest", "   "],
    ["decisionSurfaceDigest", ""],
    ["decisionSurfaceDigest", "   "],
  ] as const)("preserves a historical blank %s", (field, value) => {
    const persisted = {
      ...toPersistedDecisionRecord(record()),
      [field]: value,
    };

    expect(
      decodeDecisionRecordEnvelope(
        encodeDecisionRecordEnvelope({ record: persisted }, 1),
        1,
      ),
    ).toEqual({ state: { record: persisted }, status: "stored" });
  });

  it("decodes a hostile __proto__ decision key without changing prototypes", () => {
    const persisted = toPersistedDecisionRecord(record());
    const raw = JSON.stringify({
      record: {
        ...persisted,
        decisions: JSON.parse('{"__proto__":"denied"}') as Record<
          string,
          "denied"
        >,
      },
      schemaVersion: 1,
    });
    const decoded = decodeDecisionRecordEnvelope(raw, 1);

    expect(decoded.status).toBe("stored");
    if (decoded.status !== "stored" || decoded.state.record === undefined) {
      throw new Error("fixture must decode an active record");
    }
    expect(Object.getPrototypeOf(decoded.state.record.decisions)).toBeNull();
    expect(Object.hasOwn(decoded.state.record.decisions, "__proto__")).toBe(
      true,
    );
    expect(decoded.state.record.decisions["__proto__"]).toBe("denied");
  });

  it("rejects additional envelope keys", () => {
    const persisted = toPersistedDecisionRecord(record());
    const raw = JSON.stringify({
      record: persisted,
      schemaVersion: 1,
      unexpected: true,
    });

    expect(decodeDecisionRecordEnvelope(raw, 1)).toEqual({
      reason: "invalid-record",
      status: "invalid",
    });
  });
});
