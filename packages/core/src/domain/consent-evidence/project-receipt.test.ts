import { expect, it } from "vitest";

import {
  projectConsentReceipt,
  type ConsentReceiptTransition,
} from "./index.js";

const transition = {
  catalogueDigest: "catalogue-1",
  decidedAt: 1_782_600_000_000,
  decisionSurfaceDigest: "surface-1",
  decisions: { personalization: "denied", analytics: "granted" } as const,
  ipAddress: "192.0.2.1",
  locale: "en",
  method: "granular" as const,
  occurredAt: 1_782_600_000_123,
  persistenceStatus: "confirmed" as const,
  policyVersion: "policy-1",
  revision: 3,
  transitionId: "transition-3",
  userAgent: "fixture-agent",
};

it("TEST-CONSENT-PROOF-MINIMAL projects a stable sorted receipt", () => {
  const receipt = projectConsentReceipt(transition);

  expect(receipt).toEqual({
    catalogueDigest: "catalogue-1",
    decidedAt: 1_782_600_000_000,
    occurredAt: 1_782_600_000_123,
    decisionSurfaceDigest: "surface-1",
    decisions: [
      { decision: "granted", purposeId: "analytics" },
      { decision: "denied", purposeId: "personalization" },
    ],
    idempotencyKey: "transition-3:3",
    locale: "en",
    method: "granular",
    persistenceStatus: "confirmed",
    policyVersion: "policy-1",
    revision: 3,
    schemaVersion: 2,
    transitionId: "transition-3",
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.decisions)).toBe(true);
  expect("ipAddress" in receipt).toBe(false);
  expect("userAgent" in receipt).toBe(false);
  expect("consentId" in receipt).toBe(false);
  expect(JSON.stringify(receipt)).toBe(
    '{"catalogueDigest":"catalogue-1","decidedAt":1782600000000,"occurredAt":1782600000123,"decisionSurfaceDigest":"surface-1","decisions":[{"decision":"granted","purposeId":"analytics"},{"decision":"denied","purposeId":"personalization"}],"idempotencyKey":"transition-3:3","locale":"en","method":"granular","persistenceStatus":"confirmed","policyVersion":"policy-1","revision":3,"schemaVersion":2,"transitionId":"transition-3"}',
  );
  expect(JSON.stringify(projectConsentReceipt(transition))).toBe(
    JSON.stringify(receipt),
  );
});

it.each([
  ["decidedAt", undefined],
  ["decidedAt", Number.NaN],
  ["decidedAt", Number.POSITIVE_INFINITY],
  ["decidedAt", 1.5],
  ["decidedAt", Number.MAX_SAFE_INTEGER + 1],
  ["occurredAt", undefined],
  ["occurredAt", Number.NaN],
  ["occurredAt", Number.NEGATIVE_INFINITY],
  ["occurredAt", 1.5],
  ["occurredAt", Number.MAX_SAFE_INTEGER + 1],
] as const)("rejects an unsafe %s receipt timestamp", (field, value) => {
  const invalid = { ...transition, [field]: value };

  expect(() =>
    projectConsentReceipt(invalid as unknown as ConsentReceiptTransition),
  ).toThrow(new TypeError(`${field} must be a finite safe integer.`));
});

it("rejects a receipt occurrence before its decision and accepts equality or later", () => {
  expect(() =>
    projectConsentReceipt({
      ...transition,
      occurredAt: transition.decidedAt - 1,
    }),
  ).toThrow(
    new RangeError("occurredAt must be greater than or equal to decidedAt."),
  );

  expect(
    projectConsentReceipt({ ...transition, occurredAt: transition.decidedAt }),
  ).toMatchObject({
    decidedAt: transition.decidedAt,
    occurredAt: transition.decidedAt,
    schemaVersion: 2,
  });
  expect(projectConsentReceipt(transition)).toMatchObject({
    decidedAt: transition.decidedAt,
    occurredAt: transition.occurredAt,
    schemaVersion: 2,
  });
});

it("projects the same receipt timestamps that passed validation", () => {
  let decidedAtReads = 0;
  let occurredAtReads = 0;
  const changingTransition = Object.defineProperties(
    { ...transition },
    {
      decidedAt: {
        enumerable: true,
        get: () =>
          ++decidedAtReads === 1
            ? transition.decidedAt
            : Number.MAX_SAFE_INTEGER + 1,
      },
      occurredAt: {
        enumerable: true,
        get: () =>
          ++occurredAtReads === 1
            ? transition.occurredAt
            : transition.decidedAt - 1,
      },
    },
  );

  expect(
    projectConsentReceipt(
      changingTransition as unknown as ConsentReceiptTransition,
    ),
  ).toMatchObject({
    decidedAt: transition.decidedAt,
    occurredAt: transition.occurredAt,
  });
  expect([decidedAtReads, occurredAtReads]).toEqual([1, 1]);
});

it("projects one captured snapshot of every public transition field", () => {
  const first = {
    catalogueDigest: "catalogue-first",
    consentId: "consent-first",
    decidedAt: transition.decidedAt,
    decisionSurfaceDigest: "surface-first",
    decisions: { personalization: "denied", analytics: "granted" } as const,
    locale: "en",
    method: "granular" as const,
    occurredAt: transition.occurredAt,
    persistenceStatus: "confirmed" as const,
    policyVersion: "policy-first",
    revision: 3,
    transitionId: "transition-first",
  } satisfies ConsentReceiptTransition;
  const second = {
    catalogueDigest: "catalogue-second",
    consentId: "consent-second",
    decidedAt: Number.MAX_SAFE_INTEGER + 1,
    decisionSurfaceDigest: "surface-second",
    decisions: { advertising: "granted" } as const,
    locale: "de",
    method: "accept-all" as const,
    occurredAt: transition.decidedAt - 1,
    persistenceStatus: "failed" as const,
    policyVersion: "policy-second",
    revision: 4,
    transitionId: "transition-second",
  } satisfies ConsentReceiptTransition;
  const keys = Object.keys(first) as (keyof typeof first)[];
  const reads: Partial<Record<keyof typeof first, number>> = {};
  const changingTransition = Object.defineProperties(
    {},
    Object.fromEntries(
      keys.map((key) => [
        key,
        {
          enumerable: true,
          get: () => {
            const count = (reads[key] ?? 0) + 1;
            reads[key] = count;
            return count === 1 ? first[key] : second[key];
          },
        },
      ]),
    ),
  ) as ConsentReceiptTransition;

  expect(projectConsentReceipt(changingTransition)).toEqual({
    catalogueDigest: "catalogue-first",
    consentId: "consent-first",
    decidedAt: transition.decidedAt,
    occurredAt: transition.occurredAt,
    decisionSurfaceDigest: "surface-first",
    decisions: [
      { decision: "granted", purposeId: "analytics" },
      { decision: "denied", purposeId: "personalization" },
    ],
    idempotencyKey: "transition-first:3",
    locale: "en",
    method: "granular",
    persistenceStatus: "confirmed",
    policyVersion: "policy-first",
    revision: 3,
    schemaVersion: 2,
    transitionId: "transition-first",
  });
  expect(reads).toEqual(Object.fromEntries(keys.map((key) => [key, 1])));
});
