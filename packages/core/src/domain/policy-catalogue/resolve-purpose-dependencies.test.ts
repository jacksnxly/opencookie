import { expect, it } from "vitest";

import { definePolicy, resolvePurposeDependencies } from "./index.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";

it("resolves a stable dependency closure without changing decisions", () => {
  const result = definePolicy(
    completeTestPolicyDefinition({
      purposes: [
        { dependsOn: ["right", "left"], id: "top" },
        { dependsOn: ["base"], id: "left" },
        { dependsOn: ["base"], id: "right" },
        { id: "base" },
        { id: "unrelated" },
      ],
    }),
  );
  if (!result.ok) throw new Error("fixture policy must be valid");

  const decisions = Object.freeze({
    base: "denied" as const,
    top: "granted" as const,
    unrelated: "denied" as const,
  });
  const before = structuredClone(decisions);

  expect(resolvePurposeDependencies(result.policy, decisions)).toEqual([
    "base",
    "left",
    "right",
    "top",
  ]);
  expect(decisions).toEqual(before);
  expect(
    resolvePurposeDependencies(result.policy, { missing: "granted" }),
  ).toEqual([]);
});
