import { describe, expect, it } from "vitest";

import {
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

function importOrThrow(
  inventory: FindingsInventory,
  observations: readonly unknown[],
): FindingsInventory {
  const result = importObservedFindings(inventory, observations);
  if (!result.ok) throw new Error(`import must succeed: ${result.issue.kind}`);
  return result.inventory;
}

describe("findings import boundary", () => {
  it("imports an observation as an unclassified finding with its provenance", () => {
    const inventory = importOrThrow(emptyFindingsInventory(), [OBSERVATION]);

    const finding = inventory.findings[0];
    expect(inventory.findings).toHaveLength(1);
    expect(finding?.kind).toBe("cookie");
    expect(finding?.name).toBe("_ga");
    expect(finding?.classification).toBe("unclassified");
    expect(finding?.uncertainty).toBe("observed");
    expect(finding?.observations[0]?.browser).toBe("chromium-141");
    expect(finding?.observations[0]?.trigger).toBe("page-load");
  });

  it("records a repeat sighting on the existing finding", () => {
    const first = importOrThrow(emptyFindingsInventory(), [OBSERVATION]);

    const second = importOrThrow(first, [
      {
        ...OBSERVATION,
        observedAt: "2026-09-21T11:00:00.000Z",
        trigger: "interaction",
      },
    ]);

    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]?.observations).toHaveLength(2);
    expect(second.findings[0]?.observations[1]?.trigger).toBe("interaction");
  });

  // A query string or fragment can carry a token, an e-mail address or a
  // visitor id, and a resource is decided by its origin and path anyway. The
  // inventory, which a project may commit, keeps neither.
  it("keeps addresses without their query string or fragment", () => {
    const inventory = importOrThrow(emptyFindingsInventory(), [
      {
        ...OBSERVATION,
        kind: "beacon",
        name: "https://collect.tracker.test/e?cid=1234.5678&dl=x#y",
        source: "https://example.test/unsubscribe?token=secret#top",
      },
      { ...OBSERVATION, source: "https://example.test/account?user=42" },
    ]);

    const beacon = inventory.findings.find(({ kind }) => kind === "beacon");
    expect(beacon?.name).toBe("https://collect.tracker.test/e");
    expect(beacon?.observations[0]?.source).toBe(
      "https://example.test/unsubscribe",
    );
    const cookie = inventory.findings.find(({ kind }) => kind === "cookie");
    expect(cookie?.name).toBe("_ga");
    expect(cookie?.observations[0]?.source).toBe(
      "https://example.test/account",
    );
  });

  // An inventory written before addresses were trimmed still holds full ones;
  // the same resource seen again joins that finding rather than doubling it.
  it("adds a sighting to the finding stored under the full address", () => {
    const stored: FindingsInventory = {
      findings: [
        {
          classification: "unclassified",
          kind: "script",
          name: "https://cdn.tracker.test/tag.js?v=1",
          observations: [],
          uncertainty: "observed",
        },
      ],
    };

    const inventory = importOrThrow(stored, [
      {
        ...OBSERVATION,
        kind: "script",
        name: "https://cdn.tracker.test/tag.js?v=2",
      },
    ]);

    expect(inventory.findings).toHaveLength(1);
    expect(inventory.findings[0]?.observations).toHaveLength(1);
  });

  // The context map: findings never become authoritative catalogue truth.
  it("never imports a finding as classified even when the input claims it is", () => {
    const inventory = importOrThrow(emptyFindingsInventory(), [
      { ...OBSERVATION, classification: "necessary" },
    ]);

    expect(inventory.findings[0]?.classification).toBe("unclassified");
  });

  it("refuses the whole import when any observation is malformed", () => {
    const first = importOrThrow(emptyFindingsInventory(), [OBSERVATION]);

    const result = importObservedFindings(first, [
      { ...OBSERVATION, name: "_gid" },
      { ...OBSERVATION, name: "" },
    ]);

    expect(result.ok).toBe(false);
    expect(first.findings).toHaveLength(1);
  });

  it("refuses an observation whose kind is not a supported finding kind", () => {
    const result = importObservedFindings(emptyFindingsInventory(), [
      { ...OBSERVATION, kind: "telepathy" },
    ]);

    expect(result).toStrictEqual({
      issue: { kind: "unsupported-finding-kind", value: "telepathy" },
      ok: false,
    });
  });

  // Observations arrive from scanners and from files an operator wrote, so the
  // boundary has to say which part was wrong rather than guess at a shape.
  it.each([
    ["not an object", 42, "observation"],
    ["a list", [], "observation"],
    ["missing a browser", { ...OBSERVATION, browser: undefined }, "browser"],
    ["a blank name", { ...OBSERVATION, name: "   " }, "name"],
    ["a source that is not text", { ...OBSERVATION, source: 7 }, "source"],
    ["a trigger that is not text", { ...OBSERVATION, trigger: {} }, "trigger"],
    [
      "a time that is not text",
      { ...OBSERVATION, observedAt: 1_790_000 },
      "observedAt",
    ],
  ])("refuses an observation that is %s", (_label, observation, field) => {
    const result = importObservedFindings(emptyFindingsInventory(), [
      observation,
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("malformed-observation");
    if (result.issue.kind !== "malformed-observation") return;
    expect(result.issue.field).toBe(field);
  });

  it.each([
    ["a kind that is not text", { kind: 3 }, "unsupported-finding-kind", ""],
    [
      "a kind nothing supports",
      { kind: "webhook" },
      "unsupported-finding-kind",
      "webhook",
    ],
    [
      "an uncertainty that is not text",
      { uncertainty: null },
      "unsupported-uncertainty",
      "",
    ],
    [
      "an uncertainty nothing supports",
      { uncertainty: "probably" },
      "unsupported-uncertainty",
      "probably",
    ],
  ])(
    "refuses %s and repeats what it was given",
    (_label, override, kind, value) => {
      const result = importObservedFindings(emptyFindingsInventory(), [
        { ...OBSERVATION, ...override },
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issue.kind).toBe(kind);
      if (
        result.issue.kind !== "unsupported-finding-kind" &&
        result.issue.kind !== "unsupported-uncertainty"
      ) {
        return;
      }
      expect(result.issue.value).toBe(value);
    },
  );

  // Two findings are the same finding only when both the kind and the name
  // match: a cookie and a script can share a name.
  it("keeps a cookie and a script of the same name apart", () => {
    const inventory = importOrThrow(emptyFindingsInventory(), [
      OBSERVATION,
      { ...OBSERVATION, kind: "script" },
    ]);

    expect(inventory.findings).toHaveLength(2);
    expect(inventory.findings.map(({ kind }) => kind).sort()).toEqual([
      "cookie",
      "script",
    ]);
  });
});
