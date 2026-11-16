import { describe, expect, it } from "vitest";

import { scanHar } from "./index.js";

// The usage says --browser <name>. A recording that names its browser with a
// version must accept the name alone, and keep the fuller recorded string.

const RECORDING = JSON.stringify({
  log: {
    browser: { name: "chromium", version: "153.0.8010.12" },
    entries: [
      {
        pageref: "page_1",
        request: { method: "GET", url: "https://cdn.vendor.test/v.js" },
        response: {
          content: { mimeType: "application/javascript" },
          cookies: [],
          status: 200,
        },
        startedDateTime: "2026-11-11T10:00:00.000Z",
      },
    ],
    pages: [{ id: "page_1", title: "https://shop.example.test/" }],
    version: "1.2",
  },
});

describe("naming the browser of a recording", () => {
  it("accepts the recorded browser's name without its version", () => {
    for (const declared of ["chromium", "Chromium", "chromium 153.0.8010.12"]) {
      expect(scanHar(RECORDING, declared)[0]?.browser).toBe(
        "chromium 153.0.8010.12",
      );
    }
  });

  it("still refuses a different browser", () => {
    expect(() => scanHar(RECORDING, "firefox")).toThrow(TypeError);
    expect(() => scanHar(RECORDING, "chromium 150")).toThrow(TypeError);
  });
});
