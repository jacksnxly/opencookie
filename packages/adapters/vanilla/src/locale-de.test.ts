import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import {
  mountOpenCookie,
  VANILLA_COPY_DE,
  type VanillaOpenCookieCopy,
} from "./index.js";
import { createTestClient } from "./index.test-helpers.js";

// Every key a visitor can be shown. Kept as a literal list so adding a key to
// the copy contract without translating it fails here rather than shipping a
// half-German banner.
const COPY_KEYS: readonly (keyof VanillaOpenCookieCopy)[] = [
  "acceptAll",
  "close",
  "description",
  "dismiss",
  "eyebrow",
  "lang",
  "manage",
  "notControlled",
  "open",
  "persistenceFailure",
  "rejectAll",
  "requires",
  "restricted",
  "retryPersistence",
  "save",
  "title",
  "withdrawConsent",
];

describe("German visitor experience", () => {
  it("translates every key the banner can show", () => {
    expect(Object.keys(VANILLA_COPY_DE).sort()).toEqual([...COPY_KEYS].sort());
    for (const key of COPY_KEYS) {
      expect(VANILLA_COPY_DE[key].trim().length, key).toBeGreaterThan(0);
    }
  });

  // WCAG 3.1.2: text in another language than the page must say so, or a
  // screen reader pronounces German with English rules, or the reverse.
  it("marks the interface with the language of its copy", async () => {
    const browserWindow = new Window();
    const document = browserWindow.document as unknown as Document;
    document.documentElement.lang = "fr";
    const german = mountOpenCookie({
      client: createTestClient(),
      copy: VANILLA_COPY_DE,
      document,
    });
    await german.ready;
    expect(document.querySelector("[data-oc-root]")?.getAttribute("lang")).toBe(
      "de",
    );
    german.destroy();
    const english = mountOpenCookie({ client: createTestClient(), document });
    await english.ready;
    expect(document.querySelector("[data-oc-root]")?.getAttribute("lang")).toBe(
      "en",
    );
    english.destroy();
    browserWindow.close();
  });

  it("keeps accept and reject equally direct", () => {
    expect(VANILLA_COPY_DE.acceptAll).toBe("Alle akzeptieren");
    expect(VANILLA_COPY_DE.rejectAll).toBe("Alle ablehnen");
  });

  it("renders German to a visitor", async () => {
    const browserWindow = new Window();
    const document = browserWindow.document as unknown as Document;
    const mount = mountOpenCookie({
      client: createTestClient(),
      copy: VANILLA_COPY_DE,
      document,
    });
    await mount.ready;
    const rendered = document.body.textContent;
    mount.destroy();
    browserWindow.close();

    expect(rendered).toContain("Alle ablehnen");
    expect(rendered).not.toContain("Reject all");
  });

  // A screen reader pronounces text by its language. On a German page the
  // German banner's nearest language scope must be German.
  it("inherits the page language so screen readers read it as German", async () => {
    const browserWindow = new Window();
    const document = browserWindow.document as unknown as Document;
    document.documentElement.lang = "de";
    const mount = mountOpenCookie({
      client: createTestClient(),
      copy: VANILLA_COPY_DE,
      document,
    });
    await mount.ready;
    const banner = document.querySelector(".oc-root");
    const scope = banner?.closest("[lang]")?.getAttribute("lang");
    mount.destroy();
    browserWindow.close();

    expect(banner).not.toBeNull();
    expect(scope).toBe("de");
  });
});
