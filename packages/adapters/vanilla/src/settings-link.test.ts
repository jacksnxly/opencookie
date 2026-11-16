import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { startAutoBootstrap } from "./auto-bootstrap.js";
import { bootstrapOpenCookie } from "./index.js";

// A site's own "Cookie settings" link must reopen the choices on every entry
// point, including the drop-in, which exposes no API. Any element carrying
// data-oc-open-preferences does, whenever it is added.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const LINK =
  '<footer><a href="#privacy" data-oc-open-preferences><span>Cookie settings</span></a></footer>';

function page(markup = LINK) {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = markup;
  const document = window.document as unknown as Document;
  const dialog = () => {
    const panel = document.querySelector<HTMLDialogElement>("dialog.oc-panel");
    if (panel === null) throw new Error("The settings panel is missing.");
    return panel;
  };
  const click = (element: Element | null) => {
    if (element === null) throw new Error("Nothing to click.");
    const event = new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event as unknown as MouseEvent);
    return event.defaultPrevented;
  };
  return { click, dialog, document, window };
}

describe("a data-oc-open-preferences link", () => {
  it("opens the choices while the bar is still asking, without navigating", async () => {
    const { click, dialog, document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    expect(document.querySelector(".oc-bar")).not.toBeNull();

    const prevented = click(document.querySelector("footer span"));
    await settle();

    expect(prevented).toBe(true);
    expect(dialog().open).toBe(true);
    started.destroy();
    window.close();
  });

  it("opens them after a decision, and closing returns focus to the link", async () => {
    const { click, dialog, document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await started.client.rejectAll();
    await settle();

    click(document.querySelector("[data-oc-open-preferences]"));
    await settle();
    expect(dialog().open).toBe(true);

    click(dialog().querySelector('[data-oc-action="close"]'));
    await settle();
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(
      document.querySelector("[data-oc-open-preferences]"),
    );
    started.destroy();
    window.close();
  });

  it("works when the link is added after the banner", async () => {
    const { click, dialog, document, window } = page("<main></main>");
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    document
      .querySelector("main")
      ?.insertAdjacentHTML(
        "beforeend",
        '<button type="button" data-oc-open-preferences>Privacy</button>',
      );

    click(document.querySelector("main button"));
    await settle();

    expect(dialog().open).toBe(true);
    started.destroy();
    window.close();
  });

  // A client-side router, such as Astro's, handles same-origin link clicks on
  // document and skips a click whose default was already prevented. One
  // registered before the banner navigated the settings link's hash.
  it("prevents the default before a router registered earlier sees the click", async () => {
    const { click, dialog, document, window } = page();
    const routerSawPrevented: boolean[] = [];
    document.addEventListener("click", (event) => {
      routerSawPrevented.push(event.defaultPrevented);
    });
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    click(document.querySelector("footer a"));
    await settle();

    expect(routerSawPrevented).toEqual([true]);
    expect(dialog().open).toBe(true);
    started.destroy();
    window.close();
  });

  it("does nothing once the banner is destroyed", async () => {
    const { click, document, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    started.destroy();

    const prevented = click(document.querySelector("footer a"));

    expect(prevented).toBe(false);
    window.close();
  });

  it("works with the drop-in", async () => {
    const { click, dialog, document, window } = page();
    const script = document.createElement("script");
    document.head.append(script);
    const started = startAutoBootstrap(document, script);
    await started.ready;

    click(document.querySelector("footer a"));
    await settle();

    expect(dialog().open).toBe(true);
    started.destroy();
    window.close();
  });
});
