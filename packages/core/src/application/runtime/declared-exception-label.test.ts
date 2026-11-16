import { describe, expect, it } from "vitest";

import { createOpenCookie } from "./create-open-cookie.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type DefinedPolicy,
  type PolicyResourceDefinition,
} from "../../domain/policy-catalogue/index.js";

// A declared exception is listed as not controlled by the choices. Its
// identifier is lowercase and technical, so the list shows its label.

function catalogue(): DefinedPolicy {
  const result = definePolicy({
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "measure" }],
    providers: [{ id: "site-operator" }],
    purposes: [
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

function define(exception: Partial<PolicyResourceDefinition>) {
  return defineResourcePolicy({
    policy: catalogue(),
    resources: [
      {
        access: "declared-exception",
        exceptionReason: "Keeps the visitor signed in.",
        id: "session",
        serviceId: "site",
        ...exception,
      } as PolicyResourceDefinition,
    ],
    services: [{ id: "site" }],
  });
}

describe("a declared exception's label", () => {
  it("is kept trimmed, and an exception without one has none", () => {
    const labelled = define({ label: " Sitzungs-Cookie " });
    const unlabelled = define({});
    if (!labelled.ok || !unlabelled.ok) throw new Error("Must be valid.");

    expect(labelled.resourcePolicy.resources[0]).toMatchObject({
      label: "Sitzungs-Cookie",
    });
    expect("label" in (unlabelled.resourcePolicy.resources[0] ?? {})).toBe(
      false,
    );
  });

  it("refuses a blank label", () => {
    expect(define({ label: " " })).toEqual({
      issues: [{ code: "blank-exception-label", path: "resources[0].label" }],
      ok: false,
    });
  });

  it("reaches the runtime's access policy", () => {
    const resourcePolicy = define({ label: "Sitzungs-Cookie" });
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
      expect.objectContaining({ id: "session", label: "Sitzungs-Cookie" }),
    ]);
  });
});
