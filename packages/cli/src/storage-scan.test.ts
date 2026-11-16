import { describe, expect, it } from "vitest";

import { scanStorageSnapshot } from "./index.js";

function snapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    local: ["_ga", "cart"],
    page: "https://shop.example.test/checkout",
    recordedAt: "2026-09-21T10:00:00.000Z",
    session: ["step"],
    ...overrides,
  });
}

describe("reading a browser storage snapshot", () => {
  it("records every key an operator found in the browser", () => {
    const observations = scanStorageSnapshot(snapshot(), "Safari 26.0");

    expect(observations.map(({ name }) => name)).toEqual([
      "local:_ga",
      "local:cart",
      "session:step",
    ]);
    for (const observation of observations) {
      expect(observation.kind).toBe("storage");
      expect(observation.uncertainty).toBe("observed");
      expect(observation.browser).toBe("Safari 26.0");
      expect(observation.source).toBe("https://shop.example.test/checkout");
      expect(observation.observedAt).toBe("2026-09-21T10:00:00.000Z");
    }
  });

  // localStorage and sessionStorage are different stores with different
  // lifetimes, so one key name in both is two findings, not one.
  it("keeps the two stores apart when a key is in both", () => {
    const observations = scanStorageSnapshot(
      snapshot({ local: ["sid"], session: ["sid"] }),
      "Safari 26.0",
    );

    expect(observations.map(({ name }) => name)).toEqual([
      "local:sid",
      "session:sid",
    ]);
  });

  // Each refusal asserts its own message. A message that merely mentions a
  // snapshot would also match a missing function, and prove nothing.
  it.each([
    ["not json", "{ broken", /is not a Web Storage snapshot/u],
    [
      "no page",
      JSON.stringify({ local: [], session: [] }),
      /names no page, or one that is not a web address/u,
    ],
    [
      "a page that is not a web address",
      snapshot({ page: "file:///tmp/x" }),
      /names no page, or one that is not a web address/u,
    ],
    [
      "keys that are not names",
      snapshot({ local: [{}] }),
      /lists local entries that are not key names/u,
    ],
    [
      "no stores at all",
      JSON.stringify({ page: "https://shop.example.test/" }),
      /holds no local or session keys/u,
    ],
  ])("refuses a snapshot with %s", (_label, document, message) => {
    expect(() => scanStorageSnapshot(document, "Safari 26.0")).toThrow(message);
  });

  // A finding carries the browser it was seen in, because discovery is browser
  // dependent, and a snapshot cannot name one for itself.
  it("refuses to record without being told the browser", () => {
    expect(() => scanStorageSnapshot(snapshot(), "  ")).toThrow(
      /Name the browser the snapshot was taken in/u,
    );
  });

  // A snapshot is pasted together by hand from a browser console, so these are
  // the shapes that actually arrive when something goes slightly wrong.
  it.each([
    [
      "a store that is not a list",
      snapshot({ local: "_ga" }),
      /not key names/u,
    ],
    ["an empty key name", snapshot({ local: [""] }), /not key names/u],
    [
      "a page that is not text",
      snapshot({ page: 12 }),
      /names no page, or one that is not a web address/u,
    ],
    [
      "a page that is not an address at all",
      snapshot({ page: "not a url" }),
      /names no page, or one that is not a web address/u,
    ],
    ["a list instead of a snapshot", "[]", /not a Web Storage snapshot/u],
    ["nothing at all", "null", /not a Web Storage snapshot/u],
  ])("refuses %s", (_label, document, message) => {
    expect(() => scanStorageSnapshot(document, "Safari 26.0")).toThrow(message);
  });

  it("reads a page served over plain http", () => {
    const observations = scanStorageSnapshot(
      snapshot({ page: "http://shop.example.test/" }),
      "Safari 26.0",
    );

    expect(observations[0]?.source).toBe("http://shop.example.test/");
  });

  it("says the time is unknown when the snapshot carries none", () => {
    const observations = scanStorageSnapshot(
      snapshot({ recordedAt: 1_790_000_000_000 }),
      "Safari 26.0",
    );

    expect(observations[0]?.observedAt).toBe("unknown");
  });

  it("records the browser without the spaces around it", () => {
    const observations = scanStorageSnapshot(snapshot(), "  Safari 26.0  ");
    expect(observations[0]?.browser).toBe("Safari 26.0");
  });

  it("reads a snapshot that carries only one of the two stores", () => {
    const local = scanStorageSnapshot(
      JSON.stringify({ local: ["_ga"], page: "https://shop.example.test/" }),
      "Safari 26.0",
    );
    const session = scanStorageSnapshot(
      JSON.stringify({ page: "https://shop.example.test/", session: ["step"] }),
      "Safari 26.0",
    );

    expect(local.map(({ name }) => name)).toEqual(["local:_ga"]);
    expect(session.map(({ name }) => name)).toEqual(["session:step"]);
  });
});
