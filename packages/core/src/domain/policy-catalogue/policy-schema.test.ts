import { describe, expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  type DefinedPolicy,
  type PolicyDefinition,
} from "./index.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";

const purposeReferenceCases = [
  ["providerIds", "provider", "test-service-provider"],
  ["operationIds", "operation", "test-processing-operation"],
  ["retentionIds", "retention", "test-retention-period"],
  ["recipientIds", "recipient", "test-site-operator"],
  ["dataCategoryIds", "data-category", "test-usage-data"],
] as const;

const policyCollectionCases = [
  "purposes",
  "categories",
  "providers",
  "operations",
  "retentions",
  "recipients",
  "dataCategories",
] as const;

const OVER_POLICY_GRAPH_BUDGET = 10_001;

const scalarIdentityCases = [
  ["purpose", "blank-purpose-id", "purposes[0].id", "purposes"],
  ["category", "blank-category-id", "categories[0].id", "categories"],
  ["provider", "blank-provider-id", "providers[0].id", "providers"],
  ["operation", "blank-operation-id", "operations[0].id", "operations"],
  ["retention", "blank-retention-id", "retentions[0].id", "retentions"],
  ["recipient", "blank-recipient-id", "recipients[0].id", "recipients"],
  [
    "data category",
    "blank-data-category-id",
    "dataCategories[0].id",
    "dataCategories",
  ],
] as const;

function policyWithReference(
  field: (typeof purposeReferenceCases)[number][0],
  value: unknown,
): PolicyDefinition {
  return completeTestPolicyDefinition({
    purposes: [{ [field]: value, id: "analytics" }],
  });
}

function policyWithCollection(
  field: (typeof policyCollectionCases)[number],
  value: unknown,
): PolicyDefinition {
  return {
    ...completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
    [field]: value,
  };
}

function arrayWithInheritedEntry<T>(entry: T): T[] {
  const values = new Array<T>(1);
  Object.setPrototypeOf(
    values,
    Object.assign(Object.create(Array.prototype) as object, { 0: entry }),
  );
  return values;
}

const nestedCollectionCases = [
  [
    "purpose dependency",
    "purposes[0].dependsOn[0]",
    (value: unknown) =>
      completeTestPolicyDefinition({
        purposes: [{ dependsOn: value, id: "analytics" } as never],
      }),
  ],
  [
    "category child",
    "categories[0].categoryIds[0]",
    (value: unknown) =>
      completeTestPolicyDefinition({
        categories: [{ categoryIds: value, id: "root" } as never],
        purposes: [{ id: "analytics" }],
      }),
  ],
  [
    "category purpose",
    "categories[0].purposeIds[0]",
    (value: unknown) =>
      completeTestPolicyDefinition({
        categories: [{ id: "root", purposeIds: value } as never],
        purposes: [{ id: "analytics" }],
      }),
  ],
  [
    "presentation root",
    "presentationRootCategoryIds[0]",
    (value: unknown) =>
      completeTestPolicyDefinition({
        presentationRootCategoryIds: value as never,
        purposes: [{ id: "analytics" }],
      }),
  ],
] as const;

