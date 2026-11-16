import { describe, expect, it } from "vitest";

import {
  defineAutoPolicy,
  defineAutoResourcePolicy,
} from "./define-auto-policy.js";
import { definePolicy, type PolicyDefinition } from "./define-policy.js";
import { expandCategorySelection } from "./expand-category-selection.js";
import { createPolicySnapshot } from "./policy-identity.js";
import { projectPolicySections } from "./project-policy-sections.js";
import { defineResourcePolicy } from "./resource-policy.js";

interface AutoPolicyRawInput {
  readonly catalogueRevision: string;
  readonly consentDurationMs: number;
  readonly disclosure: string;
  readonly policyVersion: string;
  readonly purposeId: string;
  readonly purposeLabel: string;
}

function rawInput(
  overrides: Partial<AutoPolicyRawInput> = {},
): AutoPolicyRawInput {
  return {
    catalogueRevision: "catalogue-1",
    consentDurationMs: 60_000,
    disclosure: "Understand aggregate site usage.",
    policyVersion: "policy-1",
    purposeId: "analytics",
    purposeLabel: "Analytics",
    ...overrides,
  };
}

function genericDefinition(input: AutoPolicyRawInput): PolicyDefinition {
  const retentionId = `duration-${String(input.consentDurationMs)}-ms`;
  return {
    categories: [{ id: "optional", purposeIds: [input.purposeId] }],
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "aggregate-measurement" }],
    presentationRootCategoryIds: ["optional"],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: input.disclosure,
        id: input.purposeId,
        label: input.purposeLabel,
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: [retentionId],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: retentionId }],
  };
}

describe("defineAutoPolicy", () => {
  it("matches the generic constructors for the canonical policy and snapshot", () => {
    const input = rawInput({
      purposeId: "  Analytics ",
      purposeLabel: "  Site analytics ",
    });
    const auto = defineAutoPolicy(input);
    const generic = definePolicy(genericDefinition(input));
    expect(generic.ok).toBe(true);
    if (!generic.ok) throw new Error("Generic policy must define.");
    const genericSnapshot = createPolicySnapshot({
      catalogueRevision: input.catalogueRevision,
      policy: generic.policy,
      policyVersion: input.policyVersion,
    });

    expect(auto.purposeId).toBe("analytics");
    expect(auto.retentionId).toBe("duration-60000-ms");
    expect(auto.policy.categories).toEqual([
      { categoryIds: [], id: "optional", purposeIds: ["analytics"] },
    ]);
    expect(auto.policy.presentationRootCategoryIds).toEqual(["optional"]);
    expect(auto.policy).toEqual(generic.policy);
    expect(auto.snapshot.catalogueDigest).toBe(genericSnapshot.catalogueDigest);
    expect(auto.snapshot.decisionSurfaceDigest).toBe(
      genericSnapshot.decisionSurfaceDigest,
    );
    expect(auto.snapshot).toEqual(genericSnapshot);
    for (const categoryIds of [
      ["optional"],
      [" OPTIONAL "],
      ["unknown"],
      ["optional", "unknown"],
    ]) {
      expect(auto.expandCategorySelection(categoryIds)).toEqual(
        expandCategorySelection(auto.policy, categoryIds),
      );
    }
    expect(auto.policySections).toEqual(projectPolicySections(auto.policy));
    expect(Object.isFrozen(auto.policySections)).toBe(true);
    expect(Object.isFrozen(auto.policySections[0])).toBe(true);
  });

  it("derives distinct digests for distinct definitions", () => {
    const base = defineAutoPolicy(rawInput());
    const other = defineAutoPolicy(rawInput({ consentDurationMs: 90_000 }));
    expect(other.snapshot.catalogueDigest).not.toBe(
      base.snapshot.catalogueDigest,
    );
  });

  it("rejects what the generic constructor rejects", () => {
    expect(() => defineAutoPolicy(rawInput({ purposeId: "   " }))).toThrow(
      TypeError,
    );
    expect(() => defineAutoPolicy(rawInput({ disclosure: " ­ " }))).toThrow(
      TypeError,
    );
    expect(() => defineAutoPolicy(rawInput({ purposeLabel: "   " }))).toThrow(
      TypeError,
    );

    const genericBlankPurpose = definePolicy(
      genericDefinition(rawInput({ purposeId: "   " })),
    );
    expect(genericBlankPurpose.ok).toBe(false);
    if (genericBlankPurpose.ok) throw new Error("Expected issues.");
    expect(genericBlankPurpose.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "blank-purpose-id" }),
      ]),
    );
  });

  it("rejects hidden controls embedded in the purpose identifier", () => {
    expect(() =>
      defineAutoPolicy(rawInput({ purposeId: "ana\u200Dlytics" })),
    ).toThrow(new TypeError("Invalid auto policy definition."));
  });

  it("returns deeply frozen graphs", () => {
    const auto = defineAutoPolicy(rawInput());
    expect(Object.isFrozen(auto)).toBe(true);
    expect(Object.isFrozen(auto.policy)).toBe(true);
    expect(Object.isFrozen(auto.policy.purposes)).toBe(true);
    expect(Object.isFrozen(auto.policy.purposes[0])).toBe(true);
    expect(Object.isFrozen(auto.expandCategorySelection(["optional"]))).toBe(
      true,
    );
    expect(Object.isFrozen(auto.snapshot)).toBe(true);
  });
});

