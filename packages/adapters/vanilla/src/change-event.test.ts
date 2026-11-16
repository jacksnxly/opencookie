import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { startAutoBootstrap } from "./auto-bootstrap.js";
import {
  bootstrapOpenCookie,
  OPENCOOKIE_CHANGE_EVENT,
  type OpenCookieChangeDetail,
} from "./index.js";

// A bridge to a vendor OpenCookie does not load itself, such as an analytics
// SDK started from code, must hear what the visitor now permits, on every
// entry point including the drop-in, so it can stop the vendor itself.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TRACKER = [
  '<script type="text/plain" data-src="https://tracker.example.test/t.js"',
  ' data-oc-resource="tracker" data-oc-category="analytics"></script>',
].join("");

function page() {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = TRACKER;
  const document = window.document as unknown as Document;
  const log: string[] = [];
  const events: OpenCookieChangeDetail[] = [];
  document.addEventListener(OPENCOOKIE_CHANGE_EVENT, (event) => {
    const { detail } = event as CustomEvent<OpenCookieChangeDetail>;
    events.push(detail);
    log.push(`event:${detail.revoked.join(",")}`);
  });
  vi.spyOn(window.location, "reload").mockImplementation(() => {
    log.push("reload");
  });
  return { document, events, log, window };
}

describe(`the ${OPENCOOKIE_CHANGE_EVENT} event`, () => {
  it("reports the restored state once the banner is ready", async () => {
    const { document, events, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await settle();

    expect(events).toEqual([{ permitted: [], restored: true, revoked: [] }]);
    started.destroy();
    window.close();
  });

  it("reports a grant, then a withdrawal before the tab reloads", async () => {
    const { document, events, log, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    await started.client.acceptAll();
    await settle();
    expect(events.at(-1)).toEqual({
      permitted: ["analytics"],
      restored: false,
      revoked: [],
    });

    await started.client.withdrawConsent();
    await settle();
    expect(events.at(-1)).toEqual({
      permitted: [],
      restored: false,
      revoked: ["analytics"],
    });
    expect(log.slice(-2)).toEqual(["event:analytics", "reload"]);
    started.destroy();
    window.close();
  });

  it("reports a withdrawal even when storing it fails", async () => {
    const { document, events, window } = page();
    let storageAvailable = true;
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => {
        if (!storageAvailable) throw new Error("Storage remove unavailable.");
        window.localStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (!storageAvailable) throw new Error("Storage write unavailable.");
        window.localStorage.setItem(key, value);
      },
    };
    const started = bootstrapOpenCookie({ document, storage });
    await started.ready;
    await started.client.acceptAll();
    await settle();

    storageAvailable = false;
    await started.client.withdrawConsent();
    await settle();

    expect(started.client.getSnapshot().lastPersistenceStatus).toBe("failed");
    expect(events.at(-1)).toEqual({
      permitted: [],
      restored: false,
      revoked: ["analytics"],
    });
    started.destroy();
    window.close();
  });

  it("stays quiet when saving the same choices again, and after destroy", async () => {
    const { document, events, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await started.client.acceptAll();
    await settle();
    const count = events.length;

    await started.client.savePreferences(["analytics"]);
    await settle();
    expect(events).toHaveLength(count);

    started.destroy();
    await started.client.rejectAll().catch(() => undefined);
    await settle();
    expect(events).toHaveLength(count);
    window.close();
  });

  it("is sent by the drop-in", async () => {
    const { document, events, window } = page();
    const script = document.createElement("script");
    document.head.append(script);
    const started = startAutoBootstrap(document, script);
    await started.ready;
    await settle();

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settle();

    expect(events.map((event) => event.permitted)).toEqual([[], ["analytics"]]);
    started.destroy();
    window.close();
  });
});
