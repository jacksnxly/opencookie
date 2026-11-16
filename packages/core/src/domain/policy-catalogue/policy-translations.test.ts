import { describe, expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  type DefinedPolicy,
  type PolicyDefinition,
  type PolicyPurposeDefinition,
} from "./index.js";

// A site that shows its choices in several languages keeps one policy, so a
// visitor's decision stays current whichever language the page shows. Each
// purpose carries its label and disclosure in every further language.

const REFERENCES = {
  dataCategoryIds: ["usage-event"],
  operationIds: ["measure"],
  providerIds: ["site-operator"],
  recipientIds: ["site-operator"],
  retentionIds: ["thirteen-months"],
} as const;

function policy(
  ...purposes: readonly Partial<PolicyPurposeDefinition>[]
): PolicyDefinition {
  return {
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "measure" }],
    providers: [{ id: "site-operator" }],
    purposes: purposes.map((purpose, index) => ({
      ...REFERENCES,
      disclosure: `Zweck ${String(index)} in zusammengefasster Form.`,
      id: `purpose-${String(index)}`,
      label: `Zweck ${String(index)}`,
      ...purpose,
    })),
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

const EN = {
  disclosure: " Measures page use, in aggregate. ",
  label: " Statistics ",
  locale: "en",
};
const FR = {
  disclosure: "Mesure l'usage des pages.",
  label: "Statistiques",
  locale: "fr",
};

describe("a purpose's translations", () => {
  it("are kept trimmed and sorted by locale, and survive being defined again", () => {
    const result = defined(policy({ translations: [FR, EN] }));

    expect(result.purposes[0]?.translations).toEqual([
      {
        disclosure: "Measures page use, in aggregate.",
        label: "Statistics",
        locale: "en",
      },
      FR,
    ]);
    expect(definePolicy(result as unknown as PolicyDefinition)).toEqual({
      ok: true,
      policy: result,
    });
  });

  it("are left out of a purpose that declares none", () => {
    const result = defined(policy({}, { translations: [] }));

    expect(result.purposes.map((purpose) => "translations" in purpose)).toEqual(
      [false, false],
    );
  });

  it("are part of both digests", () => {
    const snapshot = (definition: PolicyDefinition) =>
      createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: defined(definition),
        policyVersion: "policy-1",
      });
    const without = snapshot(policy({}));
    const translated = snapshot(policy({ translations: [EN] }));
    const reworded = snapshot(
      policy({ translations: [{ ...EN, label: "Measurement" }] }),
    );

    expect(translated.catalogueDigest).not.toBe(without.catalogueDigest);
    expect(translated.decisionSurfaceDigest).not.toBe(
      without.decisionSurfaceDigest,
    );
    expect(reworded.decisionSurfaceDigest).not.toBe(
      translated.decisionSurfaceDigest,
    );
  });

  it("refuse a locale that is not a canonical language tag", () => {
    for (const locale of ["EN", "en_US", "en-us", "english", "", " en"]) {
      expect(issues(policy({ translations: [{ ...EN, locale }] }))).toEqual([
        {
          code: "invalid-translation-locale",
          path: "purposes[0].translations[0].locale",
        },
      ]);
    }
    for (const locale of ["de", "de-AT", "zh-Hant-TW", "es-419", "gsw"]) {
      expect(issues(policy({ translations: [{ ...EN, locale }] }))).toEqual([]);
    }
  });

  it("refuse a repeated locale, and blank text", () => {
    expect(issues(policy({ translations: [EN, EN] }))).toEqual([
      {
        code: "duplicate-translation-locale",
        normalizedId: "en",
        path: "purposes[0].translations[1].locale",
      },
    ]);
    expect(
      issues(policy({ translations: [{ ...EN, disclosure: " ", label: "" }] })),
    ).toEqual([
      {
        code: "blank-purpose-disclosure",
        path: "purposes[0].translations[0].disclosure",
      },
      {
        code: "blank-purpose-label",
        path: "purposes[0].translations[0].label",
      },
    ]);
  });

  it("refuse a purpose that lacks a language the others have", () => {
    expect(
      issues(policy({ translations: [EN, FR] }, { translations: [EN] })),
    ).toEqual([
      {
        code: "incomplete-translations",
        normalizedId: "fr",
        path: "purposes[1].translations",
      },
    ]);
  });

  it("refuse entries that are not plain translations", () => {
    const getter = {
      get locale() {
        return "en";
      },
      disclosure: "Text.",
      label: "Label",
    };
    for (const translations of [
      "en",
      [null],
      [getter],
      [{ ...EN, disclosure: 1 }],
    ]) {
      expect(
        issues(
          policy({
            translations: translations as unknown as NonNullable<
              PolicyPurposeDefinition["translations"]
            >,
          }),
        ).length,
      ).toBeGreaterThan(0);
    }
  });
});
