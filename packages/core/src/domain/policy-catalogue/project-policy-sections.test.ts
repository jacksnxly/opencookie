import { expect, it } from "vitest";

import { definePolicy, projectPolicySections } from "./index.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";

it("projects category roots depth first in the authored order with first-visited ownership", () => {
  const result = definePolicy(
    completeTestPolicyDefinition({
      categories: [
        {
          categoryIds: ["nested", "diamond"],
          id: "a-root",
          purposeIds: ["shared", "alpha"],
        },
        {
          id: "diamond",
          purposeIds: ["shared", "diamond-purpose"],
        },
        {
          categoryIds: ["leaf"],
          id: "nested",
          purposeIds: ["nested-purpose"],
        },
        { id: "leaf", purposeIds: ["leaf-purpose"] },
        {
          categoryIds: ["diamond"],
          id: "z-root",
          purposeIds: ["zeta", "shared"],
        },
      ],
      presentationRootCategoryIds: ["z-root", "a-root"],
      purposes: [
        { id: "zeta" },
        { id: "shared" },
        { id: "nested-purpose" },
        { id: "leaf-purpose" },
        { id: "diamond-purpose" },
        { id: "alpha" },
      ],
    }),
  );

  if (!result.ok) throw new Error("fixture policy must be valid");

  const sections = projectPolicySections(result.policy);
  expect(sections).toEqual([
    { categoryId: "z-root", purposeIds: ["zeta", "shared"] },
    { categoryId: "diamond", purposeIds: ["diamond-purpose"] },
    { categoryId: "a-root", purposeIds: ["alpha"] },
    { categoryId: "nested", purposeIds: ["nested-purpose"] },
    { categoryId: "leaf", purposeIds: ["leaf-purpose"] },
  ]);
  expect(Object.isFrozen(sections)).toBe(true);
  expect(sections.every(Object.isFrozen)).toBe(true);
  expect(sections.every(({ purposeIds }) => Object.isFrozen(purposeIds))).toBe(
    true,
  );
});

it("returns one immutable flat section when presentation roots are empty", () => {
  const result = definePolicy(
    completeTestPolicyDefinition({
      purposes: [{ id: "zeta" }, { id: "alpha" }],
    }),
  );

  if (!result.ok) throw new Error("fixture policy must be valid");

  expect(projectPolicySections(result.policy)).toEqual([
    { categoryId: null, purposeIds: ["alpha", "zeta"] },
  ]);
});

it("places purposes outside the visited category graph in a trailing section", () => {
  const result = definePolicy(
    completeTestPolicyDefinition({
      categories: [{ id: "root", purposeIds: ["grouped"] }],
      presentationRootCategoryIds: ["root"],
      purposes: [{ id: "grouped" }, { id: "ungrouped" }],
    }),
  );

  if (!result.ok) throw new Error("fixture policy must be valid");

  expect(projectPolicySections(result.policy)).toEqual([
    { categoryId: "root", purposeIds: ["grouped"] },
    { categoryId: null, purposeIds: ["ungrouped"] },
  ]);
});
