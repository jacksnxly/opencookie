import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// The page watcher exists to bring the launcher back. It must not fight the
// page: a root something removed stays removed, and a page that loses its
// body must not make the watcher throw.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const LINK =
  '<footer><a href="#privacy" data-oc-open-preferences>Cookie settings</a></footer>';

async function decided() {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = LINK;
  const document = window.document as unknown as Document;
  const errors: string[] = [];
  window.addEventListener("error", (event) => {
    errors.push((event as unknown as ErrorEvent).message);
  });
  const started = bootstrapOpenCookie({ document, launcher: false });
  await started.ready;
  await started.client.rejectAll();
  await settle();
  return { document, errors, started, window };
}

describe("the page watcher under launcher: false", () => {
  it("does not put the interface back once something removed it", async () => {
    const { document, errors, started, window } = await decided();

    document.querySelector(".oc-root")?.remove();
    document.querySelector("footer")?.remove();
    await settle();
    await settle();

    expect(document.querySelector(".oc-root")).toBeNull();
    expect(errors).toEqual([]);
    started.destroy();
    window.close();
  });

  it("does not throw when the page loses its body", async () => {
    const { document, errors, started, window } = await decided();

    document.body.remove();
    await settle();
    await settle();

    expect(errors).toEqual([]);
    started.destroy();
    window.close();
  });
});
