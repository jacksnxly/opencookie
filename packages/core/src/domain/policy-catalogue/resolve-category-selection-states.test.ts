import { expect, it } from "vitest";

import type { DefinedPolicy } from "./define-policy.js";
import { definePolicy } from "./define-policy.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";
import { resolveCategorySelectionStates } from "./resolve-category-selection-states.js";

const identifier = (kind: "category" | "purpose", index: number): string =>
  `${kind}-${String(index).padStart(4, "0")}`;

function chainPolicy(length: number): DefinedPolicy {
  const result = definePolicy(
    completeTestPolicyDefinition({
      categories: Array.from({ length }, (_, index) => ({
        ...(index + 1 === length
          ? {}
          : { categoryIds: [identifier("category", index + 1)] }),
        id: identifier("category", index),
        purposeIds: [identifier("purpose", index)],
      })),
      presentationRootCategoryIds: [identifier("category", 0)],
      purposes: Array.from({ length }, (_, index) => ({
        id: identifier("purpose", index),
      })),
    }),
  );
  if (!result.ok) throw new Error("chain fixture must be valid");
  return result.policy;
}

function countedSelection(values: ReadonlySet<string>): {
  readonly probes: () => number;
  readonly selection: ReadonlySet<string>;
} {
  let probes = 0;
  const selection = new Proxy(values, {
    get(target, property) {
      if (property === "has") {
        return (value: string): boolean => {
          probes += 1;
          return target.has(value);
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function"
        ? (member.bind(target) as unknown)
        : member;
    },
  });
  return { probes: () => probes, selection };
}

function resolveInstrumentedChain(length: number): number {
  const policy = chainPolicy(length);
  const selected = new Set(
    policy.purposes.filter((_, index) => index % 2 === 0).map(({ id }) => id),
  );
  const counted = countedSelection(selected);
  const states = resolveCategorySelectionStates(policy, counted.selection);

  expect(states).toHaveLength(length);
  expect(states[0]).toEqual({
    categoryId: identifier("category", 0),
    checked: false,
    indeterminate: true,
  });
  expect(states.at(-1)).toEqual({
    categoryId: identifier("category", length - 1),
    checked: false,
    indeterminate: false,
  });
  expect(Object.isFrozen(states)).toBe(true);
  expect(states.every(Object.isFrozen)).toBe(true);
  expect(counted.probes()).toBeGreaterThanOrEqual(length);
  expect(counted.probes()).toBeLessThanOrEqual(length * 2);
  return counted.probes();
}

it("derives every category choice state in work linear to the policy DAG", () => {
  const small = resolveInstrumentedChain(128);
  const large = resolveInstrumentedChain(256);
  expect(large).toBeLessThanOrEqual(small * 2 + 2);
});

it("composes checked and indeterminate states across a shared-child diamond", () => {
  const result = definePolicy(
    completeTestPolicyDefinition({
      categories: [
        {
          categoryIds: ["left", "right"],
          id: "root",
          purposeIds: ["root-purpose"],
        },
        {
          categoryIds: ["leaf"],
          id: "left",
          purposeIds: ["left-purpose"],
        },
        {
          categoryIds: ["leaf"],
          id: "right",
          purposeIds: ["right-purpose"],
        },
        { id: "leaf", purposeIds: ["leaf-purpose"] },
      ],
      presentationRootCategoryIds: ["root"],
      purposes: [
        { id: "root-purpose" },
        { id: "left-purpose" },
        { id: "right-purpose" },
        { id: "leaf-purpose" },
      ],
    }),
  );
  if (!result.ok) throw new Error("diamond fixture must be valid");

  const states = resolveCategorySelectionStates(
    result.policy,
    new Set(["root-purpose", "left-purpose", "leaf-purpose", "unknown"]),
  );
  expect(
    Object.fromEntries(
      states.map(({ categoryId, ...state }) => [categoryId, state]),
    ),
  ).toEqual({
    leaf: { checked: true, indeterminate: false },
    left: { checked: true, indeterminate: false },
    right: { checked: false, indeterminate: true },
    root: { checked: false, indeterminate: true },
  });
  expect(Object.isFrozen(states)).toBe(true);
  expect(states.every(Object.isFrozen)).toBe(true);
});
