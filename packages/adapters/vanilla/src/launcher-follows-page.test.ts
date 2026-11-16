import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// Under launcher: false the page's own settings link stands in for the
// floating launcher. A single-page app can take that link away without a
// reload, and the choices must stay reachable when it does.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const LINK =
  '<footer><a href="#privacy" data-oc-open-preferences>Cookie settings</a></footer>';

describe("launcher: false on a page that changes", () => {
  it("brings the launcher back when the page's own link goes away, and takes it out when one returns", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    window.document.body.innerHTML = LINK;
    const document = window.document as unknown as Document;
    const launcher = () => document.querySelector('[data-oc-action="open"]');
    const started = bootstrapOpenCookie({ document, launcher: false });
    await started.ready;
    await started.client.rejectAll();
    await settle();
    expect(launcher()).toBeNull();

    document.querySelector("footer")?.remove();
    await settle();
    await settle();
    expect(launcher()).not.toBeNull();

    document.body.insertAdjacentHTML("beforeend", LINK);
    await settle();
    await settle();
    expect(launcher()).toBeNull();
    started.destroy();
    window.close();
  });
});
