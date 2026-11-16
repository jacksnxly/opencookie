import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookieFromHead } from "./index.js";

// A tag manager's inline snippet in <head> pushes to the data layer as soon as
// it runs. Google requires the Consent Mode default before any such command,
// so a bootstrap started from <head> must send it in its own task, although
// the banner cannot mount before the body is parsed.

const DENIED_DEFAULT = [
  "consent",
  "default",
  {
    ad_personalization: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    analytics_storage: "denied",
  },
];

const TRACKER = [
  '<script type="text/plain" data-src="https://tracker.example.test/t.js"',
  ' data-oc-resource="tracker" data-oc-category="analytics"></script>',
].join("");

/** A page whose parser is still in <head>: no body, readyState "loading". */
function parsingHead() {
  const window = new Window({ url: "https://shop.example.test/" });
  const document = window.document as unknown as Document;
  document.body.remove();
  let readyState: DocumentReadyState = "loading";
  Object.defineProperty(document, "readyState", {
    configurable: true,
    get: () => readyState,
  });
  const calls: unknown[][] = [];
  const gtag = (...call: unknown[]) => calls.push(call);
  const finishParsing = () => {
    const body = document.createElement("body");
    body.innerHTML = TRACKER;
    document.documentElement.append(body);
    readyState = "interactive";
    document.dispatchEvent(
      new window.Event("DOMContentLoaded") as unknown as Event,
    );
  };
  return { calls, document, finishParsing, gtag, window };
}

describe("bootstrapOpenCookieFromHead", () => {
  it("sends the Consent Mode default before a later head script, and mounts once parsed", async () => {
    const { calls, document, finishParsing, gtag, window } = parsingHead();

    const starting = bootstrapOpenCookieFromHead({
      document,
      googleConsentMode: {
        command: gtag,
        mapping: { analyticsStorageResourceIds: ["tracker"] },
        mode: "basic",
      },
      storage: window.localStorage,
    });
    gtag("config", "measurement-id");

    expect(calls).toEqual([DENIED_DEFAULT, ["config", "measurement-id"]]);
    expect(document.querySelector("[data-oc-root]")).toBeNull();

    finishParsing();
    const started = await starting;
    await started.ready;
    expect(document.querySelector(".oc-bar")).not.toBeNull();
    expect(calls.filter(([, action]) => action === "default")).toHaveLength(1);

    await started.client.acceptAll();
    expect(calls.at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "granted",
      },
    ]);
    expect(
      document.querySelector('[data-oc-active-resource="tracker"]'),
    ).not.toBeNull();
    started.destroy();
    window.close();
  });

  it("bootstraps at once when the document is already parsed", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    window.document.body.innerHTML = TRACKER;
    const document = window.document as unknown as Document;

    const started = await bootstrapOpenCookieFromHead({ document });
    await started.ready;

    expect(document.querySelector(".oc-bar")).not.toBeNull();
    started.destroy();
    window.close();
  });

  it("stays denied when the bootstrap fails after the default", async () => {
    const { calls, document, finishParsing, gtag, window } = parsingHead();

    const starting = bootstrapOpenCookieFromHead({
      document,
      googleConsentMode: { command: gtag, mapping: {}, mode: "basic" },
      policyVersion: " ",
      storage: window.localStorage,
    });
    finishParsing();

    await expect(starting).rejects.toThrow("Policy version cannot be blank.");
    expect(calls).toEqual([DENIED_DEFAULT]);
    expect(document.querySelector("[data-oc-root]")).toBeNull();
    window.close();
  });

  it("sends nothing when the Google mapping is invalid", async () => {
    const { calls, document, gtag, window } = parsingHead();

    await expect(
      bootstrapOpenCookieFromHead({
        document,
        googleConsentMode: {
          command: gtag,
          mapping: { analyticsStorageResourceIds: ["track​er"] },
          mode: "basic",
        },
      }),
    ).rejects.toThrow("Google Consent Mode resource mapping is invalid");
    expect(calls).toEqual([]);
    window.close();
  });
});
