import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// A mistyped purpose id would restrict nothing while the site believes the
// signal is honoured. That is a configuration error, whatever the browser
// sends, and it is refused before anything is mounted.

describe("a globalPrivacyControl purpose the policy does not have", () => {
  it("is refused, with or without the signal", () => {
    for (const signal of [true, false]) {
      const window = new Window({ url: "https://shop.example.test/" });
      Object.defineProperty(window.navigator, "globalPrivacyControl", {
        configurable: true,
        value: signal,
      });
      const document = window.document as unknown as Document;

      expect(() =>
        bootstrapOpenCookie({
          document,
          globalPrivacyControl: { purposeIds: ["analytics", "analytcs"] },
        }),
      ).toThrow(TypeError);
      expect(document.querySelector(".oc-root")).toBeNull();
      window.close();
    }
  });
});
