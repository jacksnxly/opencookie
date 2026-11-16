import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// The bar's choices come before its links in the DOM, so the keyboard reaches
// Reject all, Accept all and Settings before the links. At narrow widths the
// default look draws the choices above the links, and a site's own design may
// do so at every width.

describe("bar DOM order", () => {
  it("puts the choices before the links row", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({
      document,
      links: [
        { href: "/datenschutz", label: "Datenschutz" },
        { href: "/impressum", label: "Impressum" },
      ],
    });
    await started.ready;

    const order = [
      ...document.querySelectorAll<HTMLElement>(".oc-bar button, .oc-bar a"),
    ]
      .filter((control) => !control.classList.contains("oc-btn--dismiss"))
      .map((control) => control.dataset["ocAction"] ?? control.textContent);
    expect(order).toEqual([
      "reject-all",
      "accept-all",
      "settings",
      "Datenschutz",
      "Impressum",
    ]);
    started.destroy();
    window.close();
  });

  it("keeps the close button first", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({
      document,
      links: [{ href: "/datenschutz", label: "Datenschutz" }],
    });
    await started.ready;

    const first = document.querySelector<HTMLElement>(
      ".oc-bar button, .oc-bar a",
    );
    expect(first?.dataset["ocAction"]).toBe("dismiss");
    started.destroy();
    window.close();
  });
});
