import { describe, expect, it } from "vitest";

import { VANILLA_COPY_DE, VANILLA_COPY_DE_DU } from "./index.js";

// The informal copy changes how the visitor is addressed and nothing else. A
// control that addresses nobody keeps the name it has in the formal copy, so
// the two versions of a site cannot drift apart.

const FORMAL = /\b(Sie|Ihr|Ihre|Ihrer|Ihres|Ihrem|Ihren)\b/;

describe("the informal German copy's control names", () => {
  it("equal the formal copy wherever it addresses nobody", () => {
    const keys = Object.keys(
      VANILLA_COPY_DE,
    ) as (keyof typeof VANILLA_COPY_DE)[];
    const unaddressed = keys.filter(
      (key) => !FORMAL.test(VANILLA_COPY_DE[key]),
    );

    expect(unaddressed).toContain("dismiss");
    expect(unaddressed).toContain("manage");
    expect(unaddressed).toContain("save");
    for (const key of unaddressed) {
      expect([key, VANILLA_COPY_DE_DU[key]]).toEqual([
        key,
        VANILLA_COPY_DE[key],
      ]);
    }
  });
});
