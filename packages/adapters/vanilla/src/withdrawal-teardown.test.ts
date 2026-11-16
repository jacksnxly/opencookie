import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { startAutoBootstrap } from "./auto-bootstrap.js";
import { bootstrapOpenCookie } from "./index.js";

// Pass B's M-C: a withdrawal in the visitor's own tab left a started tracker
// running, because only the site's other tabs reloaded. A script that ran
// cannot be unloaded, so once a decision that turns it off is stored, its own
// tab reloads too. Nothing else reloads it: not a denial when nothing was
// started, not a grant, and not a revoked frame, which is removed instead.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TRACKER = [
  '<script type="text/plain" data-src="https://tracker.example.test/t.js"',
  ' data-oc-resource="tracker" data-oc-category="analytics"></script>',
].join("");
const FRAME = [
  '<iframe data-src="https://video.example.test/embed"',
  ' data-oc-resource="video" data-oc-category="analytics"></iframe>',
].join("");

function pageWith(markup: string, storageKey = "opencookie.consent") {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = markup;
  // What the store held at the moment of each reload.
  const reloads: (string | null)[] = [];
  const reload = () => {
    reloads.push(window.localStorage.getItem(storageKey));
  };
  vi.spyOn(window.location, "reload").mockImplementation(reload);
  return {
    document: window.document as unknown as Document,
    reload,
    reloads,
    window,
  };
}

describe("a decision that turns off a script this tab started", () => {
  it("reloads the tab once the withdrawal is stored", async () => {
    const page = pageWith(TRACKER);
    const started = bootstrapOpenCookie({ document: page.document });
    await started.ready;
    await started.client.acceptAll();
    await settle();
    expect(page.reloads).toEqual([]);

    await started.client.withdrawConsent();
    await settle();

    expect(page.reloads).toHaveLength(1);
    expect(page.reloads[0]).toContain('"method":"withdrawal"');
    started.destroy();
    page.window.close();
  });

  it("reloads the tab once deselecting everything is stored", async () => {
    const page = pageWith(TRACKER);
    const started = bootstrapOpenCookie({ document: page.document });
    await started.ready;
    await started.client.acceptAll();
    await settle();

    await started.client.savePreferences([]);
    await settle();

    expect(page.reloads).toHaveLength(1);
    expect(page.reloads[0]).not.toContain('"method":"accept-all"');
    started.destroy();
    page.window.close();
  });

  it("reloads the drop-in's tab too", async () => {
    const page = pageWith(TRACKER);
    const script = page.document.createElement("script");
    page.document.head.append(script);
    const started = startAutoBootstrap(page.document, script, {
      reload: page.reload,
    });
    await started.ready;
    page.document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settle();
    page.document
      .querySelector<HTMLButtonElement>('[data-oc-action="open"]')
      ?.click();
    page.document
      .querySelector<HTMLButtonElement>('[data-oc-action="withdraw"]')
      ?.click();
    await settle();

    expect(page.reloads).toHaveLength(1);
    expect(page.reloads[0]).toContain('"method":"withdrawal"');
    started.destroy();
    page.window.close();
  });
});

describe("no reload", () => {
  it("for a denial when nothing was started", async () => {
    const page = pageWith(TRACKER);
    const started = bootstrapOpenCookie({ document: page.document });
    await started.ready;

    await started.client.rejectAll();
    await settle();

    expect(page.reloads).toEqual([]);
    started.destroy();
    page.window.close();
  });

  it("for a revoked frame, which is removed instead", async () => {
    const page = pageWith(FRAME);
    const started = bootstrapOpenCookie({ document: page.document });
    await started.ready;
    await started.client.acceptAll();
    await settle();
    expect(
      page.document.querySelector('[data-oc-active-resource="video"]'),
    ).not.toBeNull();

    await started.client.withdrawConsent();
    await settle();

    expect(page.reloads).toEqual([]);
    expect(
      page.document.querySelector('[data-oc-active-resource="video"]'),
    ).toBeNull();
    started.destroy();
    page.window.close();
  });

  it("for a withdrawal that failed to store, until its retry is stored", async () => {
    const storageKey = "failed-withdrawal";
    const page = pageWith(TRACKER, storageKey);
    let storageAvailable = true;
    const storage = {
      getItem: (key: string) => page.window.localStorage.getItem(key),
      removeItem: (key: string) => {
        if (!storageAvailable) throw new Error("Storage remove unavailable.");
        page.window.localStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (!storageAvailable) throw new Error("Storage write unavailable.");
        page.window.localStorage.setItem(key, value);
      },
    };
    const started = bootstrapOpenCookie({
      document: page.document,
      storage,
      storageKey,
    });
    await started.ready;
    await started.client.acceptAll();
    await settle();

    storageAvailable = false;
    await started.client.withdrawConsent();
    await settle();
    expect(page.reloads).toEqual([]);

    const retry = page.document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-withdrawal"]',
    );
    expect(retry).not.toBeNull();
    storageAvailable = true;
    retry?.click();
    await settle();

    expect(page.reloads).toHaveLength(1);
    expect(page.reloads[0]).toContain('"method":"withdrawal"');
    started.destroy();
    page.window.close();
  });
});