describe("defineAutoResourcePolicy", () => {
  const resourceSets: readonly {
    readonly name: string;
    readonly resources: readonly { id: string; serviceId: string }[];
  }[] = [
    { name: "no resources", resources: [] },
    {
      name: "one resource",
      resources: [{ id: "analytics-script", serviceId: "analytics-service" }],
    },
    {
      name: "several unnormalized resources",
      resources: [
        { id: "  Widget-Script ", serviceId: "  Widget-Service " },
        { id: "analytics-script", serviceId: "analytics-service" },
        { id: "pixel-frame", serviceId: "pixel-service" },
      ],
    },
  ];

  it.each(resourceSets)(
    "matches the generic resource policy for $name",
    ({ resources }) => {
      const input = rawInput();
      const auto = defineAutoPolicy(input);
      const generic = definePolicy(genericDefinition(input));
      if (!generic.ok) throw new Error("Generic policy must define.");
      const genericResourcePolicy = defineResourcePolicy({
        policy: generic.policy,
        resources: resources.map((resource) => ({
          access: "optional",
          id: resource.id,
          purposeIds: [input.purposeId],
          serviceId: resource.serviceId,
        })),
        services: resources.map((resource) => ({ id: resource.serviceId })),
      });
      expect(genericResourcePolicy.ok).toBe(true);
      if (!genericResourcePolicy.ok) throw new Error("Expected ok.");

      const autoResourcePolicy = defineAutoResourcePolicy(auto, resources);

      expect(autoResourcePolicy).toEqual(genericResourcePolicy.resourcePolicy);
      expect(Object.isFrozen(autoResourcePolicy)).toBe(true);
      expect(Object.isFrozen(autoResourcePolicy.resources)).toBe(true);
    },
  );

  it("rejects what the generic constructor rejects", () => {
    const auto = defineAutoPolicy(rawInput());

    expect(() =>
      defineAutoResourcePolicy(auto, [
        { id: "analytics-script", serviceId: "analytics-service" },
        { id: "Analytics-Script", serviceId: "other-service" },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      defineAutoResourcePolicy(auto, [
        { id: "analytics-script", serviceId: "shared-service" },
        { id: "pixel-frame", serviceId: "shared-service" },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      defineAutoResourcePolicy(auto, [{ id: "   ", serviceId: "service" }]),
    ).toThrow(TypeError);
    expect(() =>
      defineAutoResourcePolicy(auto, [
        { id: "analytics-script", serviceId: "  " },
      ]),
    ).toThrow(TypeError);
  });

  it.each([
    [
      "resource identifier",
      { id: "ana\u200Blytics", serviceId: "analytics-service" },
    ],
    [
      "service identifier",
      { id: "analytics-script", serviceId: "ana\u200Blytics" },
    ],
  ])("rejects hidden controls in a %s", (_case, resource) => {
    const auto = defineAutoPolicy(rawInput());

    expect(() => defineAutoResourcePolicy(auto, [resource])).toThrow(
      new TypeError("Invalid auto policy definition."),
    );
  });
});
