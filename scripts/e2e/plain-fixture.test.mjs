import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import { createPlainFixtureServer } from "../../fixtures/plain-cdn/server.mjs";

const fixtureRoot = new URL("../../fixtures/plain-cdn/", import.meta.url);
const cdnPin = JSON.parse(
  await readFile(
    new URL(
      "../../packages/adapters/vanilla/cdn-integrity.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const servers = new Set();

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function requestFixture(port, pathname, hostname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        headers: { ...headers, host: `${hostname}:4400` },
        host: "127.0.0.1",
        path: pathname,
        port,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.on("error", reject);
  });
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      server.close();
      await once(server, "close");
    }),
  );
  servers.clear();
});

describe("plain CDN fixture", () => {
  it("records reproducible scaffold provenance and the exact public snippet", async () => {
    const provenance = JSON.parse(
      await readFile(new URL(".scaffold.json", fixtureRoot), "utf8"),
    );
    const integrity = JSON.parse(
      await readFile(
        new URL(
          "../../packages/adapters/vanilla/cdn-integrity.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).integrity;
    const source = await readFile(new URL("index.html", fixtureRoot), "utf8");

    assert.equal(provenance.fixture, "plain-cdn");
    assert.equal(provenance.scaffoldedAt, "2026-08-22");
    assert.match(provenance.standard, /HTML Living Standard/u);
    assert.match(
      source,
      new RegExp(
        `https://cdn[.]jsdelivr[.]net/npm/@opencookie-dev/vanilla@${cdnPin.version.replaceAll(".", "[.]")}/dist/auto[.]iife[.]js`,
        "u",
      ),
    );
    assert.equal(typeof integrity, "string");
    assert.ok(source.includes(`integrity="${integrity}"`));
    assert.match(source, /crossorigin="anonymous"/u);
    for (const attribute of [
      "data-oc-policy-version",
      "data-oc-storage-key",
      "data-oc-storage",
      "data-oc-cookie-domain",
      "data-oc-registrable-domain",
      "data-oc-purpose-id",
      "data-oc-purpose-label",
      "data-oc-purpose-description",
      "data-oc-google-consent-mode",
      "data-oc-google-analytics-resource",
      "data-oc-gpc-purpose-id",
      "data-oc-server-gpc",
    ]) {
      assert.match(source, new RegExp(`${attribute}=`, "u"));
    }
    assert.match(source, /type="text\/plain"/u);
    assert.match(source, /data-oc-resource="analytics-script"/u);
  });

  it("projects only the exact Sec-GPC request signal into server-rendered markup", async () => {
    const server = createPlainFixtureServer();
    const port = await listen(server);
    const enabled = await requestFixture(
      port,
      "/",
      "app.plain-cdn.opencookie.test",
      { "sec-gpc": "1" },
    );
    const absent = await requestFixture(
      port,
      "/",
      "app.plain-cdn.opencookie.test",
    );
    const invalid = await requestFixture(
      port,
      "/",
      "app.plain-cdn.opencookie.test",
      { "sec-gpc": "0" },
    );

    assert.match(
      enabled.body.toString("utf8"),
      /data-oc-server-gpc="enabled"/u,
    );
    assert.match(absent.body.toString("utf8"), /data-oc-server-gpc="absent"/u);
    assert.match(invalid.body.toString("utf8"), /data-oc-server-gpc="absent"/u);
  });

  it("serves the exact local IIFE mirror and real role-specific responses", async () => {
    const server = createPlainFixtureServer();
    const port = await listen(server);
    const page = await requestFixture(
      port,
      "/",
      "app.plain-cdn.opencookie.test",
    );
    const html = page.body.toString("utf8");

    assert.equal(page.statusCode, 200);
    assert.equal(page.headers["x-opencookie-cdn-substitution"], "local");
    assert.match(html, /src="\/__opencookie\/auto[.]iife[.]js"/u);
    assert.doesNotMatch(html, /cdn[.]jsdelivr[.]net/u);

    const bundle = await requestFixture(
      port,
      "/__opencookie/auto.iife.js",
      "app.plain-cdn.opencookie.test",
    );
    assert.equal(bundle.statusCode, 200);
    assert.match(bundle.headers["content-type"] ?? "", /javascript/u);
    assert.ok(bundle.body.byteLength > 10_000);

    const shortExpiry = await requestFixture(
      port,
      "/short-expiry",
      "app.plain-cdn.opencookie.test",
    );
    const shortExpiryHtml = shortExpiry.body.toString("utf8");
    assert.match(shortExpiryHtml, /data-oc-expiry-ms="1000"/u);
    assert.match(shortExpiryHtml, /data-oc-consent-duration-ms="1000"/u);

    const tracker = await requestFixture(
      port,
      "/analytics.js",
      "tracker.plain-cdn.opencookie.test",
    );
    assert.equal(tracker.statusCode, 200);
    assert.equal(tracker.headers["x-opencookie-resource"], "analytics");
  });

  it("serves a strict nonce CSP route without unsafe tokens", async () => {
    const server = createPlainFixtureServer();
    const port = await listen(server);
    const response = await requestFixture(
      port,
      "/strict-csp",
      "app.plain-cdn.opencookie.test",
    );
    const policy = response.headers["content-security-policy"] ?? "";
    const html = response.body.toString("utf8");

    assert.match(policy, /script-src 'self' 'nonce-fixture-nonce'/u);
    assert.match(policy, /style-src 'self' 'nonce-fixture-nonce'/u);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/u);
    assert.match(html, /nonce="fixture-nonce"/u);
  });
});
