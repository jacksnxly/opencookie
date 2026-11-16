import { describe, expect, it } from "vitest";

import { definePolicy, type PolicyReferenceDefinition } from "./index.js";
import {
  completeTestPolicyDefinition,
  type TestPolicyDefinition,
} from "./policy-test-fixtures.test-helper.js";

type IdentifierCollection =
  | "categories"
  | "dataCategories"
  | "operations"
  | "providers"
  | "purposes"
  | "recipients"
  | "retentions";

interface IdentifierCollectionCase {
  readonly blankCode: string;
  readonly collection: IdentifierCollection;
  readonly duplicateCode: string;
}

const identifierCollections: readonly IdentifierCollectionCase[] = [
  {
    blankCode: "blank-purpose-id",
    collection: "purposes",
    duplicateCode: "duplicate-purpose-id",
  },
  {
    blankCode: "blank-category-id",
    collection: "categories",
    duplicateCode: "duplicate-category-id",
  },
  {
    blankCode: "blank-data-category-id",
    collection: "dataCategories",
    duplicateCode: "duplicate-data-category-id",
  },
  {
    blankCode: "blank-operation-id",
    collection: "operations",
    duplicateCode: "duplicate-operation-id",
  },
  {
    blankCode: "blank-provider-id",
    collection: "providers",
    duplicateCode: "duplicate-provider-id",
  },
  {
    blankCode: "blank-recipient-id",
    collection: "recipients",
    duplicateCode: "duplicate-recipient-id",
  },
  {
    blankCode: "blank-retention-id",
    collection: "retentions",
    duplicateCode: "duplicate-retention-id",
  },
];

const disallowedIdentifierCases = [
  ["a leading C0 control", "\tanalytics"],
  ["an embedded C0 control", "ana\u0000lytics"],
  ["an embedded C1 control", "ana\u0085lytics"],
  ["an unpaired high surrogate", "ana\uD800lytics"],
  ["an unpaired low surrogate", "ana\uDC00lytics"],
  ["a leading byte order mark", "\uFEFFanalytics"],
  ["an embedded zero-width space", "ana\u200Blytics"],
  ["an embedded bidirectional override", "ana\u202Elytics"],
  ["an embedded variation selector", "ana\uFE0Flytics"],
  ["an embedded line separator", "ana\u2028lytics"],
  ["an embedded paragraph separator", "ana\u2029lytics"],
  ["a braille pattern blank", "\u2800"],
  ["an interlinear annotation anchor", "\uFFF9"],
  ["an interlinear annotation separator", "\uFFFA"],
  ["an interlinear annotation terminator", "\uFFFB"],
  ["an object replacement character", "\uFFFC"],
  ["an embedded zero-width non-joiner", "ana\u200Clytics"],
  ["a leading emoji joiner", "\u200Danalytics"],
  ["a trailing emoji joiner", "analytics\u200D"],
  ["a doubled emoji joiner", "team-👩\u200D\u200D💻"],
  ["a textual emoji joiner", "ana\u200Dlytics"],
  ["a compatibility emoji joiner", "™\u200D👩"],
  ["a pictographic copyright joiner", "pair-©\u200D👩"],
  ["an emoji joiner sequence", "team-👩\u200D💻"],
  ["a chained emoji joiner sequence", "family-👩\u200D👩\u200D👧\u200D👦"],
  ["separate emoji joiner sequences", "team-👩\u200D💻-🧑\u200D🔬"],
] as const;

function definitionWithIdentifiers(
  collection: IdentifierCollection,
  identifiers: readonly string[],
): TestPolicyDefinition {
  const entries: PolicyReferenceDefinition[] = identifiers.map((id) => ({
    id,
  }));

  switch (collection) {
    case "categories":
      return { categories: entries, purposes: [] };
    case "dataCategories":
      return { dataCategories: entries, purposes: [] };
    case "operations":
      return { operations: entries, purposes: [] };
    case "providers":
      return { providers: entries, purposes: [] };
    case "purposes":
      return { purposes: entries };
    case "recipients":
      return { purposes: [], recipients: entries };
    case "retentions":
      return { purposes: [], retentions: entries };
  }
}

