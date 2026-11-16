import { describe, expect, it } from "vitest";

import { resolveGpcRestrictions, resolveGpcSignal } from "./index.js";

describe("GPC processing restrictions", () => {
  it("orders mapped identifiers by runtime-independent code units", () => {
    const restrictions = resolveGpcRestrictions({
      resolution: resolveGpcSignal({
        navigationId: "navigation-order",
        observations: [
          {
            navigationId: "navigation-order",
            observedAtMs: 1,
            source: "browser",
            value: "enabled",
          },
        ],
      }),
      whenEnabled: {
        purposeIds: ["äther", "zeta"],
        resourceIds: ["äther", "zeta"],
        serviceIds: ["äther", "zeta"],
      },
    });

    expect(restrictions.purposeIds).toEqual(["zeta", "äther"]);
    expect(restrictions.resourceIds).toEqual(["zeta", "äther"]);
    expect(restrictions.serviceIds).toEqual(["zeta", "äther"]);
  });

  it("TEST-GPC-DOES-NOT-MUTATE-CONSENT keeps the consent record deeply unchanged", () => {
    const decisions = Object.freeze([
      Object.freeze({ decision: "granted", purposeId: "analytics" }),
      Object.freeze({ decision: "denied", purposeId: "advertising" }),
    ]);
    const consentRecord = Object.freeze({
      decisions,
      method: "granular",
      revision: 4,
    });
    const before = JSON.stringify(consentRecord);
    const resolution = resolveGpcSignal({
      navigationId: "navigation-1",
      observations: [
        {
          navigationId: "navigation-1",
          observedAtMs: 10,
          source: "server",
          value: "enabled",
        },
      ],
    });

    const restrictions = resolveGpcRestrictions({
      resolution,
      whenEnabled: {
        purposeIds: ["sale", "advertising", "sale"],
        resourceIds: ["tracking-pixel", "tracking-pixel"],
        serviceIds: ["ads", "audiences", "ads"],
      },
    });

    expect(restrictions).toEqual({
      purposeIds: ["advertising", "sale"],
      resourceIds: ["tracking-pixel"],
      serviceIds: ["ads", "audiences"],
      source: "gpc",
    });
    expect(Object.isFrozen(restrictions)).toBe(true);
    expect(Object.isFrozen(restrictions.purposeIds)).toBe(true);
    expect(JSON.stringify(consentRecord)).toBe(before);
    expect(consentRecord.decisions).toBe(decisions);
    expect(JSON.stringify(restrictions)).not.toContain("gpc-derived");
    expect("decisions" in restrictions).toBe(false);
    expect("method" in restrictions).toBe(false);
  });

  it("returns no restriction when the current navigation does not resolve enabled", () => {
    const restrictions = resolveGpcRestrictions({
      resolution: resolveGpcSignal({
        navigationId: "navigation-2",
        observations: [
          {
            navigationId: "navigation-2",
            observedAtMs: 10,
            source: "browser",
            value: "disabled",
          },
        ],
      }),
      whenEnabled: {
        purposeIds: ["sale"],
        resourceIds: ["tracking-pixel"],
        serviceIds: ["ads"],
      },
    });

    expect(restrictions).toEqual({
      purposeIds: [],
      resourceIds: [],
      serviceIds: [],
      source: "gpc",
    });
  });
});
