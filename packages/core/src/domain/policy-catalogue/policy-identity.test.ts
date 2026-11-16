import { describe, expect, it } from "vitest";

import {
  canonicalizePolicy,
  createPolicySnapshot,
  definePolicy,
  type DefinedPolicy,
} from "./index.js";
import {
  completeTestPolicyDefinition,
  type TestPolicyDefinition,
} from "./policy-test-fixtures.test-helper.js";

function defineFixture(definition: TestPolicyDefinition): DefinedPolicy {
  const result = definePolicy(completeTestPolicyDefinition(definition));
  if (!result.ok) throw new Error("fixture policy must be valid");
  return result.policy;
}

describe("policy identity", () => {
  it("derives compact versioned collision-resistant identities", () => {
    const original = createPolicySnapshot({
      catalogueRevision: "catalogue-original",
      policy: defineFixture({
        purposes: [
          {
            disclosure: "Measure site use",
            editorialNote: "Short layout",
            id: "analytics",
          },
        ],
      }),
      policyVersion: "opaque-version-alpha",
    });
    const edited = createPolicySnapshot({
      catalogueRevision: "catalogue-edited",
      policy: defineFixture({
        purposes: [
          {
            disclosure: "Measure site use",
            editorialNote: "Longer layout",
            id: "analytics",
          },
        ],
      }),
      policyVersion: "opaque-version-alpha",
    });

    const identity = /^sha256-v1:[0-9a-f]{64}$/u;
    expect(edited.catalogueDigest).toMatch(identity);
    expect(edited.decisionSurfaceDigest).toMatch(identity);
    expect(edited.catalogueDigest).not.toBe(original.catalogueDigest);
    expect(edited.decisionSurfaceDigest).toBe(original.decisionSurfaceDigest);
    expect(
      createPolicySnapshot({
        catalogueRevision: edited.catalogueRevision,
        policy: edited.policy,
        policyVersion: edited.policyVersion,
      }),
    ).toMatchObject({
      catalogueDigest: edited.catalogueDigest,
      decisionSurfaceDigest: edited.decisionSurfaceDigest,
    });
    expect(Object.isFrozen(edited)).toBe(true);
    expect(Object.isFrozen(edited.policy)).toBe(true);
  });

  it("distinguishes same-length canonical policy changes", () => {
    const previous = createPolicySnapshot({
      catalogueRevision: "same-length-previous",
      policy: defineFixture({
        purposes: [{ disclosure: "old", id: "analytics" }],
      }),
      policyVersion: "policy-1",
    });
    const current = createPolicySnapshot({
      catalogueRevision: "same-length-current",
      policy: defineFixture({
        purposes: [{ disclosure: "new", id: "analytics" }],
      }),
      policyVersion: "policy-2",
    });

    expect(canonicalizePolicy(previous.policy).catalogue).toHaveLength(
      canonicalizePolicy(current.policy).catalogue.length,
    );
    expect(previous.catalogueDigest).not.toBe(current.catalogueDigest);
    expect(previous.decisionSurfaceDigest).not.toBe(
      current.decisionSurfaceDigest,
    );
  });

  it("canonicalizes insertion-order-independent catalogue collections", () => {
    const first = defineFixture({
      categories: [
        { categoryIds: ["secondary"], id: "root", purposeIds: ["ads"] },
        { id: "secondary", purposeIds: ["analytics"] },
      ],
      dataCategories: [{ id: "usage" }, { id: "device" }],
      operations: [{ id: "script" }, { id: "pixel" }],
      presentationRootCategoryIds: ["root", "secondary"],
      providers: [{ id: "zeta" }, { id: "alpha" }],
      purposes: [
        {
          dataCategoryIds: ["usage", "device"],
          disclosure: "Measure use",
          id: "analytics",
          operationIds: ["script", "pixel"],
          providerIds: ["alpha", "zeta"],
          recipientIds: ["vendor", "internal"],
          retentionIds: ["year", "session"],
        },
        { dependsOn: ["analytics"], id: "ads", providerIds: ["zeta"] },
      ],
      recipients: [{ id: "vendor" }, { id: "internal" }],
      retentions: [{ id: "year" }, { id: "session" }],
    });
    const reordered = {
      categories: [...first.categories].reverse().map((category) => ({
        categoryIds: [...category.categoryIds].reverse(),
        id: category.id,
        purposeIds: [...category.purposeIds].reverse(),
      })),
      dataCategories: [...first.dataCategories].reverse(),
      operations: [...first.operations].reverse(),
      presentationRootCategoryIds: [
        ...first.presentationRootCategoryIds,
      ].reverse(),
      providers: [...first.providers].reverse(),
      purposes: [...first.purposes].reverse().map((purpose) => ({
        ...purpose,
        dataCategoryIds: [...purpose.dataCategoryIds].reverse(),
        dependsOn: [...purpose.dependsOn].reverse(),
        operationIds: [...purpose.operationIds].reverse(),
        providerIds: [...purpose.providerIds].reverse(),
        recipientIds: [...purpose.recipientIds].reverse(),
        retentionIds: [...purpose.retentionIds].reverse(),
      })),
      recipients: [...first.recipients].reverse(),
      retentions: [...first.retentions].reverse(),
    } as unknown as DefinedPolicy;

    const canonical = canonicalizePolicy(first);
    expect(canonicalizePolicy(reordered)).toEqual(canonical);
    expect(JSON.parse(canonical.catalogue)).toEqual(first);
    expect(JSON.parse(canonical.decisionSurface)).toEqual({
      purposes: [
        {
          dataCategoryIds: ["device"],
          dependsOn: ["analytics"],
          disclosure: "Test-only disclosure for ads.",
          id: "ads",
          label: "ads",
          operationIds: ["pixel"],
          providerIds: ["zeta"],
          recipientIds: ["internal"],
          retentionIds: ["session"],
        },
        {
          dataCategoryIds: ["device", "usage"],
          dependsOn: [],
          disclosure: "Measure use",
          id: "analytics",
          label: "analytics",
          operationIds: ["pixel", "script"],
          providerIds: ["alpha", "zeta"],
          recipientIds: ["internal", "vendor"],
          retentionIds: ["session", "year"],
        },
      ],
    });

    const firstSnapshot = createPolicySnapshot({
      catalogueRevision: "same-revision",
      policy: first,
      policyVersion: "opaque-version",
    });
    const reorderedSnapshot = createPolicySnapshot({
      catalogueRevision: "same-revision",
      policy: reordered,
      policyVersion: "opaque-version",
    });

    expect(reorderedSnapshot.catalogueDigest).toBe(
      firstSnapshot.catalogueDigest,
    );
    expect(reorderedSnapshot.decisionSurfaceDigest).toBe(
      firstSnapshot.decisionSurfaceDigest,
    );
  });

  it("rejects a forged incomplete policy before deriving identity", () => {
    const forged = {
      categories: [],
      dataCategories: [],
      operations: [],
      presentationRootCategoryIds: [],
      providers: [],
      purposes: [
        {
          dataCategoryIds: [],
          dependsOn: [],
          disclosure: "",
          editorialNote: "",
          id: "analytics",
          operationIds: [],
          providerIds: [],
          recipientIds: [],
          retentionIds: [],
        },
      ],
      recipients: [],
      retentions: [],
    } as unknown as DefinedPolicy;

    expect(() =>
      createPolicySnapshot({
        catalogueRevision: "forged-catalogue",
        policy: forged,
        policyVersion: "forged-policy",
      }),
    ).toThrow(TypeError);
  });
});