describe("definePolicy catalogue entity identifiers", () => {
  it.each(identifierCollections)(
    "rejects a $collection identifier that is blank after normalization",
    ({ blankCode, collection }) => {
      expect(
        definePolicy(
          completeTestPolicyDefinition(
            definitionWithIdentifiers(collection, ["\u3000\t"]),
          ),
        ),
      ).toEqual({
        issues: [
          {
            code: blankCode,
            path: `${collection}[0].id`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(identifierCollections)(
    "rejects a wholly default-ignorable $collection identifier",
    ({ blankCode, collection }) => {
      expect(
        definePolicy(
          completeTestPolicyDefinition(
            definitionWithIdentifiers(collection, ["\u200B\u2060\u200D"]),
          ),
        ),
      ).toEqual({
        issues: [
          {
            code: blankCode,
            path: `${collection}[0].id`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(identifierCollections)(
    "rejects a C0 control-only $collection identifier",
    ({ blankCode, collection }) => {
      expect(
        definePolicy(
          completeTestPolicyDefinition(
            definitionWithIdentifiers(collection, ["\u0000"]),
          ),
        ),
      ).toEqual({
        issues: [
          {
            code: blankCode,
            path: `${collection}[0].id`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(disallowedIdentifierCases)(
    "rejects a category identifier containing %s",
    (_case, id) => {
      expect(
        definePolicy(
          completeTestPolicyDefinition(
            definitionWithIdentifiers("categories", [id]),
          ),
        ),
      ).toEqual({
        issues: [
          {
            code: "blank-category-id",
            path: "categories[0].id",
          },
        ],
        ok: false,
      });
    },
  );

  it("returns a structured issue for a very long invalid identifier", () => {
    const id = `${"👩\u200D💻-".repeat(1_000_000)}\u200B`;

    const result = definePolicy(
      completeTestPolicyDefinition(
        definitionWithIdentifiers("categories", [id]),
      ),
    );
    if (result.ok) throw new Error("the invalid identifier was accepted");

    expect(result.issues).toEqual([
      {
        code: "blank-category-id",
        path: "categories[0].id",
      },
    ]);
  });

  it.each(["team-👩💻", "pair-©👩"] as const)(
    "preserves a visible unjoined pictographic identifier %s",
    (id) => {
      const result = definePolicy(
        completeTestPolicyDefinition({
          categories: [{ id }],
          presentationRootCategoryIds: [id],
          purposes: [],
        }),
      );
      if (!result.ok)
        throw new Error("visible Unicode identifier must remain valid");

      expect(result.policy.categories[0]?.id).toBe(id);
      expect(result.policy.presentationRootCategoryIds).toEqual([id]);
    },
  );

  it.each(identifierCollections)(
    "rejects normalized duplicate $collection identifiers regardless of input order",
    ({ collection, duplicateCode }) => {
      const expected = {
        issues: [
          {
            code: duplicateCode,
            normalizedId: "analytics",
            path: `${collection}[1].id`,
          },
        ],
        ok: false,
      };

      expect(
        definePolicy(
          completeTestPolicyDefinition(
            definitionWithIdentifiers(collection, [" Analytics ", "ANALYTICS"]),
          ),
        ),
      ).toEqual(expected);
      expect(
        definePolicy(
          completeTestPolicyDefinition(
            definitionWithIdentifiers(collection, ["ANALYTICS", " Analytics "]),
          ),
        ),
      ).toEqual(expected);
    },
  );

  it.each(identifierCollections)(
    "rejects recomposed duplicate $collection identifiers",
    ({ collection, duplicateCode }) => {
      expect(
        definePolicy(
          completeTestPolicyDefinition(
            definitionWithIdentifiers(collection, ["J\u030C", "ǰ"]),
          ),
        ),
      ).toEqual({
        issues: [
          {
            code: duplicateCode,
            normalizedId: "ǰ",
            path: `${collection}[1].id`,
          },
        ],
        ok: false,
      });
    },
  );

  it("rejects duplicate category identities before graph construction can depend on their order", () => {
    const expected = {
      issues: [
        {
          code: "duplicate-category-id",
          normalizedId: "root",
          path: "categories[1].id",
        },
      ],
      ok: false,
    };
    const visibleCategory = { id: "root", purposeIds: ["visible"] };
    const emptyCategory = { id: " ROOT " };

    expect(
      definePolicy(
        completeTestPolicyDefinition({
          categories: [visibleCategory, emptyCategory],
          presentationRootCategoryIds: ["root"],
          purposes: [{ id: "visible" }],
        }),
      ),
    ).toEqual(expected);
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          categories: [emptyCategory, visibleCategory],
          presentationRootCategoryIds: ["root"],
          purposes: [{ id: "visible" }],
        }),
      ),
    ).toEqual(expected);
  });

  it("reports invalid entity identifiers in stable catalogue order", () => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          categories: [{ id: "" }],
          dataCategories: [{ id: "" }],
          operations: [{ id: "" }],
          providers: [{ id: "" }],
          purposes: [{ id: "" }],
          recipients: [{ id: "" }],
          retentions: [{ id: "" }],
        }),
      ),
    ).toEqual({
      issues: [
        { code: "blank-purpose-id", path: "purposes[0].id" },
        {
          code: "invalid-purpose-data-category-reference",
          path: "purposes[0].dataCategoryIds[0]",
        },
        {
          code: "invalid-purpose-operation-reference",
          path: "purposes[0].operationIds[0]",
        },
        {
          code: "invalid-purpose-provider-reference",
          path: "purposes[0].providerIds[0]",
        },
        {
          code: "invalid-purpose-recipient-reference",
          path: "purposes[0].recipientIds[0]",
        },
        {
          code: "invalid-purpose-retention-reference",
          path: "purposes[0].retentionIds[0]",
        },
        { code: "blank-category-id", path: "categories[0].id" },
        {
          code: "blank-data-category-id",
          path: "dataCategories[0].id",
        },
        { code: "blank-operation-id", path: "operations[0].id" },
        { code: "blank-provider-id", path: "providers[0].id" },
        { code: "blank-recipient-id", path: "recipients[0].id" },
        { code: "blank-retention-id", path: "retentions[0].id" },
      ],
      ok: false,
    });
  });
});
