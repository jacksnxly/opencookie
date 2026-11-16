import { describe, expect, it } from "vitest";

import { createOpenCookie } from "./create-open-cookie.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type DefinedPolicy,
  type PolicyResourceDefinition,
} from "../../domain/policy-catalogue/index.js";

// A tag manager's container serves several purposes and must load when any
// one of them is permitted. Its resource declares that it matches any.

function catalogue(): DefinedPolicy {
  const result = definePolicy({
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "measure" }],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Uses advertising.",
        id: "advertising",
        operationIds: ["measure"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["thirteen-months"],
      },
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Uses analytics.",
        id: "analytics",
        operationIds: ["measure"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["thirteen-months"],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "thirteen-months" }],
  });
  if (!result.ok) throw new Error("Test catalogue must be valid.");
  return result.policy;
}

function define(resource: Partial<PolicyResourceDefinition>) {
  return defineResourcePolicy({
    policy: catalogue(),
    resources: [
      {
        access: "optional",
        id: "container",
        purposeIds: ["analytics", "advertising"],
        serviceId: "tag-manager",
        ...resource,
      } as PolicyResourceDefinition,
    ],
    services: [{ id: "tag-manager" }],
  });
}

describe("a resource's purpose match", () => {
  it("is kept as any for a resource of several purposes", () => {
    const result = define({ purposeMatch: "any" });
    if (!result.ok) throw new Error("Must be valid.");

    expect(result.resourcePolicy.resources[0]).toEqual({
      access: "optional",
      id: "container",
      purposeIds: ["advertising", "analytics"],
      purposeMatch: "any",
      serviceId: "tag-manager",
    });
  });

  it("is left out when it is all, or when the resource has one purpose", () => {
    for (const resource of [
      { purposeMatch: "all" },
      {},
      { purposeIds: ["analytics"], purposeMatch: "any" },
    ] as const) {
      const result = define(resource);
      if (!result.ok) throw new Error("Must be valid.");
      expect("purposeMatch" in (result.resourcePolicy.resources[0] ?? {})).toBe(
        false,
      );
    }
  });

  it("is refused on a declared exception, or when it is not all or any", () => {
    expect(
      define({
        access: "declared-exception",
        exceptionReason: "Required.",
        purposeMatch: "any",
      } as Partial<PolicyResourceDefinition>),
    ).toEqual({
      issues: [
        { code: "invalid-purpose-match", path: "resources[0].purposeMatch" },
      ],
      ok: false,
    });
    expect(
      define({
        purposeMatch: "some",
      } as unknown as Partial<PolicyResourceDefinition>),
    ).toEqual({
      issues: [
        { code: "invalid-purpose-match", path: "resources[0].purposeMatch" },
      ],
      ok: false,
    });
  });

  it("reaches the runtime's access policy", () => {
    const resourcePolicy = define({ purposeMatch: "any" });
    if (!resourcePolicy.ok) throw new Error("Must be valid.");
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_700_000_000_000,
      policySnapshot: createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: catalogue(),
        policyVersion: "policy-1",
      }),
      reconcile: () => Promise.resolve(),
      resourcePolicy: resourcePolicy.resourcePolicy,
      store: {
        clear: () => Promise.resolve({ status: "cleared" }),
        read: () => Promise.resolve({ status: "empty" }),
        write: () => Promise.resolve({ status: "written" }),
      } as never,
    });

    expect(client.getSnapshot().runtime.accessPolicy.resources).toEqual([
      expect.objectContaining({ id: "container", purposeMatch: "any" }),
    ]);
  });
});
