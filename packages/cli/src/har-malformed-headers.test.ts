import { describe, expect, it } from "vitest";

import { scanHar } from "./index.js";

// A recording is outside input. Headers that are not a list of name and value
// pairs say nothing about the request; they must not stop the scan, which
// read such a recording before the headers were looked at.

function recording(headers: unknown): string {
  return JSON.stringify({
    log: {
      browser: { name: "Safari", version: "26.0" },
      entries: [
        {
          _resourceType: "document",
          pageref: "page_1",
          request: {
            headers,
            method: "GET",
            url: "https://shop.example.test/",
          },
          response: {
            content: { mimeType: "text/html" },
            cookies: [{ name: "_ga", value: "1" }],
            status: 200,
          },
          startedDateTime: "2026-11-11T10:00:00.000Z",
        },
      ],
      pages: [{ id: "page_1", title: "https://shop.example.test/" }],
      version: "1.2",
    },
  });
}

describe("a recording with malformed request headers", () => {
  it("is still scanned", () => {
    for (const headers of [{}, "sec-fetch-dest: document", [null], [7], 3]) {
      const observations = scanHar(recording(headers));

      expect(observations.map((observation) => observation.name)).toEqual([
        "_ga",
      ]);
    }
  });
});
