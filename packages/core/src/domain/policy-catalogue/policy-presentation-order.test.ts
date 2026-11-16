import { describe, expect, it } from "vitest";

import {
  canonicalizePolicy,
  createPolicySnapshot,
  definePolicy,
  projectPolicySections,
  type DefinedPolicy,
  type PolicyDefinition,
  type PolicyPurposeDefinition,
} from "./index.js";

// The order an operator gives categories and a category's purposes is the
// order a visitor reads them in. It is presentation, not a decision, so it
// stays out of the policy's identity: reordering re-asks nobody, and a policy
// defined before the order was kept keeps the identity it had.

function purpose(id: string): PolicyPurposeDefinition {
  return {
    dataCategoryIds: ["usage-event"],
    disclosure: `Uses ${id}.`,
    id,
    operationIds: ["measure"],
    providerIds: ["site-operator"],
    recipientIds: ["site-operator"],
    retentionIds: ["thirteen-months"],
  };
}

function policy(authored: boolean): PolicyDefinition {
  return {
    categories: [
      { id: "preferences", purposeIds: ["language"] },
      {
        id: "statistics",
        purposeIds: authored ? ["reach", "analytics"] : ["analytics", "reach"],
      },
      {
        categoryIds: authored ? ["video", "ads"] : ["ads", "video"],
        id: "marketing",
        purposeIds: [],
      },
      { id: "video", purposeIds: ["video"] },
      { id: "ads", purposeIds: ["ads"] },
    ],
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "measure" }],
    presentationRootCategoryIds: authored
      ? ["preferences", "statistics", "marketing"]
      : ["marketing", "preferences", "statistics"],
    providers: [{ id: "site-operator" }],
    purposes: ["language", "reach", "analytics", "video", "ads"].map(purpose),
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "thirteen-months" }],
  };
}

function defined(definition: PolicyDefinition): DefinedPolicy {
  const result = definePolicy(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

const category = (result: DefinedPolicy, id: string) =>
  result.categories.find((candidate) => candidate.id === id);

describe("the order categories are presented in", () => {
  it("keeps the authored order of roots, subcategories and purposes", () => {
    const result = defined(policy(true));

    expect(result.presentationRootCategoryIds).toEqual([
      "preferences",
      "statistics",
      "marketing",
    ]);
    expect(category(result, "marketing")?.categoryIds).toEqual([
      "video",
      "ads",
    ]);
    expect(category(result, "statistics")?.purposeIds).toEqual([
      "reach",
      "analytics",
    ]);
    expect(definePolicy(result as unknown as PolicyDefinition)).toEqual({
      ok: true,
      policy: result,
    });
  });

  it("shows the sections in the authored order", () => {
    const sections = projectPolicySections(defined(policy(true)));

    expect(sections).toEqual([
      { categoryId: "preferences", purposeIds: ["language"] },
      { categoryId: "statistics", purposeIds: ["reach", "analytics"] },
      { categoryId: "video", purposeIds: ["video"] },
      { categoryId: "ads", purposeIds: ["ads"] },
    ]);
  });

  // The digests 0.2.3 computed for this policy, in either order, since it
  // sorted every one of these lists before hashing.
  it("leaves the identity where it was, whatever the order", () => {
    const snapshots = [true, false].map((authored) =>
      createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: defined(policy(authored)),
        policyVersion: "v1",
      }),
    );

    for (const snapshot of snapshots) {
      expect(snapshot.catalogueDigest).toBe(
        "sha256-v1:ebd9bd38bedb606320d322f1914d6f2e82fe44fc2c3cde17af8e885c30e08a1a",
      );
      expect(snapshot.decisionSurfaceDigest).toBe(
        "sha256-v1:75f6d92c739fd3fcfb2df464b5804642fa28fbe22626fc9cdc3790a1224d449a",
      );
    }
    expect(canonicalizePolicy(defined(policy(true)))).toEqual(
      canonicalizePolicy(defined(policy(false))),
    );
  });
});
