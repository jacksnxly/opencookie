import { describe, expect, it } from "vitest";

import { scanHar } from "./index.js";

// Playwright's recorder writes one page per tab, so every later navigation in
// that tab shares the first one's pageref. The request's Sec-Fetch-Dest header
// tells a navigation ("document") from an embedded frame ("iframe").

function entry(
  url: string,
  dest: string | undefined,
  mimeType = "text/html",
): Record<string, unknown> {
  return {
    ...(mimeType === "text/html" ? { _resourceType: "document" } : {}),
    pageref: "page@1",
    request: {
      headers:
        dest === undefined ? [] : [{ name: "Sec-Fetch-Dest", value: dest }],
      method: "GET",
      url,
    },
    response: { content: { mimeType }, cookies: [], status: 200 },
    startedDateTime: "2026-11-11T10:00:00.000Z",
  };
}

function recording(entries: readonly unknown[]): string {
  return JSON.stringify({
    log: {
      browser: { name: "chromium", version: "151.0.7922.34" },
      entries,
      pages: [{ id: "page@1", title: "Shop" }],
      version: "1.2",
    },
  });
}

describe("a tab that navigates in one recording", () => {
  it("reads a later navigation as a page, and a frame as a frame", () => {
    const observations = scanHar(
      recording([
        entry("https://shop.example.test/", "document"),
        entry("https://player.video.test/embed", "iframe"),
        entry("https://shop.example.test/checkout", "document"),
        entry(
          "https://cdn.vendor.test/pay.js",
          "script",
          "application/javascript",
        ),
      ]),
    );

    const named = (name: string) =>
      observations.find((observation) => observation.name === name);
    expect(named("https://shop.example.test/checkout")).toBeUndefined();
    expect(named("https://player.video.test/embed")?.kind).toBe("iframe");
    expect(named("https://player.video.test/embed")?.source).toBe(
      "https://shop.example.test/",
    );
    expect(named("https://cdn.vendor.test/pay.js")?.source).toBe(
      "https://shop.example.test/checkout",
    );
  });

  it("still reads a second document as a frame when no header says otherwise", () => {
    const observations = scanHar(
      recording([
        entry("https://shop.example.test/", undefined),
        entry("https://player.video.test/embed", undefined),
      ]),
    );

    expect(
      observations.find(
        (observation) => observation.name === "https://player.video.test/embed",
      )?.kind,
    ).toBe("iframe");
  });
});
