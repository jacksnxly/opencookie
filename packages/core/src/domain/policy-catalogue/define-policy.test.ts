import { describe, expect, it } from "vitest";

import { definePolicy } from "./index.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";

describe("definePolicy purpose identifiers", () => {
  it("rejects normalized duplicate purpose identifiers with a stable path", () => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          purposes: [{ id: " analytics " }, { id: "ANALYTICS" }],
        }),
      ),
    ).toEqual({
      issues: [
        {
          code: "duplicate-purpose-id",
          normalizedId: "analytics",
          path: "purposes[1].id",
        },
      ],
      ok: false,
    });
  });

  it("rejects an identifier that is blank after normalization", () => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({ purposes: [{ id: " \t " }] }),
      ),
    ).toEqual({
      issues: [
        {
          code: "blank-purpose-id",
          path: "purposes[0].id",
        },
      ],
      ok: false,
    });
  });
});

describe("definePolicy category graph", () => {
  it("rejects a category cycle at the closing edge", () => {
    expect(
      definePolicy({
        categories: [
          { categoryIds: ["b"], id: "a" },
          { categoryIds: ["a"], id: "b" },
        ],
        purposes: [],
      }),
    ).toEqual({
      issues: [
        {
          code: "category-cycle",
          cycle: ["a", "b", "a"],
          path: "categories[1].categoryIds[0]",
        },
      ],
      ok: false,
    });
  });

  it("rejects self-cycles and unknown category references", () => {
    expect(
      definePolicy({
        categories: [
          { categoryIds: ["self"], id: "self" },
          { categoryIds: ["missing"], id: "parent" },
        ],
        purposes: [],
      }),
    ).toEqual({
      issues: [
        {
          code: "unknown-category-reference",
          normalizedId: "missing",
          path: "categories[1].categoryIds[0]",
        },
        {
          code: "category-cycle",
          cycle: ["self", "self"],
          path: "categories[0].categoryIds[0]",
        },
      ],
      ok: false,
    });
  });

  it("accepts a diamond-shaped category DAG", () => {
    const result = definePolicy({
      categories: [
        { categoryIds: ["left", "right"], id: "root" },
        { categoryIds: ["leaf"], id: "left" },
        { categoryIds: ["leaf"], id: "right" },
        { categoryIds: [], id: "leaf" },
      ],
      purposes: [],
    });

    expect(result.ok).toBe(true);
  });
});

describe("definePolicy purpose dependency graph", () => {
  it("rejects a purpose dependency cycle at the closing edge", () => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          purposes: [
            { dependsOn: ["b"], id: "a" },
            { dependsOn: ["a"], id: "b" },
          ],
        }),
      ),
    ).toEqual({
      issues: [
        {
          code: "purpose-dependency-cycle",
          cycle: ["a", "b", "a"],
          path: "purposes[1].dependsOn[0]",
        },
      ],
      ok: false,
    });
  });

  it("rejects self-cycles, unknown prerequisites, and duplicate edges", () => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          purposes: [
            { dependsOn: ["self"], id: "self" },
            { dependsOn: ["missing"], id: "analytics" },
            { dependsOn: ["analytics", " ANALYTICS "], id: "ads" },
          ],
        }),
      ),
    ).toEqual({
      issues: [
        {
          code: "unknown-purpose-dependency",
          normalizedId: "missing",
          path: "purposes[1].dependsOn[0]",
        },
        {
          code: "duplicate-purpose-dependency",
          normalizedId: "analytics",
          path: "purposes[2].dependsOn[1]",
        },
        {
          code: "purpose-dependency-cycle",
          cycle: ["self", "self"],
          path: "purposes[0].dependsOn[0]",
        },
      ],
      ok: false,
    });
  });

  it("accepts a diamond-shaped purpose dependency DAG", () => {
    const result = definePolicy(
      completeTestPolicyDefinition({
        purposes: [
          { dependsOn: ["left", "right"], id: "top" },
          { dependsOn: ["base"], id: "left" },
          { dependsOn: ["base"], id: "right" },
          { id: "base" },
        ],
      }),
    );

    expect(result.ok).toBe(true);
  });
});
