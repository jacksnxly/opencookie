import { describe, expect, it } from "vitest";

import {
  definePolicy,
  defineResourcePolicy,
  type ResourcePolicyDefinition,
  type ResourcePolicyIssue,
} from "./index.js";
import { completeTestPolicyDefinition } from "./policy-test-fixtures.test-helper.js";

function validCatalogue() {
  const result = definePolicy(
    completeTestPolicyDefinition({
      purposes: [
        { id: "analytics" },
        { dependsOn: ["analytics"], id: "personalization" },
      ],
    }),
  );
  if (!result.ok) throw new Error("Test catalogue must be valid.");
  return result.policy;
}

const disallowedResourceIdentifierCases = [
  {
    definition: {
      resources: [],
      services: [{ id: "ana\u200Blytics" }],
    },
    issue: { code: "blank-service-id", path: "services[0].id" },
    name: "service identity",
  },
  {
    definition: {
      resources: [
        {
          access: "declared-exception",
          exceptionReason: "Required",
          id: "ana\u200Blytics",
          serviceId: "metrics",
        },
      ],
      services: [{ id: "metrics" }],
    },
    issue: { code: "blank-resource-id", path: "resources[0].id" },
    name: "resource identity",
  },
  {
    definition: {
      resources: [
        {
          access: "declared-exception",
          exceptionReason: "Required",
          id: "tracker",
          serviceId: "ana\u200Blytics",
        },
      ],
      services: [{ id: "metrics" }],
    },
    issue: {
      code: "unknown-resource-service",
      normalizedId: "",
      path: "resources[0].serviceId",
    },
    name: "resource service reference",
  },
  {
    definition: {
      resources: [
        {
          access: "optional",
          id: "tracker",
          purposeIds: ["ana\u200Blytics"],
          serviceId: "metrics",
        },
      ],
      services: [{ id: "metrics" }],
    },
    issue: {
      code: "unknown-resource-purpose",
      normalizedId: "",
      path: "resources[0].purposeIds[0]",
    },
    name: "resource purpose reference",
  },
] as const satisfies readonly {
  readonly definition: Omit<ResourcePolicyDefinition, "policy">;
  readonly issue: ResourcePolicyIssue;
  readonly name: string;
}[];

