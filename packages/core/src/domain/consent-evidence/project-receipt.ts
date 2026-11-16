import { checkedSafeInteger } from "../shared/checked-safe-integer.js";

/** @public */
export type ReceiptDecisionMethod =
  "accept-all" | "granular" | "imported" | "reject-all" | "withdrawal";

/** @public */
export type ReceiptPersistenceStatus =
  "confirmed" | "failed" | "failed-conservative";

/** @public */
export interface ConsentReceiptTransition {
  readonly catalogueDigest: string;
  readonly consentId?: string;
  readonly decidedAt: number;
  readonly occurredAt: number;
  readonly decisionSurfaceDigest: string;
  readonly decisions: Readonly<Record<string, "denied" | "granted">>;
  readonly locale?: string;
  readonly method: ReceiptDecisionMethod;
  readonly persistenceStatus: ReceiptPersistenceStatus;
  readonly policyVersion: string;
  readonly revision: number;
  readonly transitionId: string;
}

/** @public */
export interface ConsentReceiptDecision {
  readonly decision: "denied" | "granted";
  readonly purposeId: string;
}

/** @public */
export interface ConsentReceipt {
  readonly catalogueDigest: string;
  readonly consentId?: string;
  readonly decidedAt: number;
  readonly occurredAt: number;
  readonly decisionSurfaceDigest: string;
  readonly decisions: readonly ConsentReceiptDecision[];
  readonly idempotencyKey: string;
  readonly locale?: string;
  readonly method: ReceiptDecisionMethod;
  readonly persistenceStatus: ReceiptPersistenceStatus;
  readonly policyVersion: string;
  readonly revision: number;
  readonly schemaVersion: 2;
  readonly transitionId: string;
}

export function assertConsentReceiptTimestamps(
  decidedAt: number,
  occurredAt: number,
): void {
  checkedSafeInteger(decidedAt, "decidedAt");
  checkedSafeInteger(occurredAt, "occurredAt");
  if (occurredAt < decidedAt) {
    throw new RangeError(
      "occurredAt must be greater than or equal to decidedAt.",
    );
  }
}

/** @public */
export function projectConsentReceipt(
  transition: ConsentReceiptTransition,
): ConsentReceipt {
  const { consentId, decidedAt, locale, occurredAt, revision, transitionId } =
    transition;
  assertConsentReceiptTimestamps(decidedAt, occurredAt);
  const decisions = Object.freeze(
    Object.entries(transition.decisions)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([purposeId, decision]) => Object.freeze({ decision, purposeId })),
  );

  return Object.freeze({
    catalogueDigest: transition.catalogueDigest,
    ...(consentId === undefined ? {} : { consentId }),
    decidedAt,
    occurredAt,
    decisionSurfaceDigest: transition.decisionSurfaceDigest,
    decisions,
    idempotencyKey: `${transitionId}:${String(revision)}`,
    ...(locale === undefined ? {} : { locale }),
    method: transition.method,
    persistenceStatus: transition.persistenceStatus,
    policyVersion: transition.policyVersion,
    revision,
    schemaVersion: 2 as const,
    transitionId,
  });
}
