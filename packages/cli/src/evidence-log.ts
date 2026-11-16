import type { ConsentReceipt } from "@opencookie-dev/core";

/** Operator-held consent receipts, in ingestion order. @public */
export interface EvidenceLog {
  readonly receipts: readonly ConsentReceipt[];
}

/** A receipt in an ingested batch failed validation. @public */
export interface MalformedReceiptIssue {
  readonly index: number;
  readonly kind: "malformed-receipt";
}

/**
 * An idempotency key was reused for a receipt with different content.
 *
 * Evidence is never overwritten: the stored receipt stays and the batch is
 * refused, because two different records under one key means one of them is
 * wrong and the store cannot tell which.
 *
 * @public
 */
export interface IdempotencyConflictIssue {
  readonly idempotencyKey: string;
  readonly kind: "idempotency-conflict";
}

/** @public */
export type EvidenceIngestIssue =
  IdempotencyConflictIssue | MalformedReceiptIssue;

/** @public */
export type EvidenceIngestResult =
  | { readonly issue: EvidenceIngestIssue; readonly ok: false }
  | {
      readonly duplicates: number;
      readonly ingested: number;
      readonly log: EvidenceLog;
      readonly ok: true;
    };

/** Filters for reading stored evidence. Bounds are inclusive. @public */
export interface EvidenceQuery {
  readonly consentId?: string;
  readonly since?: number;
  readonly until?: number;
}

const METHODS = new Set([
  "accept-all",
  "granular",
  "imported",
  "reject-all",
  "withdrawal",
]);
const STATUSES = new Set(["confirmed", "failed", "failed-conservative"]);
const DECISIONS = new Set(["denied", "granted"]);
const REQUIRED_STRINGS = [
  "catalogueDigest",
  "decisionSurfaceDigest",
  "idempotencyKey",
  "policyVersion",
  "transitionId",
] as const;
const REQUIRED_INTEGERS = ["decidedAt", "occurredAt", "revision"] as const;
const KNOWN_KEYS = new Set([
  ...REQUIRED_STRINGS,
  ...REQUIRED_INTEGERS,
  "consentId",
  "decisions",
  "locale",
  "method",
  "persistenceStatus",
  "schemaVersion",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Accepts only a receipt in the exact shape the runtime emits.
 *
 * Unknown keys are refused rather than ignored, so nothing can be stored
 * alongside a receipt as if it were part of the evidence.
 */
function isReceipt(value: unknown): value is ConsentReceipt {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !KNOWN_KEYS.has(key))) return false;
  if (value["schemaVersion"] !== 2) return false;
  if (!REQUIRED_STRINGS.every((key) => nonBlank(value[key]))) return false;
  if (
    !REQUIRED_INTEGERS.every(
      (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0,
    )
  ) {
    return false;
  }
  if (!METHODS.has(value["method"] as string)) return false;
  if (!STATUSES.has(value["persistenceStatus"] as string)) return false;
  for (const key of ["consentId", "locale"]) {
    if (value[key] !== undefined && !nonBlank(value[key])) return false;
  }
  const decisions = value["decisions"];
  return (
    Array.isArray(decisions) &&
    decisions.every(
      (entry) =>
        isRecord(entry) &&
        Object.keys(entry).length === 2 &&
        DECISIONS.has(entry["decision"] as string) &&
        nonBlank(entry["purposeId"]),
    )
  );
}

function canonical(receipt: ConsentReceipt): string {
  return JSON.stringify(receipt, Object.keys(receipt).sort());
}

/** @public */
export function emptyEvidenceLog(): EvidenceLog {
  return { receipts: [] };
}

/**
 * Adds receipts to the log, all or nothing.
 *
 * One malformed receipt refuses the whole batch, so a partial import can never
 * be mistaken for a complete one. An exact repeat of a stored receipt is counted
 * as a duplicate and skipped, matching the runtime outbox's own retry semantics.
 *
 * @public
 */
export function ingestReceipts(
  log: EvidenceLog,
  incoming: readonly unknown[],
): EvidenceIngestResult {
  for (const [index, candidate] of incoming.entries()) {
    if (!isReceipt(candidate)) {
      return { issue: { index, kind: "malformed-receipt" }, ok: false };
    }
  }
  const byKey = new Map(
    log.receipts.map((receipt) => [receipt.idempotencyKey, canonical(receipt)]),
  );
  const added: ConsentReceipt[] = [];
  let duplicates = 0;
  for (const receipt of incoming as readonly ConsentReceipt[]) {
    const existing = byKey.get(receipt.idempotencyKey);
    if (existing === undefined) {
      byKey.set(receipt.idempotencyKey, canonical(receipt));
      added.push(receipt);
    } else if (existing === canonical(receipt)) {
      duplicates += 1;
    } else {
      return {
        issue: {
          idempotencyKey: receipt.idempotencyKey,
          kind: "idempotency-conflict",
        },
        ok: false,
      };
    }
  }
  return {
    duplicates,
    ingested: added.length,
    log: { receipts: [...log.receipts, ...added] },
    ok: true,
  };
}

/** Reads stored receipts matching every supplied filter. @public */
export function queryEvidence(
  log: EvidenceLog,
  query: EvidenceQuery,
): readonly ConsentReceipt[] {
  return log.receipts.filter(
    (receipt) =>
      (query.consentId === undefined ||
        receipt.consentId === query.consentId) &&
      (query.since === undefined || receipt.decidedAt >= query.since) &&
      (query.until === undefined || receipt.decidedAt <= query.until),
  );
}

/**
 * Erases every receipt held for one visitor.
 *
 * Reports the number actually removed. Zero is a real answer, not a failure:
 * it means nothing was held for that visitor.
 *
 * @public
 */
export function deleteEvidenceForConsent(
  log: EvidenceLog,
  consentId: string,
): { readonly deleted: number; readonly log: EvidenceLog } {
  const receipts = log.receipts.filter(
    (receipt) => receipt.consentId !== consentId,
  );
  return { deleted: log.receipts.length - receipts.length, log: { receipts } };
}

/**
 * Removes receipts decided before the cutoff.
 *
 * Nothing at or after the cutoff is touched, so an operator applying a
 * retention period can never lose evidence that is still inside it.
 *
 * @public
 */
export function applyEvidenceRetention(
  log: EvidenceLog,
  cutoff: number,
): { readonly log: EvidenceLog; readonly removed: number } {
  const receipts = log.receipts.filter(({ decidedAt }) => decidedAt >= cutoff);
  return { log: { receipts }, removed: log.receipts.length - receipts.length };
}
