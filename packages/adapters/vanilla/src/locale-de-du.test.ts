import { describe, expect, it } from "vitest";

import { VANILLA_COPY_DE, VANILLA_COPY_DE_DU } from "./index.js";

// German sites that address visitors informally need the whole surface in
// "du", not five overridden strings.

describe("the informal German copy", () => {
  it("has every string the formal copy has", () => {
    expect(Object.keys(VANILLA_COPY_DE_DU).sort()).toEqual(
      Object.keys(VANILLA_COPY_DE).sort(),
    );
    expect(VANILLA_COPY_DE_DU.lang).toBe("de");
  });

  it("never addresses the visitor formally", () => {
    for (const text of Object.values(VANILLA_COPY_DE_DU)) {
      expect(text).not.toMatch(/\b(Sie|Ihr|Ihre|Ihrer|Ihres|Ihrem|Ihren)\b/);
    }
  });

  it("keeps both choices as short and direct as the formal copy", () => {
    expect(VANILLA_COPY_DE_DU.acceptAll).toBe(VANILLA_COPY_DE.acceptAll);
    expect(VANILLA_COPY_DE_DU.rejectAll).toBe(VANILLA_COPY_DE.rejectAll);
  });
});
