import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// The programmatic bootstrap reads Global Privacy Control itself when the
// site says which purposes the signal restricts. The signal restricts; it
// never records a decision.

function page(signal?: boolean) {
  const window = new Window({ url: "https://shop.example.test/" });
  if (signal !== undefined) {
    Object.defineProperty(window.navigator, "globalPrivacyControl", {
      configurable: true,
      value: signal,
    });
  }
  return { document: window.document as unknown as Document, window };
}

function analytics(document: Document) {
  document
    .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
    ?.click();
  return document.querySelector<HTMLInputElement>(
    'input[name="opencookie-purpose"][value="analytics"]',
  );
}

describe("the globalPrivacyControl option", () => {
  it("restricts the named purposes when the browser sends the signal", async () => {
    const { document, window } = page(true);
    const started = bootstrapOpenCookie({
      document,
      globalPrivacyControl: { purposeIds: ["analytics"] },
    });
    await started.ready;

    const input = analytics(document);
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(true);
    expect(input?.checked).toBe(false);
    started.destroy();
    window.close();
  });

  it("restricts nothing when the browser does not send it", async () => {
    for (const signal of [false, undefined]) {
      const { document, window } = page(signal);
      const started = bootstrapOpenCookie({
        document,
        globalPrivacyControl: { purposeIds: ["analytics"] },
      });
      await started.ready;

      const input = analytics(document);
      expect(input).not.toBeNull();
      expect(input?.disabled).toBe(false);
      started.destroy();
      window.close();
    }
  });

  it("refuses an empty list and a second source of restrictions", () => {
    const { document, window } = page(true);
    expect(() =>
      bootstrapOpenCookie({
        document,
        globalPrivacyControl: { purposeIds: [] },
      }),
    ).toThrow(TypeError);
    expect(() =>
      bootstrapOpenCookie({
        document,
        globalPrivacyControl: { purposeIds: ["analytics"] },
        privacyRestrictions: {} as never,
      }),
    ).toThrow(TypeError);
    expect(document.querySelector(".oc-root")).toBeNull();
    window.close();
  });
});
