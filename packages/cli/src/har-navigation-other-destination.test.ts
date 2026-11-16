import { describe, expect, it } from "vitest";

import { scanHar } from "./index.js";

// Sec-Fetch-Dest settles what a document was only when it says "document" or
// names a frame. Any other value settles nothing, so the recording is read as
// one without the header: a second document is still a frame to classify.

function documentEntry(url: string, dest: string): Record<string, unknown> {
  return {
    _resourceType: "document",
    pageref: "page@1",
    request: {
      headers: [{ name: "sec-fetch-dest", value: dest }],
      method: "GET",
      url,
    },
    response: { content: { mimeType: "text/html" }, cookies: [], status: 200 },
    startedDateTime: "2026-11-11T10:00:00.000Z",
  };
}

describe("a document whose destination is neither a page nor a frame", () => {
  it("is still reported, as it was before the header was read", () => {
    const observations = scanHar(
      JSON.stringify({
        log: {
          browser: { name: "chromium", version: "151.0.7922.34" },
          entries: [
            documentEntry("https://shop.example.test/", "empty"),
            documentEntry("https://ads.vendor.test/slot", "fencedframe"),
          ],
          pages: [{ id: "page@1", title: "Shop" }],
          version: "1.2",
        },
      }),
    );

    const frame = observations.find(
      (observation) => observation.name === "https://ads.vendor.test/slot",
    );
    expect(frame?.kind).toBe("iframe");
    expect(frame?.source).toBe("https://shop.example.test/");
  });
});
