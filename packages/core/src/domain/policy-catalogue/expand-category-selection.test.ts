import { expect, it } from "vitest";

import { definePolicy, expandCategorySelection } from "./index.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";

it("expands a category DAG to unique purposes in stable order", () => {
  const result = definePolicy(
    completeTestPolicyDefinition({
      categories: [
        {
          categoryIds: ["left", "right"],
          id: "root",
          purposeIds: ["analytics"],
        },
        {
          categoryIds: ["leaf"],
          id: "left",
          purposeIds: ["personalization", "analytics"],
        },
        {
          categoryIds: ["leaf"],
          id: "right",
          purposeIds: ["ads"],
        },
        {
          id: "leaf",
          purposeIds: ["analytics"],
        },
      ],
      purposes: [{ id: "personalization" }, { id: "analytics" }, { id: "ads" }],
    }),
  );

  if (!result.ok) throw new Error("fixture policy must be valid");

  expect(expandCategorySelection(result.policy, ["root", "left"])).toEqual([
    "ads",
    "analytics",
    "personalization",
  ]);
  expect(expandCategorySelection(result.policy, ["missing"])).toEqual([]);
  expect(expandCategorySelection(result.policy, [" ROOT "])).toEqual([
    "ads",
    "analytics",
    "personalization",
  ]);
});