describe("policy publication schema", () => {
  it("rejects null and undefined policy roots without leaking runtime errors", () => {
    for (const definition of [null, undefined]) {
      expect(definePolicy(definition as unknown as PolicyDefinition)).toEqual({
        issues: [{ code: "invalid-policy-definition-entry", path: "$" }],
        ok: false,
      });
    }
  });

  it("does not delegate purpose publication to a caller-owned map method", () => {
    const definition = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const purposes = [{ id: "analytics" }] as unknown as Array<
      (typeof definition.purposes)[number]
    >;
    Object.defineProperty(purposes, "map", {
      value: () => [],
    });

    expect(definePolicy({ ...definition, purposes })).toEqual({
      issues: [
        {
          code: "blank-purpose-disclosure",
          path: "purposes[0].disclosure",
        },
        {
          code: "missing-purpose-provider-reference",
          path: "purposes[0].providerIds",
        },
        {
          code: "missing-purpose-operation-reference",
          path: "purposes[0].operationIds",
        },
        {
          code: "missing-purpose-retention-reference",
          path: "purposes[0].retentionIds",
        },
        {
          code: "missing-purpose-recipient-reference",
          path: "purposes[0].recipientIds",
        },
        {
          code: "missing-purpose-data-category-reference",
          path: "purposes[0].dataCategoryIds",
        },
      ],
      ok: false,
    });
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "rejects a Proxy-controlled %s collection length without throwing",
    (_label, length) => {
      const definition = completeTestPolicyDefinition({
        purposes: [{ id: "analytics" }],
      });
      const purposes = new Proxy(definition.purposes, {
        getOwnPropertyDescriptor: (target, property) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          return property === "length" && descriptor !== undefined
            ? { ...descriptor, value: length }
            : descriptor;
        },
      });

      let result: ReturnType<typeof definePolicy> | undefined;
      expect(() => {
        result = definePolicy({ ...definition, purposes });
      }).not.toThrow();
      expect(result).toEqual({
        issues: [{ code: "invalid-policy-definition-entry", path: "purposes" }],
        ok: false,
      });
    },
  );

  it("rejects an object-valued collection length without coercing or aliasing it", () => {
    const definition = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const sourcePurpose = definition.purposes[0];
    if (sourcePurpose === undefined) throw new Error("fixture purpose missing");
    let coercions = 0;
    let editorialReads = 0;
    const purpose = {
      ...sourcePurpose,
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        return 0;
      },
    };
    Object.defineProperty(purpose, "editorialNote", {
      enumerable: true,
      get: () => {
        editorialReads += 1;
        return "caller-controlled";
      },
    });
    const purposes = new Proxy([purpose], {
      getOwnPropertyDescriptor: (target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        return property === "length" && descriptor !== undefined
          ? { ...descriptor, value: purpose }
          : descriptor;
      },
    });

    let result: ReturnType<typeof definePolicy> | undefined;
    expect(() => {
      result = definePolicy({ ...definition, purposes });
    }).not.toThrow();
    expect(result).toEqual({
      issues: [{ code: "invalid-policy-definition-entry", path: "purposes" }],
      ok: false,
    });
    expect({ coercions, editorialReads }).toEqual({
      coercions: 0,
      editorialReads: 0,
    });
  });

  it("rejects a direct sparse collection before traversing its oversized graph", () => {
    const definition = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const purposes = new Array<(typeof definition.purposes)[number]>(
      OVER_POLICY_GRAPH_BUDGET,
    );

    const result = definePolicy({ ...definition, purposes });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("oversized policy unexpectedly valid");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      code: "invalid-policy-definition-entry",
      path: "purposes",
    });
  });

  it("rejects a Proxy-controlled oversized collection before indexed traps", () => {
    const result = definePolicy(
      completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
    );
    if (!result.ok) throw new Error("fixture policy invalid");
    let indexedDescriptorReads = 0;
    const purposes = new Proxy([...result.policy.purposes], {
      getOwnPropertyDescriptor: (target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (property === "length" && descriptor !== undefined) {
          return { ...descriptor, value: OVER_POLICY_GRAPH_BUDGET };
        }
        indexedDescriptorReads += 1;
        return descriptor;
      },
    });
    expect(() =>
      createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: { ...result.policy, purposes },
        policyVersion: "policy-1",
      }),
    ).toThrow("Invalid defined policy.");
    expect(indexedDescriptorReads).toBe(0);
  });

  it("applies one capture budget across separate policy collections", () => {
    const definition = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const categories = new Array<
      NonNullable<PolicyDefinition["categories"]>[number]
    >(6_000);
    const providers = new Array<
      NonNullable<PolicyDefinition["providers"]>[number]
    >(5_000);

    const result = definePolicy({ ...definition, categories, providers });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("oversized policy unexpectedly valid");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      code: "invalid-policy-definition-entry",
      path: "providers",
    });
  });

  it("fails a forged policy closed when its collection length is not numeric", () => {
    const definition = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const result = definePolicy(definition);
    if (!result.ok) throw new Error("fixture policy invalid");
    const purposes = new Proxy([...result.policy.purposes], {
      getOwnPropertyDescriptor: (target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        return property === "length" && descriptor !== undefined
          ? { ...descriptor, value: Symbol("hostile-length") }
          : descriptor;
      },
    });
    const forged = { ...result.policy, purposes } as unknown as DefinedPolicy;
    expect(() =>
      createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: forged,
        policyVersion: "policy-1",
      }),
    ).toThrow("Invalid defined policy.");
  });

  it("rejects accessor-backed policy roots without invoking them", () => {
    const complete = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    let purposesReads = 0;
    const definition = { ...complete };
    Object.defineProperty(definition, "purposes", {
      enumerable: true,
      get: () => {
        purposesReads += 1;
        return complete.purposes;
      },
    });

    expect(definePolicy(definition)).toEqual({
      issues: [{ code: "invalid-policy-definition-entry", path: "purposes" }],
      ok: false,
    });
    expect(purposesReads).toBe(0);
  });

  it("rejects changing presentation accessors before canonical hashing", () => {
    const complete = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const sourcePurpose = complete.purposes[0];
    if (sourcePurpose === undefined) throw new Error("fixture purpose missing");
    let disclosureReads = 0;
    let labelReads = 0;
    const purpose = { ...sourcePurpose };
    Object.defineProperties(purpose, {
      disclosure: {
        enumerable: true,
        get: () =>
          ++disclosureReads === 1
            ? "Validated disclosure"
            : "Changed disclosure",
      },
      label: {
        enumerable: true,
        get: () => (++labelReads === 1 ? "Validated label" : "Changed label"),
      },
    });
    const forged = {
      ...complete,
      purposes: [purpose],
    } as unknown as DefinedPolicy;

    expect(definePolicy(forged as unknown as PolicyDefinition)).toEqual({
      issues: [
        {
          code: "invalid-policy-definition-entry",
          path: "purposes[0].disclosure",
        },
        {
          code: "invalid-policy-definition-entry",
          path: "purposes[0].label",
        },
      ],
      ok: false,
    });
    expect(() =>
      createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: forged,
        policyVersion: "policy-1",
      }),
    ).toThrow("Invalid defined policy");
    expect({ disclosureReads, labelReads }).toEqual({
      disclosureReads: 0,
      labelReads: 0,
    });
  });

  it("rejects an inherited required purpose field", () => {
    const complete = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const sourcePurpose = complete.purposes[0];
    if (sourcePurpose === undefined) throw new Error("fixture purpose missing");
    const { id: inheritedId, ...ownFields } = sourcePurpose;
    expect(inheritedId).toBe("analytics");
    const purpose = Object.assign(
      Object.create({ id: "analytics" }) as object,
      ownFields,
    );

    expect(
      definePolicy({
        ...complete,
        purposes: [purpose],
      } as unknown as PolicyDefinition),
    ).toEqual({
      issues: [
        {
          code: "invalid-policy-definition-entry",
          path: "purposes[0].id",
        },
      ],
      ok: false,
    });
  });

  it("reports a throwing presentation accessor without leaking its error", () => {
    const complete = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const sourcePurpose = complete.purposes[0];
    if (sourcePurpose === undefined) throw new Error("fixture purpose missing");
    const purpose = { ...sourcePurpose };
    Object.defineProperty(purpose, "disclosure", {
      enumerable: true,
      get: () => {
        throw new Error("caller accessor escaped");
      },
    });

    let result: ReturnType<typeof definePolicy> | undefined;
    expect(() => {
      result = definePolicy({ ...complete, purposes: [purpose] });
    }).not.toThrow();
    expect(result).toEqual({
      issues: [
        {
          code: "invalid-policy-definition-entry",
          path: "purposes[0].disclosure",
        },
      ],
      ok: false,
    });
  });

  it.each(scalarIdentityCases)(
    "rejects missing and non-string %s identifiers without throwing",
    (_name, code, path, field) => {
      for (const id of [undefined, 42]) {
        const definition = completeTestPolicyDefinition({
          purposes: [{ id: "analytics" }],
        });
        const entry =
          field === "purposes" ? { ...definition.purposes[0], id } : { id };

        expect(
          definePolicy({
            ...definition,
            [field]: [entry],
          }),
        ).toEqual({ issues: [{ code, path }], ok: false });
      }
    },
  );

  it.each([
    ["disclosure", "blank-purpose-disclosure"],
    ["label", "blank-purpose-label"],
  ] as const)("rejects non-string purpose %s text", (field, code) => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          purposes: [{ [field]: 42, id: "analytics" }],
        }),
      ),
    ).toEqual({
      issues: [{ code, path: `purposes[0].${field}` }],
      ok: false,
    });
  });

  it("rejects a non-string editorial note instead of publishing it", () => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          purposes: [
            { editorialNote: { unsafe: true }, id: "analytics" } as never,
          ],
        }),
      ),
    ).toEqual({
      issues: [
        {
          code: "invalid-policy-definition-entry",
          path: "purposes[0].editorialNote",
        },
      ],
      ok: false,
    });
  });

  it.each(policyCollectionCases)(
    "rejects a sparse %s collection without publishing a null entry",
    (field) => {
      const result = definePolicy(
        policyWithCollection(field, new Array<never>(1)),
      );

      expect(result).toEqual({
        issues: [
          {
            code: "invalid-policy-definition-entry",
            path: `${field}[0]`,
          },
        ],
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain("[null]");
    },
  );

  it("rejects a prototype-backed sparse purpose collection", () => {
    const definition = completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }],
    });
    const purpose = definition.purposes[0];
    if (purpose === undefined)
      throw new Error("Test purpose fixture is empty.");
    const purposes = arrayWithInheritedEntry(purpose);

    expect(Object.hasOwn(purposes, 0)).toBe(false);
    expect(definePolicy({ ...definition, purposes })).toEqual({
      issues: [
        { code: "invalid-policy-definition-entry", path: "purposes[0]" },
      ],
      ok: false,
    });
  });

  it.each(policyCollectionCases)(
    "rejects a non-object %s collection entry with its stable path",
    (field) => {
      expect(definePolicy(policyWithCollection(field, [42]))).toEqual({
        issues: [
          {
            code: "invalid-policy-definition-entry",
            path: `${field}[0]`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(nestedCollectionCases)(
    "rejects sparse and non-string %s collections without publishing null",
    (_name, path, createDefinition) => {
      for (const value of [new Array<string>(1), [42]]) {
        const result = definePolicy(createDefinition(value));
        expect(result).toEqual({
          issues: [{ code: "invalid-policy-definition-entry", path }],
          ok: false,
        });
        expect(JSON.stringify(result)).not.toContain("[null]");
      }
    },
  );

  it.each(nestedCollectionCases)(
    "rejects a disallowed machine identifier in a %s collection",
    (_name, path, createDefinition) => {
      expect(definePolicy(createDefinition(["ana\u200Blytics"]))).toEqual({
        issues: [{ code: "invalid-policy-definition-entry", path }],
        ok: false,
      });
    },
  );

  it.each([
    [
      "category child",
      "categories[0].categoryIds[1]",
      completeTestPolicyDefinition({
        categories: [
          { categoryIds: ["child", " CHILD "], id: "root" },
          { id: "child" },
        ],
        purposes: [],
      }),
    ],
    [
      "category purpose",
      "categories[0].purposeIds[1]",
      completeTestPolicyDefinition({
        categories: [{ id: "root", purposeIds: ["analytics", " ANALYTICS "] }],
        purposes: [{ id: "analytics" }],
      }),
    ],
    [
      "presentation root",
      "presentationRootCategoryIds[1]",
      completeTestPolicyDefinition({
        categories: [{ id: "root" }],
        presentationRootCategoryIds: ["root", " ROOT "],
        purposes: [],
      }),
    ],
  ] as const)(
    "rejects a normalized duplicate %s with its stable path",
    (_name, path, definition) => {
      expect(definePolicy(definition)).toEqual({
        issues: [{ code: "invalid-policy-definition-entry", path }],
        ok: false,
      });
    },
  );

  it.each(purposeReferenceCases)(
    "rejects a sparse %s list without publishing a null reference",
    (field, reference) => {
      const result = definePolicy(
        policyWithReference(field, new Array<string>(1)),
      );

      expect(result).toEqual({
        issues: [
          {
            code: `invalid-purpose-${reference}-reference`,
            path: `purposes[0].${field}[0]`,
          },
        ],
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain("[null]");
    },
  );

  it.each(purposeReferenceCases)(
    "rejects a prototype-backed sparse %s list",
    (field, reference, identifier) => {
      const values = arrayWithInheritedEntry(identifier);

      expect(Object.hasOwn(values, 0)).toBe(false);
      expect(definePolicy(policyWithReference(field, values))).toEqual({
        issues: [
          {
            code: `invalid-purpose-${reference}-reference`,
            path: `purposes[0].${field}[0]`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(purposeReferenceCases)(
    "rejects a non-string %s entry with its stable path",
    (field, reference) => {
      expect(definePolicy(policyWithReference(field, [42]))).toEqual({
        issues: [
          {
            code: `invalid-purpose-${reference}-reference`,
            path: `purposes[0].${field}[0]`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(purposeReferenceCases)(
    "rejects a blank normalized %s entry with its stable path",
    (field, reference) => {
      expect(definePolicy(policyWithReference(field, [" \t "]))).toEqual({
        issues: [
          {
            code: `invalid-purpose-${reference}-reference`,
            path: `purposes[0].${field}[0]`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(purposeReferenceCases)(
    "rejects a disallowed machine identifier in a %s entry",
    (field, reference) => {
      expect(
        definePolicy(policyWithReference(field, ["ana\u200Blytics"])),
      ).toEqual({
        issues: [
          {
            code: `invalid-purpose-${reference}-reference`,
            path: `purposes[0].${field}[0]`,
          },
        ],
        ok: false,
      });
    },
  );

  it.each(purposeReferenceCases)(
    "rejects a normalized duplicate %s entry with its stable path",
    (field, reference, identifier) => {
      expect(
        definePolicy(
          policyWithReference(field, [
            ` ${identifier.toUpperCase()} `,
            identifier,
          ]),
        ),
      ).toEqual({
        issues: [
          {
            code: `duplicate-purpose-${reference}-reference`,
            normalizedId: identifier,
            path: `purposes[0].${field}[1]`,
          },
        ],
        ok: false,
      });
    },
  );

  it("rejects disclosure text made only from default-ignorable code points", () => {
    expect(
      definePolicy(
        completeTestPolicyDefinition({
          purposes: [{ disclosure: "\u200B\u2060\u200D", id: "analytics" }],
        }),
      ),
    ).toEqual({
      issues: [
        {
          code: "blank-purpose-disclosure",
          path: "purposes[0].disclosure",
        },
      ],
      ok: false,
    });
  });

  it.each(["\u2800", "\uFFF9\uFFFA\uFFFB", "\uFFFC"])(
    "rejects purpose copy made only from a browser-proven blank sequence %#",
    (copy) => {
      expect(
        definePolicy(
          completeTestPolicyDefinition({
            purposes: [{ disclosure: copy, id: "analytics", label: copy }],
          }),
        ),
      ).toEqual({
        issues: [
          {
            code: "blank-purpose-disclosure",
            path: "purposes[0].disclosure",
          },
          { code: "blank-purpose-label", path: "purposes[0].label" },
        ],
        ok: false,
      });
    },
  );

  it("preserves visible Unicode and meaningful internal joiners", () => {
    const disclosure = "Support 👩‍💻 analytics";
    const result = definePolicy(
      completeTestPolicyDefinition({
        purposes: [{ disclosure, id: "analytics" }],
      }),
    );
    if (!result.ok) throw new Error("visible Unicode must remain valid");

    expect(result.policy.purposes[0]?.disclosure).toBe(disclosure);
  });

  it("rejects every incomplete optional-purpose disclosure field with a stable path", () => {
    expect(
      definePolicy({
        purposes: [
          {
            dataCategoryIds: [],
            disclosure: " \t\u3000 ",
            id: "analytics",
            operationIds: [],
            providerIds: [],
            recipientIds: [],
            retentionIds: [],
          },
        ],
      } as unknown as PolicyDefinition),
    ).toEqual({
      issues: [
        {
          code: "blank-purpose-disclosure",
          path: "purposes[0].disclosure",
        },
        {
          code: "missing-purpose-provider-reference",
          path: "purposes[0].providerIds",
        },
        {
          code: "missing-purpose-operation-reference",
          path: "purposes[0].operationIds",
        },
        {
          code: "missing-purpose-retention-reference",
          path: "purposes[0].retentionIds",
        },
        {
          code: "missing-purpose-recipient-reference",
          path: "purposes[0].recipientIds",
        },
        {
          code: "missing-purpose-data-category-reference",
          path: "purposes[0].dataCategoryIds",
        },
      ],
      ok: false,
    });
  });

  it("does not publish a JavaScript caller's omitted optional-purpose disclosure fields", () => {
    expect(
      definePolicy({
        purposes: [{ id: "analytics" }],
      } as unknown as PolicyDefinition),
    ).toEqual({
      issues: [
        {
          code: "blank-purpose-disclosure",
          path: "purposes[0].disclosure",
        },
        {
          code: "missing-purpose-provider-reference",
          path: "purposes[0].providerIds",
        },
        {
          code: "missing-purpose-operation-reference",
          path: "purposes[0].operationIds",
        },
        {
          code: "missing-purpose-retention-reference",
          path: "purposes[0].retentionIds",
        },
        {
          code: "missing-purpose-recipient-reference",
          path: "purposes[0].recipientIds",
        },
        {
          code: "missing-purpose-data-category-reference",
          path: "purposes[0].dataCategoryIds",
        },
      ],
      ok: false,
    });
  });

  it("rejects unresolved presentation category and purpose references", () => {
    expect(
      definePolicy({
        categories: [{ id: "root", purposeIds: ["missing-purpose"] }],
        presentationRootCategoryIds: ["missing-root"],
        purposes: [],
      }),
    ).toEqual({
      issues: [
        {
          code: "unknown-category-purpose-reference",
          normalizedId: "missing-purpose",
          path: "categories[0].purposeIds[0]",
        },
        {
          code: "unknown-presentation-root-category-reference",
          normalizedId: "missing-root",
          path: "presentationRootCategoryIds[0]",
        },
      ],
      ok: false,
    });
  });

  it("retains an optional purpose outside the presentation roots", () => {
    const result = definePolicy(
      completeTestPolicyDefinition({
        categories: [{ id: "visible", purposeIds: ["visible"] }],
        presentationRootCategoryIds: ["visible"],
        purposes: [{ id: "visible" }, { id: "hidden" }],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.purposes.map(({ id }) => id)).toEqual([
      "hidden",
      "visible",
    ]);
  });

  it("rejects unresolved disclosure references with stable paths", () => {
    expect(
      definePolicy({
        categories: [{ id: "root", purposeIds: ["analytics"] }],
        dataCategories: [],
        operations: [],
        presentationRootCategoryIds: ["root"],
        providers: [],
        purposes: [
          {
            dataCategoryIds: ["usage"],
            disclosure: "Measure aggregate site usage.",
            id: "analytics",
            operationIds: ["browser-script"],
            providerIds: ["example-provider"],
            recipientIds: ["analytics-team"],
            retentionIds: ["session"],
          },
        ],
        recipients: [],
        retentions: [],
      }),
    ).toEqual({
      issues: [
        {
          code: "unknown-provider-reference",
          normalizedId: "example-provider",
          path: "purposes[0].providerIds[0]",
        },
        {
          code: "unknown-operation-reference",
          normalizedId: "browser-script",
          path: "purposes[0].operationIds[0]",
        },
        {
          code: "unknown-retention-reference",
          normalizedId: "session",
          path: "purposes[0].retentionIds[0]",
        },
        {
          code: "unknown-recipient-reference",
          normalizedId: "analytics-team",
          path: "purposes[0].recipientIds[0]",
        },
        {
          code: "unknown-data-category-reference",
          normalizedId: "usage",
          path: "purposes[0].dataCategoryIds[0]",
        },
      ],
      ok: false,
    });
  });

  it("publishes a deeply frozen policy after every reference resolves", () => {
    const result = definePolicy({
      categories: [{ id: "root", purposeIds: ["analytics"] }],
      dataCategories: [{ id: "usage" }],
      operations: [{ id: "browser-script" }],
      presentationRootCategoryIds: ["root"],
      providers: [{ id: "example-provider" }],
      purposes: [
        {
          dataCategoryIds: ["usage"],
          disclosure: "Measure aggregate site usage.",
          id: "analytics",
          operationIds: ["browser-script"],
          providerIds: ["example-provider"],
          recipientIds: ["analytics-team"],
          retentionIds: ["session"],
        },
      ],
      recipients: [{ id: "analytics-team" }],
      retentions: [{ id: "session" }],
    });
    if (!result.ok) throw new Error("fixture policy must be valid");

    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.isFrozen(result.policy.purposes)).toBe(true);
    expect(Object.isFrozen(result.policy.purposes[0])).toBe(true);
    expect(Object.isFrozen(result.policy.purposes[0]?.providerIds)).toBe(true);
    expect(Object.isFrozen(result.policy.providers)).toBe(true);
    expect(Object.isFrozen(result.policy.providers[0])).toBe(true);
  });

  // Collections are sorted by id; the order categories are presented in is
  // the operator's, and stays out of identity (policy-presentation-order).
  it("publishes normalized defaults and stable sorted collections", () => {
    const result = definePolicy({
      categories: [
        { id: "zeta", purposeIds: ["zeta"] },
        { id: "alpha", purposeIds: ["alpha"] },
      ],
      dataCategories: [{ id: "zeta" }, { id: "alpha" }],
      operations: [{ id: "zeta" }, { id: "alpha" }],
      presentationRootCategoryIds: ["zeta", "alpha"],
      providers: [{ id: "zeta" }, { id: "alpha" }],
      purposes: [
        {
          dataCategoryIds: ["zeta", "alpha"],
          dependsOn: ["alpha"],
          disclosure: "Measure aggregate site usage.",
          id: "zeta",
          operationIds: ["zeta", "alpha"],
          providerIds: ["zeta", "alpha"],
          recipientIds: ["zeta", "alpha"],
          retentionIds: ["zeta", "alpha"],
        },
        {
          dataCategoryIds: ["alpha"],
          disclosure: "Provide optional personalization.",
          id: "alpha",
          operationIds: ["alpha"],
          providerIds: ["alpha"],
          recipientIds: ["alpha"],
          retentionIds: ["alpha"],
        },
      ],
      recipients: [{ id: "zeta" }, { id: "alpha" }],
      retentions: [{ id: "zeta" }, { id: "alpha" }],
    });
    if (!result.ok) throw new Error("fixture policy must be valid");

    expect(result.policy.categories.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.policy.dataCategories.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.policy.operations.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.policy.presentationRootCategoryIds).toEqual([
      "zeta",
      "alpha",
    ]);
    expect(result.policy.providers.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.policy.recipients.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.policy.retentions.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.policy.purposes.map(({ id }) => id)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(result.policy.purposes[1]).toEqual({
      dataCategoryIds: ["alpha", "zeta"],
      dependsOn: ["alpha"],
      disclosure: "Measure aggregate site usage.",
      editorialNote: "",
      id: "zeta",
      label: "zeta",
      operationIds: ["alpha", "zeta"],
      providerIds: ["alpha", "zeta"],
      recipientIds: ["alpha", "zeta"],
      retentionIds: ["alpha", "zeta"],
    });
  });
});
