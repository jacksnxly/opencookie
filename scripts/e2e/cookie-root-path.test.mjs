import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { afterEach, test } from "node:test";

import { chromium } from "@playwright/test";

const servers = new Set();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

test("a non-root cookie path is rejected before Chromium can hide a grant", async () => {
  const infrastructureBundle = await readFile(
    new URL("../../packages/core/dist/infrastructure.js", import.meta.url),
    "utf8",
  );
  const applicationBundle = await readFile(
    new URL("../../packages/core/dist/application.js", import.meta.url),
    "utf8",
  );
  const reconciliationBundle = await readFile(
    new URL("../../packages/core/dist/reconciliation.js", import.meta.url),
    "utf8",
  );
  const pageSource = `<!doctype html>
<meta charset="utf-8">
<script type="importmap">
  {"imports":{"@opencookie-dev/core/reconciliation":"/reconciliation.js"}}
</script>
<script type="module">
  import { createCookieDecisionStore } from "/infrastructure.js";
  import { persistGrant } from "/application.js";
  const writes = [];
  const record = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1000,
    decisionSurfaceDigest: "surface-1",
    decisions: { analytics: "granted" },
    expiresAt: 2000,
    method: "accept-all",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  };
  try {
    const store = createCookieDecisionStore({
      hostname: location.hostname,
      jar: {
        read: () => document.cookie,
        write: (value) => {
          writes.push(value);
          document.cookie = value;
        },
      },
      key: "oc-consent",
      path: "/account",
      schemaVersion: 1,
    });
    const persistence = await persistGrant(store, null, record);
    globalThis.__ocResult = { persistence, writes };
  } catch (error) {
    globalThis.__ocResult = {
      error: error instanceof Error ? error.message : String(error),
      writes,
    };
  }
</script>`;
  const server = http.createServer((request, response) => {
    if (request.url === "/infrastructure.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(infrastructureBundle);
      return;
    }
    if (request.url === "/application.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(applicationBundle);
      return;
    }
    if (request.url === "/reconciliation.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(reconciliationBundle);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(pageSource);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const { promise: moduleFailure, reject: rejectModuleFailure } =
      Promise.withResolvers();
    page.on("pageerror", rejectModuleFailure);
    page.on("console", (message) => {
      if (message.type() === "error") {
        rejectModuleFailure(
          new Error(`Browser console error: ${message.text()}`),
        );
      }
    });
    const origin = `http://127.0.0.1:${String(address.port)}`;
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await Promise.race([
      page.waitForFunction(() => globalThis.__ocResult !== undefined),
      moduleFailure,
    ]);
    const result = await page.evaluate(() => globalThis.__ocResult);

    assert.match(
      result.error ?? "",
      /path must be exactly \/ for site-wide consent/i,
    );
    assert.deepEqual(result.writes, []);
    assert.equal(
      (await context.cookies()).some(({ name }) => name === "oc-consent"),
      false,
    );

    await page.goto(`${origin}/account`, { waitUntil: "domcontentloaded" });
    assert.equal(
      await page.evaluate(() =>
        globalThis.document.cookie.includes("oc-consent="),
      ),
      false,
    );
  } finally {
    await browser.close();
  }
});
