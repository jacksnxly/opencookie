import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import { createPlainFixtureServer } from "../../fixtures/plain-cdn/server.mjs";
import * as reactFixtureServer from "../../fixtures/react-vite/server.mjs";

const servers = new Set();

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function requestFixture(port, pathname, hostname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        headers: { host: `${hostname}:4400` },
        host: "127.0.0.1",
        path: pathname,
        port,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            body: bytes.toString("utf8"),
            bytes,
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
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    }),
  );
  servers.clear();
});

describe("storage-resilience fixture routes", () => {
  it("binds only dedicated plain storage routes to the exact local IIFE bytes", async () => {
    const server = createPlainFixtureServer();
    const port = await listen(server);
    const host = "app.plain-cdn.opencookie.test";
    const [defaultPage, localPage, cookiePage, bundle] = await Promise.all([
      requestFixture(port, "/", host),
      requestFixture(port, "/__storage/local", host),
      requestFixture(port, "/__storage/cookie", host),
      requestFixture(port, "/__opencookie/auto.iife.js", host),
    ]);
    const source = await readFile(
      new URL("../../fixtures/plain-cdn/index.html", import.meta.url),
      "utf8",
    );
    const integrity = (html) => {
      const match = /\bintegrity="([^"]+)"/u.exec(html);
      assert.ok(match);
      return match[1];
    };
    const localIntegrity = `sha384-${createHash("sha384")
      .update(bundle.bytes)
      .digest("base64")}`;

    assert.equal(bundle.statusCode, 200);
    assert.equal(integrity(defaultPage.body), integrity(source));
    assert.equal(integrity(localPage.body), localIntegrity);
    assert.equal(integrity(cookiePage.body), localIntegrity);
  });

  it("switches only dedicated plain auto routes between local and cookie storage", async () => {
    const server = createPlainFixtureServer();
    const port = await listen(server);
    const host = "app.plain-cdn.opencookie.test";
    const [defaultPage, localPage, cookiePage] = await Promise.all([
      requestFixture(port, "/", host),
      requestFixture(port, "/__storage/local", host),
      requestFixture(port, "/__storage/cookie", host),
    ]);

    assert.equal(defaultPage.statusCode, 200);
    assert.match(defaultPage.body, /data-oc-storage="cookie"/u);
    assert.match(defaultPage.body, /data-oc-cookie-domain=/u);
    assert.doesNotMatch(defaultPage.body, /data-oc-storage-fixture=/u);

    assert.equal(localPage.statusCode, 200);
    assert.match(localPage.body, /data-oc-storage-fixture="local"/u);
    assert.match(localPage.body, /data-oc-storage="local-storage"/u);
    assert.doesNotMatch(localPage.body, /data-oc-cookie-domain=/u);
    assert.doesNotMatch(localPage.body, /data-oc-registrable-domain=/u);

    assert.equal(cookiePage.statusCode, 200);
    assert.match(cookiePage.body, /data-oc-storage-fixture="cookie"/u);
    assert.match(cookiePage.body, /data-oc-storage="cookie"/u);
    assert.match(cookiePage.body, /data-oc-cookie-domain=/u);
    assert.match(cookiePage.body, /data-oc-registrable-domain=/u);
  });

  it("marks only dedicated React generic routes and selects default local composition", async () => {
    assert.equal(typeof reactFixtureServer.renderViteFixtureIndex, "function");
    const index = await readFile(
      new URL("../../fixtures/react-vite/index.html", import.meta.url),
      "utf8",
    );
    const render = reactFixtureServer.renderViteFixtureIndex;
    const defaultPage = render(index, { headers: {}, url: "/" });
    const localPage = render(index, {
      headers: {},
      url: "/__storage/local",
    });
    const cookiePage = render(index, {
      headers: {},
      url: "/__storage/cookie",
    });

    assert.doesNotMatch(defaultPage, /data-oc-storage-fixture=/u);
    assert.match(localPage, /data-oc-storage-fixture="local"/u);
    assert.match(cookiePage, /data-oc-storage-fixture="cookie"/u);

    const source = await readFile(
      new URL("../../fixtures/react-vite/src/main.tsx", import.meta.url),
      "utf8",
    );
    assert.match(source, /ocStorageFixture/u);
    assert.match(source, /storageFixture === "local"/u);
    assert.match(source, /storageFixture === "cookie"/u);
    assert.match(source, /createCookieDecisionStore/u);
    assert.match(source, /CONSENT_RECORD_SCHEMA_VERSION/u);
    assert.match(source, /store: createCookieDecisionStore/u);
    assert.match(source, /"cookie-decision-store"/u);
    assert.doesNotMatch(source, /"fixture-cookie"/u);
    assert.match(source, /createFixtureCookieStorage/u);
    assert.match(source, /storage: createFixtureCookieStorage/u);
  });
});
