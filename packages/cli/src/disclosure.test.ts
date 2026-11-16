import { describe, expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
} from "@opencookie-dev/core/domain";

import {
  buildPolicyDeclaration,
  declarePolicyTerms,
  emptyPolicyPublicationLog,
  publishPolicy,
} from "./index.js";

const TERMS = {
  analytics: { label: "Understand how the site is used" },
  processing: { label: "Analysing activity" },
  "site-operator": { label: "This website's operator" },
  "thirteen-months": { label: "Thirteen months" },
  "usage-data": {
    description: "Pages you opened and what you clicked.",
    label: "How you use the site",
  },
};

function snapshot() {
  const defined = definePolicy({
    dataCategories: [{ id: "usage-data" }],
    operations: [{ id: "processing" }],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-data"],
        disclosure: "Measures usage.",
        id: "analytics",
        operationIds: ["processing"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["thirteen-months"],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "thirteen-months" }],
  });
  if (!defined.ok) throw new Error("fixture must be valid");
  return createPolicySnapshot({
    catalogueRevision: "catalogue-1.0.0",
    policy: defined.policy,
    policyVersion: "1.0.0",
  });
}

function publicationWith(terms: unknown) {
  const result = publishPolicy(emptyPolicyPublicationLog(), {
    publicationId: "pub-1",
    snapshot: snapshot(),
    ...(terms === undefined ? {} : { terms: terms as never }),
  });
  if (!result.ok) throw new Error("fixture publication must succeed");
  return result.publication;
}

// @covers PP-16 REQ-INFORMED-CATALOGUE / TEST-DISCLOSURE-COMPLETENESS: a
// declaration may not publish bare identifiers to a visitor.
describe("TEST-DISCLOSURE-COMPLETENESS", () => {
  it("refuses a declaration that would show a visitor a bare identifier", () => {
    const partial = declarePolicyTerms(snapshot(), {
      analytics: { label: "Understand how the site is used" },
    });

    expect(partial.ok).toBe(false);
    if (partial.ok) return;
    const issue = partial.issue;
    expect(issue.kind).toBe("undisclosed-reference");
    if (issue.kind !== "undisclosed-reference") return;
    expect(issue.referenceIds).toContain("usage-data");
    expect(issue.referenceIds).toContain("site-operator");
    expect(issue.referenceIds).toContain("thirteen-months");
  });

  it("accepts a glossary that covers every referenced identifier", () => {
    const complete = declarePolicyTerms(snapshot(), TERMS);
    expect(complete.ok).toBe(true);
  });

  it("refuses a blank label rather than publishing an empty term", () => {
    const blank = declarePolicyTerms(snapshot(), {
      ...TERMS,
      "usage-data": { label: "   " },
    });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.issue.kind).toBe("blank-term-label");
  });

  it("refuses a term for an identifier the policy never references", () => {
    const stray = declarePolicyTerms(snapshot(), {
      ...TERMS,
      advertising: { label: "Ads" },
    });
    expect(stray.ok).toBe(false);
    if (stray.ok) return;
    expect(stray.issue.kind).toBe("unreferenced-term");
  });

  it("resolves every reference to plain language in the declaration", () => {
    const declaration = buildPolicyDeclaration(publicationWith(TERMS));
    const purpose = declaration.sections
      .flatMap((section) => section.purposes)
      .find(({ id }) => id === "analytics");

    expect(purpose?.dataCategories).toEqual([
      {
        description: "Pages you opened and what you clicked.",
        id: "usage-data",
        label: "How you use the site",
      },
    ]);
    expect(purpose?.providers).toEqual([
      { id: "site-operator", label: "This website's operator" },
    ]);
    expect(purpose?.retentions).toEqual([
      { id: "thirteen-months", label: "Thirteen months" },
    ]);
  });

  it("does not let plain language change what is enforced", () => {
    const plain = publicationWith(TERMS);
    const bare = publicationWith(undefined);

    expect(plain.snapshot.decisionSurfaceDigest).toBe(
      bare.snapshot.decisionSurfaceDigest,
    );
    expect(plain.snapshot.catalogueDigest).toBe(bare.snapshot.catalogueDigest);
  });
});
