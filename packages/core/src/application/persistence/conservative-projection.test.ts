import { expect, it } from "vitest";

import {
  projectConservativePersistenceFailure,
  type PersistedDecisionRecord,
} from "../../application.js";

it("applies narrowing and withholds widening after a mixed save fails", () => {
  const previous: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: { ads: "denied", analytics: "granted" },
    expiresAt: 2_000,
    method: "granular",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  };
  const requested: PersistedDecisionRecord = {
    ...previous,
    decisions: { ads: "granted", analytics: "denied" },
    revision: 2,
  };
  const previousBefore = structuredClone(previous);
  const requestedBefore = structuredClone(requested);

  expect(projectConservativePersistenceFailure(previous, requested)).toEqual({
    appliedChanges: [{ from: "granted", purposeId: "analytics", to: "denied" }],
    effectiveRecord: {
      ...requested,
      decisions: { ads: "denied", analytics: "denied" },
      method: "reject-all",
    },
    persistenceStatus: "failed-conservative",
    withheldPurposeIds: ["ads"],
  });
  expect(previous).toEqual(previousBefore);
  expect(requested).toEqual(requestedBefore);
});

it("does not renew a retained grant when the replacement cannot persist", () => {
  const previous: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: { ads: "denied", analytics: "granted" },
    expiresAt: 2_000,
    method: "granular",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  };
  const requested: PersistedDecisionRecord = {
    ...previous,
    decidedAt: 1_500,
    decisions: { ads: "granted", analytics: "granted" },
    expiresAt: 10_000,
    method: "accept-all",
    revision: 2,
  };

  expect(
    projectConservativePersistenceFailure(previous, requested).effectiveRecord,
  ).toMatchObject({
    decisions: { ads: "denied", analytics: "granted" },
    expiresAt: 2_000,
    method: "granular",
  });
});

it("preserves a __proto__ purpose as an own decision when the first save fails", () => {
  const requested: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: JSON.parse('{"__proto__":"granted"}') as Record<
      string,
      "denied" | "granted"
    >,
    expiresAt: 2_000,
    method: "accept-all",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  };

  const result = projectConservativePersistenceFailure(null, requested);

  expect(Object.getPrototypeOf(result.effectiveRecord.decisions)).toBeNull();
  expect(Object.hasOwn(result.effectiveRecord.decisions, "__proto__")).toBe(
    true,
  );
  expect(result.effectiveRecord.decisions["__proto__"]).toBe("denied");
  expect(result.withheldPurposeIds).toEqual(["__proto__"]);
  expect(result.appliedChanges).toEqual([
    { from: "unresolved", purposeId: "__proto__", to: "denied" },
  ]);
});
