import { expect, it } from "vitest";

import type { DefinedPolicy } from "./define-policy.js";
import { definePolicy, resolvePurposeSelection } from "./index.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";

function diamondPolicy(): DefinedPolicy {
  const result = definePolicy(
    completeTestPolicyDefinition({
      purposes: [
        { dependsOn: ["left", "right"], id: "top" },
        { dependsOn: ["base"], id: "left" },
        { dependsOn: ["base"], id: "right" },
        { id: "base" },
        { id: "unrelated" },
      ],
    }),
  );
  if (!result.ok) throw new Error("diamond fixture must be valid");
  return result.policy;
}

it("completes and prunes a purpose selection across a shared dependency diamond", () => {
  const policy = diamondPolicy();

  const completed = resolvePurposeSelection(
    policy,
    ["top", "unknown"],
    "complete",
  );
  expect(completed).toEqual(["base", "left", "right", "top"]);
  expect(Object.isFrozen(completed)).toBe(true);

  const supported = resolvePurposeSelection(
    policy,
    ["unknown", "top", "left", "base"],
    "supported",
  );
  expect(supported).toEqual(["base", "left"]);
  expect(Object.isFrozen(supported)).toBe(true);
  expect(resolvePurposeSelection(policy, ["unknown"], "supported")).toEqual([]);
});

function fibonacciPolicy(length: number): DefinedPolicy {
  const result = definePolicy(
    completeTestPolicyDefinition({
      purposes: Array.from({ length }, (_, index) => ({
        ...(index === 0
          ? {}
          : {
              dependsOn:
                index === 1
                  ? ["purpose-0000"]
                  : [
                      `purpose-${String(index - 1).padStart(4, "0")}`,
                      `purpose-${String(index - 2).padStart(4, "0")}`,
                    ],
            }),
        id: `purpose-${String(index).padStart(4, "0")}`,
      })),
    }),
  );
  if (!result.ok) throw new Error("dependency fixture must be valid");
  return result.policy;
}

function countedDependencyReads(policy: DefinedPolicy): {
  readonly policy: DefinedPolicy;
  readonly reads: () => number;
} {
  let reads = 0;
  const purposes = policy.purposes.map(
    (purpose) =>
      new Proxy(purpose, {
        get(target, property, receiver) {
          if (property === "dependsOn") reads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
  );
  return {
    policy: { ...policy, purposes },
    reads: () => reads,
  };
}

function resolveInstrumentedGraph(length: number): number {
  const counted = countedDependencyReads(fibonacciPolicy(length));
  const topId = `purpose-${String(length - 1).padStart(4, "0")}`;
  const resolved = resolvePurposeSelection(counted.policy, [topId], "complete");

  expect(resolved).toHaveLength(length);
  expect(resolved[0]).toBe("purpose-0000");
  expect(resolved.at(-1)).toBe(topId);
  expect(counted.reads()).toBeGreaterThanOrEqual(length);
  expect(counted.reads()).toBeLessThanOrEqual(length * 2);
  return counted.reads();
}

it("resolves a shared dependency DAG in one memoized pass", () => {
  const small = resolveInstrumentedGraph(16);
  const large = resolveInstrumentedGraph(32);
  expect(large).toBeLessThanOrEqual(small * 2 + 2);
});
