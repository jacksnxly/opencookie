import { expect, it } from "vitest";

import { type DefinedPolicy, type PolicyDefinition } from "./index.js";

const completePurpose = {
  dataCategoryIds: ["usage-data"],
  disclosure: "Measure aggregate site usage.",
  id: "analytics",
  operationIds: ["aggregate-measurement"],
  providerIds: ["site-operator"],
  recipientIds: ["site-operator"],
  retentionIds: ["up-to-180-days"],
} as const;

it("requires complete optional-purpose disclosures in TypeScript", () => {
  const valid: PolicyDefinition = { purposes: [completePurpose] };

  const missingDisclosure: PolicyDefinition = {
    purposes: [
      // @ts-expect-error disclosure is required for every optional purpose
      {
        dataCategoryIds: ["usage-data"],
        id: "analytics",
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["up-to-180-days"],
      },
    ],
  };
  const missingProvider: PolicyDefinition = {
    purposes: [
      {
        ...completePurpose,
        // @ts-expect-error providerIds must contain at least one reference
        providerIds: [],
      },
    ],
  };
  const missingOperation: PolicyDefinition = {
    purposes: [
      {
        ...completePurpose,
        // @ts-expect-error operationIds must contain at least one reference
        operationIds: [],
      },
    ],
  };
  const missingRetention: PolicyDefinition = {
    purposes: [
      {
        ...completePurpose,
        // @ts-expect-error retentionIds must contain at least one reference
        retentionIds: [],
      },
    ],
  };
  const missingRecipient: PolicyDefinition = {
    purposes: [
      {
        ...completePurpose,
        // @ts-expect-error recipientIds must contain at least one reference
        recipientIds: [],
      },
    ],
  };
  const missingDataCategory: PolicyDefinition = {
    purposes: [
      {
        ...completePurpose,
        // @ts-expect-error dataCategoryIds must contain at least one reference
        dataCategoryIds: [],
      },
    ],
  };

  expect(valid.purposes).toEqual([completePurpose]);
  expect([
    missingDisclosure,
    missingProvider,
    missingOperation,
    missingRetention,
    missingRecipient,
    missingDataCategory,
  ]).toHaveLength(6);
});

it("keeps DefinedPolicy opaque to structural TypeScript construction", () => {
  const structural = {
    categories: [],
    dataCategories: [],
    operations: [],
    presentationRootCategoryIds: [],
    providers: [],
    purposes: [],
    recipients: [],
    retentions: [],
  };
  // @ts-expect-error DefinedPolicy is issued only by definePolicy
  const forged: DefinedPolicy = structural;

  expect(forged.purposes).toEqual([]);
});
