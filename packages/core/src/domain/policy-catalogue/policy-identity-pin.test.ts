import { describe, expect, it } from "vitest";

import { defineAutoPolicy } from "./define-auto-policy.js";
import {
  createPolicySnapshot,
  definePolicy,
  type PolicyDefinition,
} from "./index.js";

// A stored decision stays current only while its policy's digests are
// unchanged. These are the exact digests released core 0.2.1 computes for
// policies sites already run, so a new optional field cannot re-prompt their
// visitors unnoticed.

const DAYS_180_MS = 180 * 24 * 60 * 60 * 1000;
const RETENTION = `duration-${String(DAYS_180_MS)}-ms`;

/** The programmatic bootstrap's starter catalogue, as vanilla builds it. */
const BOOTSTRAP_STARTER: PolicyDefinition = {
  categories: [{ id: "optional", purposeIds: ["analytics"] }],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "aggregate-measurement" }],
  presentationRootCategoryIds: ["optional"],
  providers: [{ id: "site-operator" }],
  purposes: [
    {
      dataCategoryIds: ["usage-event"],
      disclosure: "Understand aggregate site usage.",
      id: "analytics",
      label: "Analytics",
      operationIds: ["aggregate-measurement"],
      providerIds: ["site-operator"],
      recipientIds: ["site-operator"],
      retentionIds: [RETENTION],
    },
  ],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: RETENTION }],
};

/** A multi-purpose policy with nested categories, a dependency and a note. */
const RICH: PolicyDefinition = {
  categories: [
    { categoryIds: ["measurement"], id: "optional", purposeIds: [] },
    { id: "measurement", purposeIds: ["analytics", "advertising"] },
    { id: "comfort", purposeIds: ["personalization"] },
  ],
  dataCategories: [{ id: "usage-event" }, { id: "preference" }],
  operations: [{ id: "measure" }, { id: "remember" }],
  presentationRootCategoryIds: ["optional", "comfort"],
  providers: [{ id: "site-operator" }, { id: "ad-network" }],
  purposes: [
    {
      dataCategoryIds: ["usage-event"],
      disclosure: "Measure how pages are used, in aggregate.",
      editorialNote: "Keep this short.",
      id: "analytics",
      label: "Analytics",
      operationIds: ["measure"],
      providerIds: ["site-operator"],
      recipientIds: ["site-operator"],
      retentionIds: ["thirteen-months"],
    },
    {
      dataCategoryIds: ["usage-event"],
      dependsOn: ["analytics"],
      disclosure: "Measure which advertisements led to a visit.",
      id: "advertising",
      label: "Advertising",
      operationIds: ["measure"],
      providerIds: ["ad-network", "site-operator"],
      recipientIds: ["ad-network"],
      retentionIds: ["thirteen-months"],
    },
    {
      dataCategoryIds: ["preference"],
      disclosure: "Remember settings for later visits.",
      id: "personalization",
      operationIds: ["remember"],
      providerIds: ["site-operator"],
      recipientIds: ["site-operator"],
      retentionIds: ["thirteen-months"],
    },
  ],
  recipients: [{ id: "site-operator" }, { id: "ad-network" }],
  retentions: [{ id: "thirteen-months" }],
};

function digests(definition: PolicyDefinition) {
  const result = definePolicy(definition);
  if (!result.ok) throw new Error("The pinned policy must be valid.");
  const { catalogueDigest, decisionSurfaceDigest } = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: result.policy,
    policyVersion: "policy-1",
  });
  return { catalogueDigest, decisionSurfaceDigest };
}

describe("the digests of policies sites already run", () => {
  it("are unchanged for the programmatic bootstrap's starter", () => {
    expect(digests(BOOTSTRAP_STARTER)).toEqual({
      catalogueDigest:
        "sha256-v1:36971fa50e73eb7622b1f334f3f182f6872dfce34934e2503d16bcd26457f0d5",
      decisionSurfaceDigest:
        "sha256-v1:a8c4e54539137ed113ea96735882642204a3bcddcca7da3c23fc1085abb79145",
    });
  });

  it("are unchanged for the drop-in's default, and equal the starter's", () => {
    const { catalogueDigest, decisionSurfaceDigest } = defineAutoPolicy({
      catalogueRevision: "catalogue-1",
      consentDurationMs: DAYS_180_MS,
      disclosure: "Understand aggregate site usage.",
      policyVersion: "policy-1",
      purposeId: "analytics",
      purposeLabel: "Analytics",
    }).snapshot;

    expect({ catalogueDigest, decisionSurfaceDigest }).toEqual(
      digests(BOOTSTRAP_STARTER),
    );
  });

  it("are unchanged for a multi-purpose policy with nested categories", () => {
    expect(digests(RICH)).toEqual({
      catalogueDigest:
        "sha256-v1:05f64289cef27e8c73a708643f1e94e07d03c3b87f0d7bea4fffee96676e0ea7",
      decisionSurfaceDigest:
        "sha256-v1:272c9d34450005834f3a665975923a5d71379a9582a3613b6fb27562b3a673f9",
    });
  });
});
