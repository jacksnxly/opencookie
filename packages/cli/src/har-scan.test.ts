import { describe, expect, it } from "vitest";

import { scanHar, type SessionScanObservation } from "./index.js";

function har(entries: readonly unknown[], extra: object = {}): string {
  return JSON.stringify({
    log: {
      browser: { name: "Safari", version: "26.0" },
      entries,
      pages: [
        {
          id: "page_1",
          startedDateTime: "2026-09-21T10:00:00.000Z",
          title: "https://shop.example.test/",
        },
      ],
      version: "1.2",
      ...extra,
    },
  });
}

function entry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    pageref: "page_1",
    request: { method: "GET", url: "https://shop.example.test/app.js" },
    response: {
      content: { mimeType: "application/javascript" },
      cookies: [],
      status: 200,
    },
    startedDateTime: "2026-09-21T10:00:01.000Z",
    ...overrides,
  };
}

function find(
  observations: readonly SessionScanObservation[],
  name: string,
): SessionScanObservation | undefined {
  return observations.find((observation) => observation.name === name);
}

describe("scanning a recorded session", () => {
  it("reports a cookie the session actually set as observed", () => {
    const observations = scanHar(
      har([
        entry({
          response: {
            content: { mimeType: "text/html" },
            cookies: [{ domain: ".example.test", name: "_ga", value: "1" }],
            status: 200,
          },
        }),
      ]),
    );

    const cookie = find(observations, "_ga");
    expect(cookie?.kind).toBe("cookie");
    expect(cookie?.uncertainty).toBe("observed");
    expect(cookie?.browser).toBe("Safari 26.0");
    expect(cookie?.source).toBe("https://shop.example.test/");
    expect(cookie?.observedAt).toBe("2026-09-21T10:00:01.000Z");
  });

  it("reports scripts, cross-origin destinations and beacons", () => {
    const observations = scanHar(
      har([
        entry({
          request: { method: "GET", url: "https://cdn.tracker.test/tag.js" },
        }),
        entry({
          request: { method: "GET", url: "https://fonts.example.test/a.woff2" },
          response: {
            content: { mimeType: "font/woff2" },
            cookies: [],
            status: 200,
          },
        }),
        entry({
          _resourceType: "ping",
          request: { method: "POST", url: "https://beacon.tracker.test/e" },
          response: {
            content: { mimeType: "text/plain" },
            cookies: [],
            status: 204,
          },
        }),
      ]),
    );

    expect(find(observations, "https://cdn.tracker.test/tag.js")?.kind).toBe(
      "script",
    );
    expect(find(observations, "https://fonts.example.test/a.woff2")?.kind).toBe(
      "network-destination",
    );
    expect(find(observations, "https://beacon.tracker.test/e")?.kind).toBe(
      "beacon",
    );
  });

  // A request back to the site's own origin is not by itself a consent
  // concern, and reporting every one would bury the findings that are.
  it("leaves same-origin requests that are not scripts alone", () => {
    const observations = scanHar(
      har([
        entry({
          request: { method: "GET", url: "https://shop.example.test/api/cart" },
          response: {
            content: { mimeType: "application/json" },
            cookies: [],
            status: 200,
          },
        }),
      ]),
    );

    expect(observations).toHaveLength(0);
  });

  it("records the same cookie once per session it was seen in", () => {
    const cookie = { domain: ".example.test", name: "sid", value: "x" };
    const observations = scanHar(
      har([
        entry({
          response: {
            content: { mimeType: "text/html" },
            cookies: [cookie],
            status: 200,
          },
        }),
        entry({
          response: {
            content: { mimeType: "text/html" },
            cookies: [cookie],
            status: 200,
          },
        }),
      ]),
    );

    expect(
      observations.filter((observation) => observation.name === "sid"),
    ).toHaveLength(1);
  });

  it("says the browser is unknown when the recording does not name one", () => {
    const observations = scanHar(
      JSON.stringify({
        log: {
          entries: [
            entry({
              request: { method: "GET", url: "https://cdn.tracker.test/t.js" },
            }),
          ],
          version: "1.2",
        },
      }),
    );

    expect(observations[0]?.browser).toBe("unknown");
  });

  // A recorder can split one Set-Cookie header at the comma inside its
  // Expires date and file the rest as a cookie. RFC 6265 names a cookie with a
  // token, so a name that is not one is left out and handed back instead.
  it.each([
    "21 Oct 2027 07:28:00 GMT",
    "has space",
    "semi;colon",
    "a=b",
    "(paren)",
  ])("leaves out the cookie name %j and hands it back", (bogus) => {
    const skipped: string[] = [];
    const observations = scanHar(
      har([
        entry({
          response: {
            content: { mimeType: "text/html" },
            cookies: [
              { name: "sid", value: "x" },
              { name: bogus, value: "" },
            ],
            status: 200,
          },
        }),
      ]),
      undefined,
      (name) => skipped.push(name),
    );

    expect(find(observations, "sid")?.kind).toBe("cookie");
    expect(find(observations, bogus)).toBeUndefined();
    expect(skipped).toEqual([bogus]);
  });

  it("keeps every name a token allows", () => {
    const names = ["__Secure-id", "_ga_A1B2", "AMCV_X%40Org", "a!#$&'*+.^`|~"];
    const skipped: string[] = [];
    const observations = scanHar(
      har([
        entry({
          response: {
            content: { mimeType: "text/html" },
            cookies: names.map((name) => ({ name, value: "1" })),
            status: 200,
          },
        }),
      ]),
      undefined,
      (name) => skipped.push(name),
    );

    expect(observations.map(({ name }) => name)).toEqual(
      expect.arrayContaining(names),
    );
    expect(skipped).toEqual([]);
  });

  // Playwright's recorder puts the page's title in pages[].title, not its
  // address, and starts a new page for each navigation. Each page's own
  // address is then its first document; a later navigation is a page of the
  // session, not an embedded frame.
  it("takes a page's address from its first document when the title is not one", () => {
    const documentEntry = (pageref: string, url: string) =>
      entry({
        _resourceType: "document",
        pageref,
        request: { method: "GET", url },
        response: {
          content: { mimeType: "text/html" },
          cookies: [],
          status: 200,
        },
      });
    const observations = scanHar(
      JSON.stringify({
        log: {
          browser: { name: "Chromium", version: "141.0" },
          entries: [
            documentEntry("page@1", "https://shop.example.test/"),
            documentEntry("page@2", "https://shop.example.test/about"),
            documentEntry("page@2", "https://player.video.test/embed"),
          ],
          pages: [
            { id: "page@1", title: "Shop" },
            { id: "page@2", title: "About us" },
          ],
          version: "1.2",
        },
      }),
    );

    expect(
      find(observations, "https://shop.example.test/about"),
    ).toBeUndefined();
    const frame = find(observations, "https://player.video.test/embed");
    expect(frame?.kind).toBe("iframe");
    expect(frame?.source).toBe("https://shop.example.test/about");
  });

  // A first-party proxy relays a vendor's events through the site's own
  // origin. Asked to, the scan keeps same-origin requests so one can be
  // decided; by default it still leaves them out.
  it("keeps same-origin requests when asked to", () => {
    const relay = entry({
      request: { method: "POST", url: "https://shop.example.test/relay/e/" },
      response: {
        content: { mimeType: "application/json" },
        cookies: [],
        status: 200,
      },
    });

    const kept = scanHar(har([relay]), undefined, undefined, {
      includeSameOrigin: true,
    });

    expect(find(kept, "https://shop.example.test/relay/e/")?.kind).toBe(
      "network-destination",
    );
    expect(scanHar(har([relay]))).toHaveLength(0);
  });

  it("refuses a document that is not a recording", () => {
    expect(() => scanHar("{ not json")).toThrow(/recording/iu);
    expect(() => scanHar(JSON.stringify({ log: {} }))).toThrow(/recording/iu);
  });

  // A sub-document request is a frame the page embedded. Reporting it as a
  // plain network destination would lose what it is, and an iframe is the kind
  // an operator most often has to block.
  it("reports an embedded document as an iframe", () => {
    const observations = scanHar(
      har([
        entry({
          _resourceType: "document",
          request: { method: "GET", url: "https://shop.example.test/" },
          response: {
            content: { mimeType: "text/html" },
            cookies: [],
            status: 200,
          },
        }),
        entry({
          _resourceType: "document",
          request: { method: "GET", url: "https://player.video.test/embed" },
          response: {
            content: { mimeType: "text/html" },
            cookies: [],
            status: 200,
          },
        }),
      ]),
    );

    expect(find(observations, "https://player.video.test/embed")?.kind).toBe(
      "iframe",
    );
    expect(find(observations, "https://shop.example.test/")).toBeUndefined();
  });

  // Chromium calls a sendBeacon request "ping"; WebKit and Firefox call it
  // "beacon". Reading only one of them would file a beacon recorded in Safari
  // as an ordinary network destination.
  it.each(["beacon", "ping"])(
    "reports a %s resource type as a beacon",
    (resourceType) => {
      const observations = scanHar(
        har([
          entry({
            _resourceType: resourceType,
            request: { method: "POST", url: "https://collect.tracker.test/e" },
            response: {
              content: { mimeType: "text/plain" },
              cookies: [],
              status: 204,
            },
          }),
        ]),
      );

      expect(find(observations, "https://collect.tracker.test/e")?.kind).toBe(
        "beacon",
      );
    },
  );

  // A HAR exported from a browser's own developer tools often names the
  // inspector rather than the browser, so the operator can say which browser
  // they used. They may not relabel a recording that names one for itself.
  it("takes the browser from the operator when the recording names none", () => {
    const observations = scanHar(
      JSON.stringify({
        log: {
          entries: [
            entry({
              request: { method: "GET", url: "https://cdn.tracker.test/t.js" },
            }),
          ],
          version: "1.2",
        },
      }),
      "Safari 26.0",
    );

    expect(observations[0]?.browser).toBe("Safari 26.0");
  });

  it("refuses to relabel a recording that names its own browser", () => {
    expect(() => scanHar(har([entry()]), "Firefox 153")).toThrow(
      /says it was made in Safari 26\.0, not Firefox 153/u,
    );
  });

  it("accepts an operator who names the same browser the recording does", () => {
    const observations = scanHar(har([entry()]), "Safari 26.0");
    expect(observations[0]?.browser).toBe("Safari 26.0");
  });

  // A recording comes from whatever tool the operator had. These are the parts
  // a real export leaves out, and each one has an answer that does not invent
  // anything.
  describe("a recording that leaves parts out", () => {
    it("keeps a cookie from an entry whose request has no address", () => {
      const observations = scanHar(
        har([
          {
            pageref: "page_1",
            request: {},
            response: {
              content: { mimeType: "text/html" },
              cookies: [{ name: "sid" }],
            },
            startedDateTime: "2026-09-21T10:00:01.000Z",
          },
        ]),
      );

      expect(observations.map(({ name }) => name)).toEqual(["sid"]);
    });

    it("reads an entry that reports no cookies and no media type", () => {
      const observations = scanHar(
        har([
          {
            pageref: "page_1",
            request: { url: "https://cdn.other.test/thing" },
            response: {},
            startedDateTime: "2026-09-21T10:00:01.000Z",
          },
        ]),
      );

      expect(find(observations, "https://cdn.other.test/thing")?.kind).toBe(
        "network-destination",
      );
    });

    it("falls back to the first recorded address when there are no pages", () => {
      const observations = scanHar(
        JSON.stringify({
          log: {
            browser: { name: "Safari", version: "26.0" },
            entries: [
              entry({
                request: { method: "GET", url: "https://shop.example.test/" },
                response: {
                  content: { mimeType: "text/html" },
                  cookies: [{ name: "sid" }],
                },
              }),
              entry({
                request: { method: "GET", url: "https://cdn.other.test/t.js" },
              }),
            ],
            version: "1.2",
          },
        }),
      );

      expect(find(observations, "sid")?.source).toBe(
        "https://shop.example.test/",
      );
    });

    it("says the source is unknown when nothing names a page", () => {
      const observations = scanHar(
        JSON.stringify({
          log: {
            entries: [
              {
                request: { url: "ftp://files.example.test/x" },
                response: { content: {}, cookies: [{ name: "sid" }] },
                startedDateTime: "2026-09-21T10:00:01.000Z",
              },
            ],
            version: "1.2",
          },
        }),
      );

      expect(find(observations, "sid")?.source).toBe("unknown");
    });

    it("says the time is unknown when an entry carries none", () => {
      const observations = scanHar(
        har([
          {
            pageref: "page_1",
            request: { url: "https://cdn.other.test/t.js" },
            response: { content: { mimeType: "application/javascript" } },
          },
        ]),
      );

      expect(observations[0]?.observedAt).toBe("unknown");
    });

    it("names a browser that reports no version", () => {
      const observations = scanHar(
        JSON.stringify({
          log: {
            browser: { name: "Safari" },
            entries: [
              entry({
                request: { method: "GET", url: "https://cdn.other.test/t.js" },
              }),
            ],
            version: "1.2",
          },
        }),
      );

      expect(observations[0]?.browser).toBe("Safari");
    });

    it("treats a blank browser from the operator as none given", () => {
      const observations = scanHar(har([entry()]), "   ");
      expect(observations[0]?.browser).toBe("Safari 26.0");
    });

    it("leaves out a request that is not http or https", () => {
      const observations = scanHar(
        har([
          entry({
            request: { method: "GET", url: "ftp://files.other.test/x" },
            response: { content: { mimeType: "text/plain" }, cookies: [] },
          }),
        ]),
      );

      expect(observations).toHaveLength(0);
    });

    it("reads an entry that has no request or response at all", () => {
      const observations = scanHar(
        har([
          { pageref: "page_1", startedDateTime: "2026-09-21T10:00:01.000Z" },
          entry({
            request: { method: "GET", url: "https://cdn.other.test/t.js" },
          }),
        ]),
      );

      expect(observations.map(({ name }) => name)).toEqual([
        "https://cdn.other.test/t.js",
      ]);
    });

    it("says the time is unknown when it is not a string", () => {
      const observations = scanHar(
        har([
          entry({
            request: { method: "GET", url: "https://cdn.other.test/t.js" },
            startedDateTime: 1_790_000_000_000,
          }),
        ]),
      );

      expect(observations[0]?.observedAt).toBe("unknown");
    });

    it("reads a page served over plain http", () => {
      const observations = scanHar(
        JSON.stringify({
          log: {
            browser: { name: "Safari", version: "26.0" },
            entries: [
              entry({
                request: { method: "GET", url: "http://shop.example.test/" },
                response: {
                  content: { mimeType: "text/html" },
                  cookies: [{ name: "sid" }],
                },
              }),
            ],
            version: "1.2",
          },
        }),
      );

      expect(find(observations, "sid")?.source).toBe(
        "http://shop.example.test/",
      );
    });

    it("uses the page an entry names, not the first one recorded", () => {
      const observations = scanHar(
        JSON.stringify({
          log: {
            browser: { name: "Safari", version: "26.0" },
            entries: [
              entry({
                pageref: "page_2",
                request: { method: "GET", url: "https://cdn.other.test/t.js" },
              }),
            ],
            pages: [
              { id: "page_1", title: "https://shop.example.test/" },
              { id: "page_2", title: "https://shop.example.test/checkout" },
            ],
            version: "1.2",
          },
        }),
      );

      expect(observations[0]?.source).toBe(
        "https://shop.example.test/checkout",
      );
    });

    it("takes the page from the first entry that has a web address", () => {
      const observations = scanHar(
        JSON.stringify({
          log: {
            entries: [
              {
                request: { url: "ftp://files.example.test/x" },
                response: { content: {}, cookies: [] },
                startedDateTime: "2026-09-21T10:00:00.000Z",
              },
              entry({
                request: { method: "GET", url: "https://shop.example.test/" },
                response: {
                  content: { mimeType: "text/html" },
                  cookies: [{ name: "sid" }],
                },
              }),
            ],
            version: "1.2",
          },
        }),
      );

      expect(find(observations, "sid")?.source).toBe(
        "https://shop.example.test/",
      );
    });

    it("skips a cookie the recording did not name", () => {
      const observations = scanHar(
        har([
          entry({
            response: {
              content: { mimeType: "text/html" },
              cookies: [{ value: "1" }, { name: "sid" }],
            },
          }),
        ]),
      );

      expect(observations.map(({ name }) => name)).toEqual(["sid"]);
    });

    it("refuses a document that is only null", () => {
      expect(() => scanHar("null")).toThrow(/recording/iu);
      expect(() => scanHar("{}")).toThrow(/recording/iu);
    });
  });
});
