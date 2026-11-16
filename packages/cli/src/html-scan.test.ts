import { describe, expect, it } from "vitest";

import { scanHtml } from "./index.js";

const PAGE = "https://shop.example.test/checkout/";
const AT = "2026-09-21T12:00:00.000Z";

function find(html: string) {
  return scanHtml(html, PAGE, AT);
}

describe("static HTML discovery", () => {
  it("finds declared scripts, iframes and preconnected destinations", () => {
    const found = find(`<!doctype html><html><head>
      <link rel="preconnect" href="https://fonts.example-cdn.test">
      <script src="https://tracker.example-ads.test/tag.js"></script>
      <script src="/assets/app.js"></script>
    </head><body>
      <iframe src="https://video.example-host.test/embed/1"></iframe>
    </body></html>`);

    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "script",
        name: "https://tracker.example-ads.test/tag.js",
      }),
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "iframe",
        name: "https://video.example-host.test/embed/1",
      }),
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "network-destination",
        name: "https://fonts.example-cdn.test/",
      }),
    );
  });

  it("resolves relative URLs against the page", () => {
    const found = find(`<script src="../assets/app.js"></script>`);
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "script",
        name: "https://shop.example.test/assets/app.js",
      }),
    );
  });

  it("records a 1x1 image as a possible tracking pixel, marked uncertain", () => {
    const found = find(
      `<img src="https://pixel.example-ads.test/p.gif" width="1" height="1">`,
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "beacon",
        name: "https://pixel.example-ads.test/p.gif",
        uncertainty: "uncertain",
      }),
    );
  });

  it("finds a pixel hidden inside noscript", () => {
    const found = find(
      `<noscript><img src="https://pixel.example-ads.test/ns.gif" width="1" height="1"></noscript>`,
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "beacon",
        name: "https://pixel.example-ads.test/ns.gif",
      }),
    );
  });

  it("finds resources already held back by OpenCookie through data-src", () => {
    const found = find(
      `<script type="text/plain" data-oc-category="analytics" data-src="https://tracker.example-ads.test/held.js"></script>`,
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "script",
        name: "https://tracker.example-ads.test/held.js",
      }),
    );
  });

  it("never claims to have observed anything it only read", () => {
    const found = find(
      `<script src="https://tracker.example-ads.test/tag.js"></script>`,
    );
    for (const observation of found) {
      expect(observation.uncertainty).not.toBe("observed");
      expect(observation.browser).toBe("static-html");
      expect(observation.source).toBe(PAGE);
      expect(observation.observedAt).toBe(AT);
    }
  });

  it("ignores ordinary content images and inline scripts", () => {
    const found = find(
      `<img src="/hero.jpg" width="1200" height="600"><script>var x = 1;</script>`,
    );
    expect(found).toEqual([]);
  });

  it("reports each resource once", () => {
    const found = find(
      `<script src="https://t.example-ads.test/a.js"></script><script src="https://t.example-ads.test/a.js"></script>`,
    );
    expect(found).toHaveLength(1);
  });

  // OpenCookie holds an iframe back as an empty template that carries the URL
  // itself, copied from the real fixture markup. It is the resource an operator
  // most needs to see, and it is not an <iframe> element at all.
  it("finds an iframe OpenCookie holds back in a template", () => {
    const found = find(`<template
        data-oc-iframe
        title="Optional product video"
        data-oc-resource="product-video"
        data-oc-category="analytics"
        data-src="https://video.example-host.test/frame"
      ></template>`);
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "iframe",
        name: "https://video.example-host.test/frame",
      }),
    );
  });

  // A third-party stylesheet or font is fetched from its provider on page load,
  // which sends the visitor's address there. A same-origin one cannot, so it is
  // not a finding.
  it("reports cross-origin stylesheets and preloaded fonts, not same-origin ones", () => {
    const found = find(`<head>
      <link rel="stylesheet" href="https://fonts.example-fonts.test/css2?family=Inter">
      <link rel="preload" as="font" href="https://fonts.example-static.test/inter.woff2" crossorigin>
      <link rel="stylesheet" href="/assets/site.css">
      <link rel="preload" as="font" href="/assets/local.woff2">
    </head>`);

    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "network-destination",
        name: "https://fonts.example-fonts.test/css2?family=Inter",
      }),
    );
    expect(found).toContainEqual(
      expect.objectContaining({
        kind: "network-destination",
        name: "https://fonts.example-static.test/inter.woff2",
      }),
    );
    expect(found.map(({ name }) => name)).not.toContain(
      "https://shop.example.test/assets/site.css",
    );
    expect(found.map(({ name }) => name)).not.toContain(
      "https://shop.example.test/assets/local.woff2",
    );
  });

  // Markup that a real page carries but that names nothing to fetch.
  it.each([
    ["an empty source", '<script src=""></script>'],
    ["a source of only spaces", '<script src="   "></script>'],
    ["a javascript url", '<script src="javascript:void 0"></script>'],
    ["a data url", '<script src="data:text/javascript,0"></script>'],
    [
      "a held-back template with no address",
      "<template data-oc-iframe></template>",
    ],
  ])("reports nothing for %s", (_label, markup) => {
    expect(find(markup)).toHaveLength(0);
  });

  it.each([
    [
      "one bigger than a pixel",
      '<img src="https://cdn.other.test/a.gif" width="2" height="2">',
    ],
    ["one that gives no size", '<img src="https://cdn.other.test/a.gif">'],
    [
      "one that gives only a width",
      '<img src="https://cdn.other.test/a.gif" width="1">',
    ],
  ])("does not call %s a tracking pixel", (_label, markup) => {
    expect(find(markup)).toHaveLength(0);
  });

  it("reads a rel value whatever its case and however many it lists", () => {
    const found = find(
      '<link rel="DNS-PREFETCH" href="https://cdn.other.test/"><link rel="preload stylesheet" href="https://cdn.other.test/a.css">',
    );

    expect(found.map(({ name }) => name).sort()).toEqual([
      "https://cdn.other.test/",
      "https://cdn.other.test/a.css",
    ]);
  });

  // Only a font is taken from a preload. A preloaded script is already
  // reported as a script, and a preloaded image is not a consent concern by
  // itself.
  it("reports a preloaded font but not a preloaded script", () => {
    const found = find(
      '<link rel="preload" as="font" href="https://fonts.other.test/a.woff2"><link rel="preload" as="script" href="https://cdn.other.test/a.js">',
    );

    expect(found.map(({ name }) => name)).toEqual([
      "https://fonts.other.test/a.woff2",
    ]);
  });

  it("finds a resource nested inside a held-back template", () => {
    const found = find(
      '<template data-oc-iframe data-src="https://player.other.test/embed"><script src="https://cdn.other.test/inner.js"></script></template>',
    );

    expect(found.map(({ name }) => name).sort()).toEqual([
      "https://cdn.other.test/inner.js",
      "https://player.other.test/embed",
    ]);
  });

  it("reports a resource served over plain http", () => {
    const found = find('<script src="http://cdn.other.test/a.js"></script>');

    expect(found.map(({ name }) => name)).toEqual([
      "http://cdn.other.test/a.js",
    ]);
  });

  it("reports nothing for a stylesheet with an empty address", () => {
    expect(find('<link rel="stylesheet" href="">')).toHaveLength(0);
  });

  // data-oc-iframe marks the template OpenCookie leaves in place of a frame.
  // On anything else it means nothing, and reporting it would invent a frame.
  it("ignores a held-back marker on an element that is not a template", () => {
    expect(
      find(
        '<div data-oc-iframe data-src="https://player.other.test/embed"></div>',
      ),
    ).toHaveLength(0);
  });

  it("reports a link whose rel lists preconnect among others", () => {
    const found = find(
      '<link rel="preconnect dns-prefetch" href="https://cdn.other.test/">',
    );

    expect(found.map(({ kind }) => kind)).toEqual(["network-destination"]);
  });
});
