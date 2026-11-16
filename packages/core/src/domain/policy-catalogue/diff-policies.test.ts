import { describe, expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  diffPolicies,
  type PolicySnapshot,
} from "./index.js";
import {
  completeTestPolicyDefinition,
  type TestPolicyDefinition,
} from "./policy-test-fixtures.test-helper.js";

function snapshot(
  definition: TestPolicyDefinition,
  catalogueRevision: string,
  policyVersion: string,
): PolicySnapshot {
  const result = definePolicy(completeTestPolicyDefinition(definition));
  if (!result.ok) throw new Error("fixture policy must be valid");

  return createPolicySnapshot({
    catalogueRevision,
    policy: result.policy,
    policyVersion,
  });
}

describe("diffPolicies", () => {
  it("marks only the purpose whose meaningful disclosure changed", () => {
    const previous = snapshot(
      {
        providers: [{ id: "alpha" }, { id: "beta" }],
        purposes: [
          { id: "base-a" },
          { id: "base-b" },
          {
            dependsOn: ["base-a"],
            disclosure: "Measure site use",
            id: "analytics",
            providerIds: ["alpha"],
            retentionIds: ["session"],
          },
          { disclosure: "Show contextual ads", id: "ads" },
        ],
        retentions: [{ id: "session" }, { id: "year" }],
      },
      "catalogue-before",
      "opaque-before",
    );
    const next = snapshot(
      {
        providers: [{ id: "beta" }, { id: "alpha" }],
        purposes: [
          { disclosure: "Show contextual ads", id: "ads" },
          {
            retentionIds: ["year"],
            providerIds: ["beta"],
            id: "analytics",
            disclosure: "Measure use and improve journeys",
            dependsOn: ["base-b"],
          },
          { id: "base-b" },
          { id: "base-a" },
        ],
        retentions: [{ id: "year" }, { id: "session" }],
      },
      "catalogue-after",
      "opaque-after",
    );

    const result = diffPolicies(previous, next);
    if (!result.ok) throw new Error("fixture version transition must be valid");

    expect(result.changeSet.affectedPurposeIds).toEqual(["analytics"]);
    expect(result.changeSet.addedPurposeIds).toEqual([]);
    expect(result.changeSet.removedPurposeIds).toEqual([]);
    expect(result.changeSet.changes).toEqual([
      {
        purposeId: "analytics",
        reasons: ["provider", "retention", "dependency", "free-text"],
      },
    ]);
    expect(result.changeSet.previousIdentity.catalogueRevision).toBe(
      "catalogue-before",
    );
    expect(result.changeSet.nextIdentity.catalogueRevision).toBe(
      "catalogue-after",
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changeSet)).toBe(true);
    expect(Object.isFrozen(result.changeSet.changes[0]?.reasons)).toBe(true);
  });

  it("reason-codes added and removed purposes in stable order", () => {
    const previous = snapshot(
      { purposes: [{ id: "removed" }, { id: "kept" }] },
      "catalogue-before",
      "opaque-before",
    );
    const next = snapshot(
      { purposes: [{ id: "kept" }, { id: "added" }] },
      "catalogue-after",
      "opaque-after",
    );

    const result = diffPolicies(previous, next);
    if (!result.ok) throw new Error("fixture version transition must be valid");

    expect(result.changeSet.affectedPurposeIds).toEqual(["added", "removed"]);
    expect(result.changeSet.addedPurposeIds).toEqual(["added"]);
    expect(result.changeSet.removedPurposeIds).toEqual(["removed"]);
    expect(result.changeSet.changes).toEqual([
      { purposeId: "added", reasons: ["added"] },
      { purposeId: "removed", reasons: ["removed"] },
    ]);
  });

  it("reason-codes operation, recipient, and data-category changes", () => {
    const previous = snapshot(
      {
        dataCategories: [{ id: "device" }, { id: "usage" }],
        operations: [{ id: "pixel" }, { id: "script" }],
        purposes: [
          {
            dataCategoryIds: ["usage"],
            id: "analytics",
            operationIds: ["script"],
            recipientIds: ["internal"],
          },
        ],
        recipients: [{ id: "internal" }, { id: "vendor" }],
      },
      "catalogue-before",
      "opaque-before",
    );
    const next = snapshot(
      {
        dataCategories: [{ id: "device" }, { id: "usage" }],
        operations: [{ id: "pixel" }, { id: "script" }],
        purposes: [
          {
            dataCategoryIds: ["device"],
            id: "analytics",
            operationIds: ["pixel"],
            recipientIds: ["vendor"],
          },
        ],
        recipients: [{ id: "internal" }, { id: "vendor" }],
      },
      "catalogue-after",
      "opaque-after",
    );

    const result = diffPolicies(previous, next);
    if (!result.ok) throw new Error("fixture version transition must be valid");

    expect(result.changeSet.changes).toEqual([
      {
        purposeId: "analytics",
        reasons: ["operation", "recipient", "data-category"],
      },
    ]);
  });

  it("does not mark editorial-only purpose text as affected", () => {
    const previous = snapshot(
      { purposes: [{ editorialNote: "Compact", id: "analytics" }] },
      "catalogue-before",
      "opaque-same",
    );
    const next = snapshot(
      { purposes: [{ editorialNote: "Expanded", id: "analytics" }] },
      "catalogue-after",
      "opaque-same",
    );

    const result = diffPolicies(previous, next);
    if (!result.ok) throw new Error("fixture version transition must be valid");

    expect(result.changeSet.affectedPurposeIds).toEqual([]);
    expect(result.changeSet.changes).toEqual([]);
  });

  // One policy serves every language, so a reworded or added language is a
  // change to the text the visitor decided on, never an inconsistent diff.
  it("treats a changed or added translation as decision-surface free text", () => {
    const english = {
      disclosure: "Measures page use.",
      label: "Statistics",
      locale: "en",
    };
    const previous = snapshot(
      { purposes: [{ id: "analytics", translations: [english] }] },
      "catalogue-before",
      "opaque-before",
    );
    for (const translations of [
      [{ ...english, disclosure: "Measures how pages are used." }],
      [english, { ...english, label: "Statistiques", locale: "fr" }],
    ]) {
      const next = snapshot(
        { purposes: [{ id: "analytics", translations }] },
        "catalogue-after",
        "opaque-after",
      );

      const result = diffPolicies(previous, next);
      if (!result.ok)
        throw new Error("fixture version transition must be valid");

      expect(result.changeSet.changes).toEqual([
        { purposeId: "analytics", reasons: ["free-text"] },
      ]);
    }
  });

  it("treats a purpose label change as decision-surface free text", () => {
    const previous = snapshot(
      { purposes: [{ id: "analytics", label: "Analytics" }] },
      "catalogue-before",
      "opaque-before",
    );
    const next = snapshot(
      { purposes: [{ id: "analytics", label: "Usage analytics" }] },
      "catalogue-after",
      "opaque-after",
    );

    const result = diffPolicies(previous, next);
    if (!result.ok) throw new Error("fixture version transition must be valid");

    expect(result.changeSet.changes).toEqual([
      { purposeId: "analytics", reasons: ["free-text"] },
    ]);
    expect(next.decisionSurfaceDigest).not.toBe(previous.decisionSurfaceDigest);
  });
});
