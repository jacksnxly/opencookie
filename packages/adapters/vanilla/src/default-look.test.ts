import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// The default look is a quiet card: rounded, softly shadowed, in the page's
// own type. And it never outranks the site: its stylesheet comes first in
// <head>, and its root rule has no specificity.

function page(head = "") {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.head.innerHTML = head;
  return { document: window.document as unknown as Document, window };
}

const sheet = (document: Document) =>
  document.querySelector("style[data-opencookie]")?.textContent ?? "";

describe("the default look", () => {
  it("has no square frame, hard shadow or serif title", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    const css = sheet(document);
    expect(css).not.toContain("Georgia");
    expect(css).not.toContain("8px 8px 0");
    expect(css).not.toContain("border-radius:0");
    expect(css).toContain("--oc-radius");
    expect(css).toContain("--oc-shadow");
    started.destroy();
    window.close();
  });

  it("puts its stylesheet before the site's own", async () => {
    const { document, window } = page(
      '<meta charset="utf-8"><style id="site">.oc-btn{border-radius:0}</style>',
    );
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    expect(document.head.firstElementChild).toBe(
      document.querySelector("style[data-opencookie]"),
    );
    started.destroy();
    window.close();
  });

  it("keeps the root rule at zero specificity", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    const css = sheet(document);
    expect(css).toMatch(/:where\(\.oc-root\)\{[^}]*font-family:inherit/);
    expect(css).not.toMatch(/(^|\})\.oc-root\{/);
    started.destroy();
    window.close();
  });

  it("styles reject and accept alike and marks settings as the quiet choice", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    const choice = (action: string) =>
      document.querySelector(`.oc-bar [data-oc-action="${action}"]`);
    expect(choice("reject-all")?.className).toBe(
      choice("accept-all")?.className,
    );
    expect(choice("settings")?.classList.contains("oc-btn--quiet")).toBe(true);
    expect(choice("settings")?.classList.contains("oc-btn--choice")).toBe(true);
    expect(choice("reject-all")?.classList.contains("oc-btn--quiet")).toBe(
      false,
    );
    started.destroy();
    window.close();
  });
});
