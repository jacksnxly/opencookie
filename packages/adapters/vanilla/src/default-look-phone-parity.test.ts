import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// A bare "1fr" column is at least as wide as its content, so on a phone the
// longer of two one-line labels makes its choice wider than the other. Equal
// widths must come from the grid, and a label may wrap rather than widen.

describe("reject and accept on a phone", () => {
  it("share the row in two columns that cannot differ", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    const css =
      document.querySelector("style[data-opencookie]")?.textContent ?? "";
    const phone = css.slice(css.indexOf("@media (max-width:36rem)"));
    expect(phone).toMatch(
      /\.oc-bar-actions\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
    );
    expect(css).not.toMatch(/grid-template-columns:1fr 1fr/);
    started.destroy();
    window.close();
  });
});