describe("defineResourcePolicy", () => {
  it("publishes one normalized immutable contract for declared services and resources", () => {
    const result = defineResourcePolicy({
      policy: validCatalogue(),
      resources: [
        {
          access: "declared-exception",
          exceptionReason:
            "  Required to retain the visitor's consent choice.  ",
          id: "consent-cookie",
          serviceId: "session",
        },
        {
          access: "optional",
          id: " Analytics Script ",
          purposeIds: [" PERSONALIZATION ", "analytics"],
          serviceId: " Metrics ",
        },
      ],
      services: [{ id: "session" }, { id: "metrics" }],
    });

    expect(result).toEqual({
      ok: true,
      resourcePolicy: {
        purposeIds: ["analytics", "personalization"],
        resources: [
          {
            access: "optional",
            id: "analytics script",
            purposeIds: ["analytics", "personalization"],
            serviceId: "metrics",
          },
          {
            access: "declared-exception",
            exceptionReason: "Required to retain the visitor's consent choice.",
            id: "consent-cookie",
            purposeIds: [],
            serviceId: "session",
          },
        ],
        services: [{ id: "metrics" }, { id: "session" }],
      },
    });
    if (!result.ok) return;
    expect(Object.isFrozen(result.resourcePolicy)).toBe(true);
    expect(Object.isFrozen(result.resourcePolicy.resources)).toBe(true);
    expect(Object.isFrozen(result.resourcePolicy.resources[0])).toBe(true);
  });

  it("rejects invalid identities and unresolved resource references with stable paths", () => {
    expect(
      defineResourcePolicy({
        policy: validCatalogue(),
        resources: [
          {
            access: "optional",
            id: " ",
            purposeIds: [],
            serviceId: "missing",
          },
          {
            access: "optional",
            id: "tracker",
            purposeIds: ["unknown", " ANALYTICS ", "analytics"],
            serviceId: " METRICS ",
          },
          {
            access: "declared-exception",
            exceptionReason: " ",
            id: "TRACKER",
            serviceId: "metrics",
          },
        ],
        services: [{ id: "metrics" }, { id: " METRICS " }, { id: " " }],
      }),
    ).toEqual({
      issues: [
        {
          code: "duplicate-service-id",
          normalizedId: "metrics",
          path: "services[1].id",
        },
        { code: "blank-service-id", path: "services[2].id" },
        { code: "blank-resource-id", path: "resources[0].id" },
        {
          code: "unknown-resource-service",
          normalizedId: "missing",
          path: "resources[0].serviceId",
        },
        {
          code: "optional-resource-without-purpose",
          path: "resources[0].purposeIds",
        },
        {
          code: "unknown-resource-purpose",
          normalizedId: "unknown",
          path: "resources[1].purposeIds[0]",
        },
        {
          code: "duplicate-resource-purpose",
          normalizedId: "analytics",
          path: "resources[1].purposeIds[2]",
        },
        {
          code: "duplicate-resource-id",
          normalizedId: "tracker",
          path: "resources[2].id",
        },
        {
          code: "missing-exception-reason",
          path: "resources[2].exceptionReason",
        },
      ],
      ok: false,
    });
  });

  it.each(disallowedResourceIdentifierCases)(
    "rejects a disallowed machine identifier at the $name boundary",
    ({ definition, issue }) => {
      expect(
        defineResourcePolicy({ policy: validCatalogue(), ...definition }),
      ).toEqual({ issues: [issue], ok: false });
    },
  );

  it("does not delegate resource validation to a caller-owned map method", () => {
    const resources: ResourcePolicyDefinition["resources"] = [
      {
        access: "optional",
        id: " ",
        purposeIds: [],
        serviceId: "metrics",
      },
    ];
    let mapCalls = 0;
    Object.defineProperty(resources, "map", {
      value: () => {
        mapCalls += 1;
        return [];
      },
    });

    expect(
      defineResourcePolicy({
        policy: validCatalogue(),
        resources,
        services: [{ id: "metrics" }],
      }),
    ).toEqual({
      issues: [
        { code: "blank-resource-id", path: "resources[0].id" },
        {
          code: "optional-resource-without-purpose",
          path: "resources[0].purposeIds",
        },
      ],
      ok: false,
    });
    expect(mapCalls).toBe(0);
  });

  it("rejects accessor-backed resource fields without invoking them", () => {
    let idReads = 0;
    const resource = {
      access: "optional" as const,
      id: "tracker",
      purposeIds: ["analytics"],
      serviceId: "metrics",
    };
    Object.defineProperty(resource, "id", {
      enumerable: true,
      get: () => {
        idReads += 1;
        return "tracker";
      },
    });

    expect(() =>
      defineResourcePolicy({
        policy: validCatalogue(),
        resources: [resource],
        services: [{ id: "metrics" }],
      }),
    ).toThrow("Invalid resource policy definition at resources[0].id.");
    expect(idReads).toBe(0);
  });

  it.each([
    ["root null", null, "$"],
    ["root array", [], "$"],
    ["missing policy", { resources: [], services: [] }, "policy"],
    ["invalid policy", { policy: {}, resources: [], services: [] }, "policy"],
    [
      "missing services",
      { policy: validCatalogue(), resources: [] },
      "services",
    ],
    [
      "non-array services",
      { policy: validCatalogue(), resources: [], services: null },
      "services",
    ],
    [
      "invalid service entry",
      { policy: validCatalogue(), resources: [], services: [null] },
      "services[0]",
    ],
    [
      "missing service id",
      { policy: validCatalogue(), resources: [], services: [{}] },
      "services[0].id",
    ],
    [
      "missing resources",
      { policy: validCatalogue(), services: [] },
      "resources",
    ],
    [
      "non-array resources",
      { policy: validCatalogue(), resources: null, services: [] },
      "resources",
    ],
    [
      "invalid resource entry",
      { policy: validCatalogue(), resources: [null], services: [] },
      "resources[0]",
    ],
    [
      "invalid resource access",
      {
        policy: validCatalogue(),
        resources: [{ access: "forged" }],
        services: [],
      },
      "resources[0].access",
    ],
    [
      "missing optional purposes",
      {
        policy: validCatalogue(),
        resources: [
          {
            access: "optional",
            id: "tracker",
            serviceId: "metrics",
          },
        ],
        services: [],
      },
      "resources[0].purposeIds",
    ],
    [
      "non-array optional purposes",
      {
        policy: validCatalogue(),
        resources: [
          {
            access: "optional",
            id: "tracker",
            purposeIds: null,
            serviceId: "metrics",
          },
        ],
        services: [],
      },
      "resources[0].purposeIds",
    ],
    [
      "missing resource id",
      {
        policy: validCatalogue(),
        resources: [
          {
            access: "declared-exception",
            exceptionReason: "required",
            serviceId: "metrics",
          },
        ],
        services: [],
      },
      "resources[0].id",
    ],
    [
      "missing resource service",
      {
        policy: validCatalogue(),
        resources: [
          {
            access: "declared-exception",
            exceptionReason: "required",
            id: "cookie",
          },
        ],
        services: [],
      },
      "resources[0].serviceId",
    ],
    [
      "missing exception reason",
      {
        policy: validCatalogue(),
        resources: [
          {
            access: "declared-exception",
            id: "cookie",
            serviceId: "metrics",
          },
        ],
        services: [],
      },
      "resources[0].exceptionReason",
    ],
  ] as const)(
    "rejects structural %s at its exact path",
    (_case, value, path) => {
      expect(() =>
        defineResourcePolicy(value as unknown as ResourcePolicyDefinition),
      ).toThrow(`Invalid resource policy definition at ${path}.`);
    },
  );

  it("rejects inherited optional resource purposes without invoking them", () => {
    let reads = 0;
    const prototype = {};
    Object.defineProperty(prototype, "purposeIds", {
      get: () => {
        reads += 1;
        return [];
      },
    });
    const resource = Object.assign(Object.create(prototype) as object, {
      access: "declared-exception",
      exceptionReason: "required",
      id: "cookie",
      serviceId: "metrics",
    });

    expect(() =>
      defineResourcePolicy({
        policy: validCatalogue(),
        resources: [
          resource,
        ] as unknown as ResourcePolicyDefinition["resources"],
        services: [{ id: "metrics" }],
      }),
    ).toThrow("Invalid resource policy definition at resources[0].purposeIds.");
    expect(reads).toBe(0);
  });

  it.each([Symbol("length"), -1, 1.5, 10_001])(
    "rejects an invalid service collection length %s",
    (length) => {
      const services = new Proxy([{ id: "metrics" }], {
        getOwnPropertyDescriptor: (target, property) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          return property === "length" && descriptor !== undefined
            ? { ...descriptor, value: length }
            : descriptor;
        },
      });

      expect(() =>
        defineResourcePolicy({
          policy: validCatalogue(),
          resources: [],
          services,
        }),
      ).toThrow("Invalid resource policy definition at services.");
    },
  );

  it("rejects revoked, sparse, accessor, and throwing service collections", () => {
    const revoked = Proxy.revocable<{ id: string }[]>([], {});
    revoked.revoke();
    const sparse = new Array<{ id: string }>(1);
    const accessor = [{ id: "metrics" }];
    let reads = 0;
    Object.defineProperty(accessor, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return { id: "metrics" };
      },
    });
    const throwingLength = new Proxy([{ id: "metrics" }], {
      getOwnPropertyDescriptor: (_target, property) => {
        if (property === "length") throw new Error("length trap");
        return undefined;
      },
    });
    const throwingEntry = new Proxy([{ id: "metrics" }], {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "0") throw new Error("entry trap");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    for (const services of [
      revoked.proxy,
      sparse,
      accessor,
      throwingLength,
      throwingEntry,
    ]) {
      expect(() =>
        defineResourcePolicy({
          policy: validCatalogue(),
          resources: [],
          services,
        }),
      ).toThrow(/Invalid resource policy definition at services(?:\[0\])?\./);
    }
    expect(reads).toBe(0);
  });

  it.each(["direct", "proxy"] as const)(
    "rejects an oversized %s resource collection before traversal",
    (kind) => {
      let indexedDescriptorReads = 0;
      const direct = new Array<ResourcePolicyDefinition["resources"][number]>(
        10_001,
      );
      const resources =
        kind === "direct"
          ? direct
          : new Proxy([] as ResourcePolicyDefinition["resources"][number][], {
              getOwnPropertyDescriptor: (target, property) => {
                const descriptor = Reflect.getOwnPropertyDescriptor(
                  target,
                  property,
                );
                if (property === "length" && descriptor !== undefined) {
                  return { ...descriptor, value: 10_001 };
                }
                indexedDescriptorReads += 1;
                return descriptor;
              },
            });

      expect(() =>
        defineResourcePolicy({
          policy: validCatalogue(),
          resources,
          services: [],
        }),
      ).toThrow("Invalid resource policy definition at resources.");
      expect(indexedDescriptorReads).toBe(0);
    },
  );

  it("rejects collections that exceed the aggregate nested capture budget", () => {
    const resources = Array.from({ length: 5_000 }, (_, index) => ({
      access: "optional" as const,
      id: `resource-${String(index)}`,
      purposeIds: ["analytics"],
      serviceId: "metrics",
    }));

    expect(() =>
      defineResourcePolicy({
        policy: validCatalogue(),
        resources,
        services: [{ id: "metrics" }],
      }),
    ).toThrow(
      "Invalid resource policy definition at resources[4999].purposeIds.",
    );
  });
});
