import { describe, expect, it } from "vitest";

import {
  definePolicy,
  resolvePolicyText,
  type DefinedPolicy,
  type PolicyDefinition,
} from "./index.js";

// The page shows the policy in its own language, and a stored decision's
// identity is the same in every language, because only the shown text
// differs.

function defined(definition: PolicyDefinition): DefinedPolicy {
  const result = definePolicy(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.policy;
}

const TRANSLATED = defined({
  categories: [
    {
      id: "statistics",
      label: "Statistik",
      purposeIds: ["analytics"],
      translations: [
        { label: "Statistics", locale: "en" },
        { label: "Statistiques", locale: "fr" },
      ],
    },
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
      translations: [
        { disclosure: "Measures page use.", label: "Statistics", locale: "en" },
        {
          disclosure: "Mesure l'usage des pages.",
          label: "Statistiques",
          locale: "fr",
        },
      ],
    },
  ],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: "thirteen-months" }],
});

function shown(locale: string) {
  const text = resolvePolicyText(TRANSLATED, locale);
  return {
    categories: text.categories.map(({ id, label }) => [id, label]),
    purposes: text.purposes.map(({ disclosure, id, label }) => [
      id,
      label,
      disclosure,
    ]),
  };
}

describe("resolvePolicyText", () => {
  it("shows the translation for the page's language", () => {
    expect(shown("fr")).toEqual({
      categories: [
        ["other", undefined],
        ["statistics", "Statistiques"],
      ],
      purposes: [["analytics", "Statistiques", "Mesure l'usage des pages."]],
    });
  });

  it("matches the language ignoring case, then by its primary language", () => {
    for (const locale of ["EN", "en-GB", "en-gb"]) {
      expect(shown(locale).purposes).toEqual([
        ["analytics", "Statistics", "Measures page use."],
      ]);
    }
  });

  it("shows the policy's own text for any other language", () => {
    for (const locale of ["de", "de-AT", "it", ""]) {
      expect(shown(locale)).toEqual({
        categories: [
          ["other", undefined],
          ["statistics", "Statistik"],
        ],
        purposes: [["analytics", "Statistik", "Misst die Nutzung der Seiten."]],
      });
    }
  });

  it("leaves the policy itself unchanged", () => {
    const before = JSON.stringify(TRANSLATED);
    resolvePolicyText(TRANSLATED, "en");

    expect(JSON.stringify(TRANSLATED)).toBe(before);
  });
});
