import { describe, expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  type DefinedPolicy,
  type PolicyCategoryDefinition,
  type PolicyDefinition,
  type PolicyPurposeTranslation,
} from "./index.js";

// A category heading shows a label, not the category's identifier, and in
// every language the site shows.

function policy(
  category: Partial<PolicyCategoryDefinition>,
  purposeTranslations?: readonly PolicyPurposeTranslation[],
): PolicyDefinition {
  return {
    categories: [
      { id: "statistics", purposeIds: ["analytics"], ...category },
      { id: "other", purposeIds: [] },
    ],
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "measure" }],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Misst die Nutzung der Seiten.",
        id: "analytics",
        label: "Statistik",
        operationIds: ["measure"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["thirteen-months"],
        ...(purposeTranslations === undefined
          ? {}
          : { translations: purposeTranslations }),
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "thirteen-months" }],
  };
}

function defined(definition: PolicyDefinition): DefinedPolicy {
  const result = definePolicy(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

function issues(definition: PolicyDefinition) {
  const result = definePolicy(definition);
  return result.ok ? [] : result.issues;
}

const statistics = (result: DefinedPolicy) =>
  result.categories.find(({ id }) => id === "statistics");

const EN_PURPOSE = {
  disclosure: "Measures page use.",
  label: "Statistics",
  locale: "en",
};

describe("a category's label", () => {
  it("is kept trimmed, and a category without one has none", () => {
    const result = defined(policy({ label: " Statistik " }));

    expect(statistics(result)?.label).toBe("Statistik");
    expect(
      "label" in (result.categories.find(({ id }) => id === "other") ?? {}),
    ).toBe(false);
    expect(definePolicy(result as unknown as PolicyDefinition)).toEqual({
      ok: true,
      policy: result,
    });
  });

  it("carries its translations sorted by locale", () => {
    const result = defined(
      policy(
        {
          label: "Statistik",
          translations: [
            { label: "Statistiques", locale: "fr" },
            { label: " Statistics ", locale: "en" },
          ],
        },
        [EN_PURPOSE, { ...EN_PURPOSE, locale: "fr" }],
      ),
    );

    expect(statistics(result)?.translations).toEqual([
      { label: "Statistics", locale: "en" },
      { label: "Statistiques", locale: "fr" },
    ]);
    expect(definePolicy(result as unknown as PolicyDefinition)).toEqual({
      ok: true,
      policy: result,
    });
  });

  it("changes only the catalogue digest", () => {
    const snapshot = (label: string) =>
      createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: defined(policy({ label })),
        policyVersion: "policy-1",
      });
    const before = snapshot("Statistik");
    const after = snapshot("Messung");

    expect(after.catalogueDigest).not.toBe(before.catalogueDigest);
    expect(after.decisionSurfaceDigest).toBe(before.decisionSurfaceDigest);
  });

  it("refuses a blank label, and translations without a label", () => {
    expect(issues(policy({ label: " " }))).toEqual([
      { code: "blank-category-label", path: "categories[0].label" },
    ]);
    expect(
      issues(
        policy(
          { label: "Statistik", translations: [{ label: "", locale: "en" }] },
          [EN_PURPOSE],
        ),
      ),
    ).toEqual([
      {
        code: "blank-category-label",
        path: "categories[0].translations[0].label",
      },
    ]);
    expect(
      issues(
        policy({ translations: [{ label: "Statistics", locale: "en" }] }, [
          EN_PURPOSE,
        ]),
      ),
    ).toEqual([
      {
        code: "invalid-policy-definition-entry",
        path: "categories[0].translations",
      },
    ]);
  });

  it("carries the same languages as every purpose, when it has one", () => {
    expect(issues(policy({ label: "Statistik" }, [EN_PURPOSE]))).toEqual([
      {
        code: "incomplete-translations",
        normalizedId: "en",
        path: "categories[0].translations",
      },
    ]);
    // A category without a label shows its identifier in every language.
    expect(issues(policy({}, [EN_PURPOSE]))).toEqual([]);
  });
});
