import { describe, expect, it } from "vitest";

import {
  applyEvidenceRetention,
  deleteEvidenceForConsent,
  emptyEvidenceLog,
  ingestReceipts,
  queryEvidence,
} from "./index.js";

function receipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    catalogueDigest: "sha256-catalogue",
    consentId: "visitor-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "sha256-surface",
    decisions: [{ decision: "granted", purposeId: "analytics" }],
    idempotencyKey: "key-1",
    method: "accept-all",
    occurredAt: 1_000,
    persistenceStatus: "confirmed",
    policyVersion: "1.0.0",
    revision: 1,
    schemaVersion: 2,
    transitionId: "transition-1",
    ...overrides,
  };
}

describe("durable consent evidence", () => {
  it("ingests valid receipts", () => {
    const result = ingestReceipts(emptyEvidenceLog(), [receipt()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.log.receipts).toHaveLength(1);
    expect(result.ingested).toBe(1);
  });

  it("refuses the whole batch when any receipt is malformed", () => {
    const result = ingestReceipts(emptyEvidenceLog(), [
      receipt(),
      receipt({ idempotencyKey: "key-2", schemaVersion: 1 }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const issue = result.issue;
    expect(issue.kind).toBe("malformed-receipt");
    if (issue.kind !== "malformed-receipt") return;
    expect(issue.index).toBe(1);
  });

  it("rejects a receipt carrying an unknown field", () => {
    const result = ingestReceipts(emptyEvidenceLog(), [
      receipt({ smuggled: "value" }),
    ]);
    expect(result.ok).toBe(false);
  });

  it("skips an exact duplicate instead of storing it twice", () => {
    const first = ingestReceipts(emptyEvidenceLog(), [receipt()]);
    if (!first.ok) throw new Error("fixture must ingest");
    const again = ingestReceipts(first.log, [receipt()]);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.log.receipts).toHaveLength(1);
    expect(again.duplicates).toBe(1);
    expect(again.ingested).toBe(0);
  });

  it("refuses a reused idempotency key with different content", () => {
    const first = ingestReceipts(emptyEvidenceLog(), [receipt()]);
    if (!first.ok) throw new Error("fixture must ingest");
    const conflicting = ingestReceipts(first.log, [
      receipt({ method: "reject-all" }),
    ]);
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.issue.kind).toBe("idempotency-conflict");
  });

  it("queries by consent id and time range", () => {
    const seeded = ingestReceipts(emptyEvidenceLog(), [
      receipt(),
      receipt({
        decidedAt: 5_000,
        idempotencyKey: "key-2",
        occurredAt: 5_000,
        transitionId: "t-2",
      }),
      receipt({
        consentId: "visitor-2",
        idempotencyKey: "key-3",
        transitionId: "t-3",
      }),
    ]);
    if (!seeded.ok) throw new Error("fixture must ingest");

    expect(queryEvidence(seeded.log, { consentId: "visitor-1" })).toHaveLength(
      2,
    );
    expect(queryEvidence(seeded.log, { since: 2_000 })).toHaveLength(1);
    expect(queryEvidence(seeded.log, { until: 2_000 })).toHaveLength(2);
  });

  it("deletes one visitor's evidence and reports how much", () => {
    const seeded = ingestReceipts(emptyEvidenceLog(), [
      receipt(),
      receipt({
        consentId: "visitor-2",
        idempotencyKey: "key-2",
        transitionId: "t-2",
      }),
    ]);
    if (!seeded.ok) throw new Error("fixture must ingest");

    const erased = deleteEvidenceForConsent(seeded.log, "visitor-1");
    expect(erased.deleted).toBe(1);
    expect(queryEvidence(erased.log, { consentId: "visitor-1" })).toHaveLength(
      0,
    );
    expect(queryEvidence(erased.log, { consentId: "visitor-2" })).toHaveLength(
      1,
    );

    expect(deleteEvidenceForConsent(erased.log, "nobody").deleted).toBe(0);
  });

  it("applies retention without touching anything at or after the cutoff", () => {
    const seeded = ingestReceipts(emptyEvidenceLog(), [
      receipt({ decidedAt: 1_000, occurredAt: 1_000 }),
      receipt({
        decidedAt: 3_000,
        idempotencyKey: "key-2",
        occurredAt: 3_000,
        transitionId: "t-2",
      }),
      receipt({
        decidedAt: 5_000,
        idempotencyKey: "key-3",
        occurredAt: 5_000,
        transitionId: "t-3",
      }),
    ]);
    if (!seeded.ok) throw new Error("fixture must ingest");

    const kept = applyEvidenceRetention(seeded.log, 3_000);
    expect(kept.removed).toBe(1);
    expect(kept.log.receipts.map(({ decidedAt }) => decidedAt)).toEqual([
      3_000, 5_000,
    ]);
  });

  // Every one of these is a receipt the runtime never produces. Evidence that
  // cannot be trusted is refused whole rather than stored and reasoned about
  // later, so each rule gets its own case.
  it.each([
    ["a receipt that is not an object", 42],
    ["a receipt that is a list", []],
    ["a blank catalogue digest", receipt({ catalogueDigest: "  " })],
    [
      "a missing decision surface digest",
      receipt({ decisionSurfaceDigest: undefined }),
    ],
    ["a blank idempotency key", receipt({ idempotencyKey: "" })],
    ["a policy version that is not text", receipt({ policyVersion: 1 })],
    ["a blank transition id", receipt({ transitionId: " " })],
    ["a decision time that is not whole", receipt({ decidedAt: 1.5 })],
    ["a decision time before the epoch", receipt({ decidedAt: -1 })],
    ["an occurrence time that is not a number", receipt({ occurredAt: "now" })],
    ["a negative revision", receipt({ revision: -2 })],
    ["a method nothing produces", receipt({ method: "telepathy" })],
    [
      "a persistence status nothing reports",
      receipt({ persistenceStatus: "maybe" }),
    ],
    ["a consent id that is present but blank", receipt({ consentId: "   " })],
    ["a locale that is present but blank", receipt({ locale: "" })],
    ["decisions that are not a list", receipt({ decisions: {} })],
    ["a decision that is not an object", receipt({ decisions: [7] })],
    [
      "a decision carrying an extra field",
      receipt({
        decisions: [{ decision: "granted", note: "x", purposeId: "analytics" }],
      }),
    ],
    [
      "a decision missing its purpose",
      receipt({ decisions: [{ decision: "granted" }] }),
    ],
    [
      "a decision nothing supports",
      receipt({ decisions: [{ decision: "perhaps", purposeId: "analytics" }] }),
    ],
  ])("refuses %s", (_label, candidate) => {
    const result = ingestReceipts(emptyEvidenceLog(), [candidate]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("malformed-receipt");
  });

  it("accepts a receipt that leaves out the optional consent id and locale", () => {
    const result = ingestReceipts(emptyEvidenceLog(), [
      receipt({ consentId: undefined, locale: undefined }),
    ]);

    expect(result.ok).toBe(true);
  });

  // A receipt is the same receipt however its fields are ordered, so an exact
  // repeat with keys written in another order is still a duplicate.
  it("counts a repeat written in a different field order as a duplicate", () => {
    const first = ingestReceipts(emptyEvidenceLog(), [receipt()]);
    if (!first.ok) throw new Error("fixture must ingest");
    const reordered = Object.fromEntries(
      Object.entries(receipt()).reverse(),
    ) as Record<string, unknown>;

    const again = ingestReceipts(first.log, [reordered]);

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.duplicates).toBe(1);
    expect(again.log.receipts).toHaveLength(1);
  });

  it("includes a receipt decided exactly on each bound of a query", () => {
    const ingested = ingestReceipts(emptyEvidenceLog(), [
      receipt({ decidedAt: 100, idempotencyKey: "a", transitionId: "t-a" }),
      receipt({ decidedAt: 200, idempotencyKey: "b", transitionId: "t-b" }),
      receipt({ decidedAt: 300, idempotencyKey: "c", transitionId: "t-c" }),
    ]);
    if (!ingested.ok) throw new Error("fixture must ingest");

    const inRange = queryEvidence(ingested.log, { since: 100, until: 300 });
    const narrower = queryEvidence(ingested.log, { since: 101, until: 299 });

    expect(inRange).toHaveLength(3);
    expect(narrower.map(({ decidedAt }) => decidedAt)).toEqual([200]);
  });
});
