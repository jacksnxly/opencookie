import { describe, expect, it } from "vitest";

import { terminalSafe } from "./terminal-text.js";

// Finding names come from recorded sessions, so a site can put escape
// sequences or line breaks in a cookie name. Printed raw, they could recolour
// the terminal, move the cursor, or forge a line that looks like a verdict.
describe("text a terminal shows", () => {
  it("shows control and line-separator characters as visible escapes", () => {
    expect(terminalSafe("a\u001b[2Kb\nc\rd\u0085e\u2028f\u202eg")).toBe(
      "a\\u{1b}[2Kb\\u{a}c\\u{d}d\\u{85}e\\u{2028}f\\u{202e}g",
    );
  });

  it("leaves ordinary text, including other scripts, as it is", () => {
    expect(terminalSafe("_ga — Datenschutz 🍪 ✓")).toBe(
      "_ga — Datenschutz 🍪 ✓",
    );
  });
});
