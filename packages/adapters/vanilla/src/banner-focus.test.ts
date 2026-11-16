import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// The banner root comes after the page's content, so a page's skip link stays
// the first stop for the keyboard. On a first visit, when nothing on the page
// has focus, focus moves into the bar so the keyboard and a screen reader meet
// the choice first. A page that already put focus somewhere keeps it, and a
// visitor who is asked again is not interrupted.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const PAGE =
  '<a id="skip" href="#main">Skip to content</a><main id="main"><button id="buy" type="button">Buy</button></main>';

function page() {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = PAGE;
  const document = window.document as unknown as Document;
  return { document, window };
}

describe("banner placement and focus", () => {
  it("puts the banner root after the page's content", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    const root = document.querySelector<HTMLElement>("[data-oc-root]");
    const skip = document.querySelector<HTMLElement>("#skip");
    const buy = document.querySelector<HTMLElement>("#buy");
    expect(root).not.toBeNull();
    // 4 is Node.DOCUMENT_POSITION_FOLLOWING: the root follows the page.
    expect((skip?.compareDocumentPosition(root as Node) ?? 0) & 4).toBe(4);
    expect((buy?.compareDocumentPosition(root as Node) ?? 0) & 4).toBe(4);
    started.destroy();
    window.close();
  });

  it("moves focus into the bar on a first visit when nothing has focus", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await settle();

    const bar = document.querySelector<HTMLElement>(".oc-bar");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(bar);
    started.destroy();
    window.close();
  });

  it("keeps focus where the page put it", async () => {
    const { document, window } = page();
    const buy = document.querySelector<HTMLElement>("#buy");
    buy?.focus();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await settle();

    expect(document.querySelector(".oc-bar")).not.toBeNull();
    expect(document.activeElement).toBe(buy);
    started.destroy();
    window.close();
  });

  it("moves focus to the launcher after a choice in the bar", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await settle();

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
      ?.click();
    await settle();

    expect(document.querySelector(".oc-bar")).toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[data-oc-action="open"]'),
    );
    started.destroy();
    window.close();
  });

  it("does not move focus when a visitor with a stored choice is asked again", async () => {
    const { document, window } = page();
    const first = bootstrapOpenCookie({ document, policyVersion: "policy-1" });
    await first.ready;
    await first.client.acceptAll();
    await settle();
    first.destroy();
    (document.activeElement as HTMLElement | null)?.blur();

    const again = bootstrapOpenCookie({ document, policyVersion: "policy-2" });
    await again.ready;
    await settle();

    expect(document.querySelector(".oc-bar")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    again.destroy();
    window.close();
  });
});
