import { describe, expect, it } from "vitest";

import { diffDecisions, type PurposeDecisionState } from "./index.js";

describe("diffDecisions", () => {
  it("returns only changed decisions in stable purpose order", () => {
    const previous = Object.freeze([
      Object.freeze({ purposeId: "marketing", value: "denied" as const }),
      Object.freeze({ purposeId: "analytics", value: "granted" as const }),
      Object.freeze({ purposeId: "functional", value: "granted" as const }),
    ]) satisfies readonly PurposeDecisionState[];
    const current = Object.freeze([
      Object.freeze({ purposeId: "functional", value: "granted" as const }),
      Object.freeze({ purposeId: "marketing", value: "granted" as const }),
      Object.freeze({ purposeId: "analytics", value: "denied" as const }),
    ]) satisfies readonly PurposeDecisionState[];
    const previousBefore = structuredClone(previous);
    const currentBefore = structuredClone(current);

    const result = diffDecisions(previous, current);

    expect(result).toEqual([
      { from: "granted", purposeId: "analytics", to: "denied" },
      { from: "denied", purposeId: "marketing", to: "granted" },
    ]);
    expect(previous).toEqual(previousBefore);
    expect(current).toEqual(currentBefore);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it("treats every first record decision as a transition from unresolved", () => {
    expect(
      diffDecisions(null, [
        { purposeId: "marketing", value: "denied" },
        { purposeId: "analytics", value: "granted" },
      ]),
    ).toEqual([
      { from: "unresolved", purposeId: "analytics", to: "granted" },
      { from: "unresolved", purposeId: "marketing", to: "denied" },
    ]);
  });

  it("omits unchanged unresolved states", () => {
    expect(
      diffDecisions(
        [{ purposeId: "analytics", value: "unresolved" }],
        [{ purposeId: "analytics", value: "unresolved" }],
      ),
    ).toEqual([]);
  });

  it("rejects duplicate purpose decisions instead of producing ambiguous transitions", () => {
    expect(() =>
      diffDecisions(null, [
        { purposeId: "analytics", value: "granted" },
        { purposeId: "analytics", value: "denied" },
      ]),
    ).toThrow("current contains duplicate purpose decision: analytics");
  });

  it("rejects a purpose identifier that cannot be serialized", () => {
    expect(() =>
      diffDecisions(null, [
        {
          purposeId: undefined,
          value: "granted",
        } as unknown as PurposeDecisionState,
      ]),
    ).toThrow("current contains invalid purpose identifier at index 0");
  });

  it("orders Unicode identifiers independently of the host locale", () => {
    expect(
      diffDecisions(null, [
        { purposeId: "ä", value: "denied" },
        { purposeId: "z", value: "denied" },
        { purposeId: "A", value: "denied" },
      ]).map(({ purposeId }) => purposeId),
    ).toEqual(["A", "z", "ä"]);
  });
});
