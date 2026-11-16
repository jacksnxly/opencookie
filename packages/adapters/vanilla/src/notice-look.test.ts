import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// When storage refuses the decision, OpenCookie shows a notice with a retry
// button. By default it is the same card as the bar and the panel, so it never
// floats as bare text over the page.

describe("save-failure notice", () => {
  it("is drawn as a card by the default stylesheet", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    const css =
      document.querySelector("style[data-opencookie]")?.textContent ?? "";
    const rule = /\.oc-notice\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const declarations = rule.split(";");
    for (const declaration of [
      "position:fixed",
      "top:1rem",
      "right:1rem",
      "border:1px solid var(--oc-border)",
      "border-radius:var(--oc-radius)",
      "background:var(--oc-paper)",
      "box-shadow:var(--oc-shadow)",
      "padding:1rem",
    ]) {
      expect(declarations).toContain(declaration);
    }
    started.destroy();
    window.close();
  });
});
