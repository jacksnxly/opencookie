import { describe, expect, it } from "vitest";

import {
  classifyFinding,
  draftPolicyFromFindings,
  emptyFindingsInventory,
  importObservedFindings,
  type FindingsInventory,
} from "./index.js";

const BASE = {
  browser: "chromium-141",
  observedAt: "2026-09-21T10:00:00.000Z",
  source: "https://example.test/",
  trigger: "page-load",
  uncertainty: "observed",
};

function inventory(): FindingsInventory {
  const imported = importObservedFindings(emptyFindingsInventory(), [
    { ...BASE, kind: "cookie", name: "_ga" },
    { ...BASE, kind: "script", name: "tag.js" },
    { ...BASE, kind: "cookie", name: "sid" },
  ]);
  if (!imported.ok) throw new Error("fixture import must succeed");
  return imported.inventory;
}

function classify(
  source: FindingsInventory,
  kind: "cookie" | "script",
  name: string,
  purposeId: string,
  necessary = false,
  overrides: Partial<{
    categoryIds: readonly string[];
    disclosure: string;
    retention: string;
    service: string;
    vendor: string;
  }> = {},
): FindingsInventory {
  const result = classifyFinding(source, {
    categoryIds: ["usage-data"],
    cleanup: "reblocked",
    decidedAt: "2026-09-21T12:00:00.000Z",
    disclosure: "Counts visits so we can see which pages are read.",
    kind,
    name,
    necessary,
    purposeId,
    retention: "thirteen-months",
    service: "google-analytics",
    vendor: "google-llc",
    ...overrides,
  });
  if (!result.ok) throw new Error("fixture classification must succeed");
  return result.inventory;
}

describe("policy draft from findings", () => {
  it("refuses to draft when nothing is classified", () => {
    const result = draftPolicyFromFindings(inventory());

    expect(result).toStrictEqual({
      issue: { kind: "no-classified-findings" },
      ok: false,
    });
  });

  it("groups classified findings under the purpose an operator chose", () => {
    let current = classify(inventory(), "cookie", "_ga", "analytics");
    current = classify(current, "script", "tag.js", "analytics");

    const result = draftPolicyFromFindings(current);

    if (!result.ok) throw new Error(`draft must succeed: ${result.issue.kind}`);
    const analytics = result.draft.purposes.find(
      (purpose) => purpose.id === "analytics",
    );
    expect(analytics?.findings).toStrictEqual([
      { kind: "cookie", name: "_ga" },
      { kind: "script", name: "tag.js" },
    ]);
  });

  // Contract item 4: nothing may look ready before it is.
  // What a decision cannot supply stays missing: a purpose still needs a label
  // a visitor reads and the operations it covers, and a draft is never
  // publishable on its own.
  it("states what each purpose still needs before it can be published", () => {
    const current = classify(inventory(), "cookie", "_ga", "analytics");

    const result = draftPolicyFromFindings(current);

    if (!result.ok) throw new Error("draft must succeed");
    const analytics = result.draft.purposes[0];
    expect(analytics?.missing).toContain("label");
    expect(analytics?.missing).toContain("operationIds");
    expect(analytics?.missing).not.toContain("disclosure");
    expect(analytics?.missing).not.toContain("retentionIds");
    expect(result.draft.publishable).toBe(false);
  });

  it("records a necessary purpose as necessary", () => {
    const current = classify(inventory(), "cookie", "sid", "session", true);

    const result = draftPolicyFromFindings(current);

    if (!result.ok) throw new Error("draft must succeed");
    expect(result.draft.purposes[0]?.necessary).toBe(true);
  });

  it("reports findings left out because they are unclassified", () => {
    const current = classify(inventory(), "cookie", "_ga", "analytics");

    const result = draftPolicyFromFindings(current);

    if (!result.ok) throw new Error("draft must succeed");
    expect(result.draft.excludedUnclassified).toStrictEqual([
      { kind: "cookie", name: "sid" },
      { kind: "script", name: "tag.js" },
    ]);
  });

  // Everything an operator decided belongs in the draft; only what no decision
  // can supply stays missing, so the list of remaining work is honest.
  it("carries the operator's vendor, service, categories and retention", () => {
    let current = classify(inventory(), "cookie", "_ga", "analytics");
    current = classify(current, "script", "tag.js", "analytics", false, {
      categoryIds: ["device-identifiers"],
      service: "google-tag-manager",
      vendor: "google-llc",
    });

    const result = draftPolicyFromFindings(current);
    if (!result.ok) throw new Error("draft must succeed");
    const purpose = result.draft.purposes.find(
      (entry) => entry.id === "analytics",
    );

    expect(purpose?.providerIds).toEqual(["google-llc"]);
    expect(purpose?.recipientIds).toEqual([
      "google-analytics",
      "google-tag-manager",
    ]);
    expect(purpose?.dataCategoryIds).toEqual([
      "device-identifiers",
      "usage-data",
    ]);
    expect(purpose?.retentionIds).toEqual(["thirteen-months"]);
    expect(purpose?.disclosures).toEqual([
      "Counts visits so we can see which pages are read.",
    ]);
    expect(purpose?.missing).toEqual(["label", "operationIds"]);
    expect(result.draft.publishable).toBe(false);
  });
});
