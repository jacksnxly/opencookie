import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// A banner usually has to leave the privacy policy and the imprint reachable.
// The site names those links; OpenCookie renders them and refuses an address
// that could run script.

function page() {
  const window = new Window({ url: "https://shop.example.test/" });
  return { document: window.document as unknown as Document, window };
}

describe("links in the banner", () => {
  it("shows the site's links in the order given", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({
      document,
      links: [
        { href: "/datenschutz", label: "Datenschutz" },
        { href: "https://shop.example.test/impressum", label: "Impressum" },
      ],
    });
    await started.ready;

    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        ".oc-bar nav.oc-bar-links a.oc-link",
      ),
    ];
    expect(
      links.map((link) => [link.getAttribute("href"), link.textContent]),
    ).toEqual([
      ["/datenschutz", "Datenschutz"],
      ["https://shop.example.test/impressum", "Impressum"],
    ]);
    started.destroy();
    window.close();
  });

  it("renders no links row when the site names none", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    expect(document.querySelector(".oc-bar")).not.toBeNull();
    expect(document.querySelector(".oc-bar-links")).toBeNull();
    started.destroy();
    window.close();
  });

  it("refuses an address that is not http, https or a path on this site", () => {
    const { document, window } = page();
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//other.example.test/x",
      " ",
    ]) {
      expect(() =>
        bootstrapOpenCookie({ document, links: [{ href, label: "Privacy" }] }),
      ).toThrow(TypeError);
    }
    expect(() =>
      bootstrapOpenCookie({
        document,
        links: [{ href: "/privacy", label: " " }],
      }),
    ).toThrow(TypeError);
    expect(document.querySelector(".oc-root")).toBeNull();
    window.close();
  });
});
