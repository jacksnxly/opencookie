import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// A browser reads a backslash in an address as a slash, so "/\host" leaves
// the site, and it drops tabs and line breaks inside a scheme. Neither is a
// path on this site. A label is text, never markup.

describe("banner links that only look local", () => {
  it("refuses backslashes and control characters", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    for (const href of [
      "/\\other.example.test",
      "/privacy\\policy",
      "/pri\tvacy",
      "/pri\nvacy",
      "https://shop.example.test/a\\b",
    ]) {
      expect(() =>
        bootstrapOpenCookie({ document, links: [{ href, label: "Privacy" }] }),
      ).toThrow(TypeError);
    }
    expect(document.querySelector(".oc-root")).toBeNull();
    window.close();
  });

  it("renders a label as text", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({
      document,
      links: [{ href: "/privacy", label: "<b>Privacy</b>" }],
    });
    await started.ready;

    const link = document.querySelector(".oc-bar-links a.oc-link");
    expect(link?.textContent).toBe("<b>Privacy</b>");
    expect(link?.children.length).toBe(0);
    started.destroy();
    window.close();
  });
});
