import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// The three choices get their width from the grid, never from a label, so a
// longer label can neither widen its own choice nor spill out of it: it wraps.

describe("the choices' size", () => {
  it("sizes the choices by the grid and lets a label wrap", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    const css =
      document.querySelector("style[data-opencookie]")?.textContent ?? "";
    expect(css).toMatch(
      /\.oc-bar-actions\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
    );
    expect(css).toMatch(/\.oc-btn\{[^}]*overflow-wrap:anywhere/);
    expect(css).not.toContain("white-space:nowrap");
    started.destroy();
    window.close();
  });

  it("is never left to the label's length in a template", () => {
    for (const template of ["soft", "minimal"]) {
      const css = readFileSync(
        new URL(`../templates/${template}.css`, import.meta.url),
        "utf8",
      );
      expect([template, /repeat\(\s*3\s*,\s*auto\s*\)/.test(css)]).toEqual([
        template,
        false,
      ]);
      expect([template, /nowrap|11rem/.test(css)]).toEqual([template, false]);
    }
  });
});
