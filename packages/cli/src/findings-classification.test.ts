import { describe, expect, it } from "vitest";

import {
  classifyFinding,
  emptyFindingsInventory,
  importObservedFindings,
  type FindingsInventory,
} from "./index.js";

const OBSERVATION = {
  browser: "chromium-141",
  kind: "cookie",
  name: "_ga",
  observedAt: "2026-09-21T10:00:00.000Z",
  source: "https://example.test/",
  trigger: "page-load",
  uncertainty: "observed",
};

const DECISION = {
  categoryIds: ["usage-data"],
  cleanup: "reblocked",
  disclosure: "Counts visits so we can see which pages are read.",
  retention: "thirteen-months",
  service: "google-analytics",
  vendor: "google-llc",
} as const;

function observed(): FindingsInventory {
  const result = importObservedFindings(emptyFindingsInventory(), [
    OBSERVATION,
  ]);
  if (!result.ok) throw new Error("fixture import must succeed");
  return result.inventory;
}

describe("findings classification", () => {
  it("records an operator decision against an observed finding", () => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "analytics",
    });

    if (!result.ok)
      throw new Error(`classify must succeed: ${result.issue.kind}`);
    const finding = result.inventory.findings[0];
    expect(finding?.classification).toBe("classified");
    expect(finding?.decision?.purposeId).toBe("analytics");
    expect(finding?.decision?.necessary).toBe(false);
    expect(finding?.decision?.decidedAt).toBe("2026-09-21T12:00:00.000Z");
  });

  it("keeps the observed evidence when a decision is revised", () => {
    const first = classifyFinding(observed(), {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "analytics",
    });
    if (!first.ok) throw new Error("first decision must succeed");

    const revised = classifyFinding(first.inventory, {
      ...DECISION,
      decidedAt: "2026-09-22T09:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: true,
      purposeId: "session",
    });

    if (!revised.ok) throw new Error("revision must succeed");
    const finding = revised.inventory.findings[0];
    expect(finding?.decision?.purposeId).toBe("session");
    expect(finding?.decision?.necessary).toBe(true);
    expect(finding?.observations).toHaveLength(1);
  });

  it("refuses to classify a finding that was never observed", () => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_unseen",
      necessary: false,
      purposeId: "analytics",
    });

    expect(result).toStrictEqual({
      issue: { kind: "unknown-finding", name: "_unseen" },
      ok: false,
    });
  });

  it("refuses a blank purpose", () => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "   ",
    });

    expect(result.ok).toBe(false);
  });

  it("leaves other findings untouched", () => {
    const withTwo = importObservedFindings(observed(), [
      { ...OBSERVATION, kind: "script", name: "tag.js" },
    ]);
    if (!withTwo.ok) throw new Error("fixture import must succeed");

    const result = classifyFinding(withTwo.inventory, {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "analytics",
    });

    if (!result.ok) throw new Error("classify must succeed");
    const script = result.inventory.findings.find(
      (finding) => finding.kind === "script",
    );
    expect(script?.classification).toBe("unclassified");
    expect(script?.decision).toBeUndefined();
  });

  it("records the vendor, service, categories, retention and cleanup", () => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "analytics",
    });

    if (!result.ok)
      throw new Error(`classify must succeed: ${result.issue.kind}`);
    const decision = result.inventory.findings[0]?.decision;
    expect(decision?.vendor).toBe("google-llc");
    expect(decision?.service).toBe("google-analytics");
    expect(decision?.categoryIds).toEqual(["usage-data"]);
    expect(decision?.disclosure).toBe(
      "Counts visits so we can see which pages are read.",
    );
    expect(decision?.retention).toBe("thirteen-months");
    expect(decision?.cleanup).toBe("reblocked");
  });

  it.each([
    ["vendor", { vendor: "  " }, "blank-vendor"],
    ["service", { service: "" }, "blank-service"],
    ["disclosure", { disclosure: " " }, "blank-disclosure"],
    ["retention", { retention: "" }, "blank-retention"],
    ["categories", { categoryIds: [] }, "no-categories"],
    ["category entry", { categoryIds: ["usage-data", " "] }, "no-categories"],
  ])("refuses a decision with a missing %s", (_label, override, issueKind) => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      ...override,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "analytics",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe(issueKind);
  });

  // Cleanup says what happens to the resource when consent is withdrawn. An
  // unrecognised value would be recorded and shown to visitors as if the
  // runtime honoured it.
  it("refuses a cleanup behavior it does not know", () => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      cleanup: "deleted-from-the-vendor" as never,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "analytics",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("unsupported-cleanup");
  });

  // A necessary cookie is set without consent, so the one thing a visitor can
  // still expect is to be told what it does.
  it("requires a disclosure even for a necessary exception", () => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      disclosure: "",
      kind: "cookie",
      name: "_ga",
      necessary: true,
      purposeId: "strictly-necessary",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("blank-disclosure");
  });

  // An operator types these on a command line, so the stored decision should
  // hold what they meant, not the spaces around it.
  it("stores the decision without the spaces around each part", () => {
    const result = classifyFinding(observed(), {
      ...DECISION,
      categoryIds: ["  usage-data  "],
      decidedAt: "2026-09-21T12:00:00.000Z",
      disclosure: "  Counts visits.  ",
      kind: "cookie",
      name: "_ga",
      necessary: false,
      purposeId: "  analytics  ",
      retention: "  thirteen-months  ",
      service: "  google-analytics  ",
      vendor: "  google-llc  ",
    });

    if (!result.ok)
      throw new Error(`classify must succeed: ${result.issue.kind}`);
    const decision = result.inventory.findings[0]?.decision;
    expect(decision?.purposeId).toBe("analytics");
    expect(decision?.vendor).toBe("google-llc");
    expect(decision?.service).toBe("google-analytics");
    expect(decision?.retention).toBe("thirteen-months");
    expect(decision?.disclosure).toBe("Counts visits.");
    expect(decision?.categoryIds).toEqual(["usage-data"]);
  });

  // A decision belongs to one finding. A cookie and a script may share a name,
  // and deciding about one must not decide about the other.
  it("decides about the finding of that kind only", () => {
    const imported = importObservedFindings(observed(), [
      { ...OBSERVATION, kind: "script" },
    ]);
    if (!imported.ok) throw new Error("fixture import must succeed");

    const result = classifyFinding(imported.inventory, {
      ...DECISION,
      decidedAt: "2026-09-21T12:00:00.000Z",
      kind: "script",
      name: "_ga",
      necessary: false,
      purposeId: "analytics",
    });

    if (!result.ok) throw new Error("classify must succeed");
    const byKind = new Map(
      result.inventory.findings.map((finding) => [finding.kind, finding]),
    );
    expect(byKind.get("script")?.classification).toBe("classified");
    expect(byKind.get("cookie")?.classification).toBe("unclassified");
  });
});
