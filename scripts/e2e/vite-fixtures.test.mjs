import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createForwardProxy } from "./forward-proxy.mjs";

const execute = promisify(execFile);
const servers = new Set();
const fixtures = [
  {
    adapter: "@opencookie-dev/react",
    framework: "react",
    name: "react-vite",
    root: new URL("../../fixtures/react-vite/", import.meta.url),
    source: "https://react.dev/learn/add-react-to-an-existing-project",
    template: "react-ts",
  },
  {
    adapter: "@opencookie-dev/vue",
    framework: "vue",
    name: "vue-vite",
    root: new URL("../../fixtures/vue-vite/", import.meta.url),
    source: "https://vuejs.org/guide/quick-start.html",
    template: "vue-ts",
  },
];

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function requestFixture(port, pathname, hostname, headers = {}) {
  return requestWithHostHeader(port, pathname, `${hostname}:4400`, headers);
}

function requestWithHostHeader(port, pathname, hostHeader, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        headers: { ...headers, host: hostHeader },
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

async function waitForClosedConsentPanel(page) {
  const panel = page.locator("dialog.oc-panel");
  await panel.waitFor({ state: "attached" });
  await panel.waitFor({ state: "hidden" });
  assert.equal(await panel.getAttribute("open"), null);
}

async function waitForFirstVisitConsentSurface(page) {
  await page.locator(".oc-bar").waitFor({ state: "visible" });
  await waitForClosedConsentPanel(page);
}

async function waitForSettledConsentSurface(page) {
  await page.locator(".oc-bar").waitFor({ state: "hidden" });
  await waitForClosedConsentPanel(page);
  await page
    .getByRole("button", { name: "Privacy choices" })
    .waitFor({ state: "visible" });
}

async function verifyBrowserContract(fixture, fixturePort) {
  const target = `http://127.0.0.1:${String(fixturePort)}`;
  const proxy = createForwardProxy({
    targets: {
      [`app.${fixture.name}.opencookie.test`]: target,
      [`shop.${fixture.name}.opencookie.test`]: target,
      [`tracker.${fixture.name}.opencookie.test`]: target,
    },
  });
  const proxyPort = await listen(proxy);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${String(proxyPort)}` },
  });

  try {
    const page = await browser.newPage();
    const analyticsRequests = [];
    const runtimeErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).hostname.startsWith("tracker.")) {
        analyticsRequests.push(request.url());
      }
    });

    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/strict-csp`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    assert.equal(
      await page.locator("html").getAttribute("data-oc-error"),
      null,
    );
    await waitForFirstVisitConsentSurface(page);
    assert.equal(await page.evaluate(() => globalThis.__ocEssentialLoads), 1);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
    );
    assert.deepEqual(analyticsRequests, []);

    await page.getByRole("button", { name: "Reject all" }).click();
    await waitForSettledConsentSurface(page);

    await page.goto(
      `http://shop.${fixture.name}.opencookie.test:4400/strict-csp`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForSettledConsentSurface(page);
    assert.equal(
      await page.locator("html").getAttribute("data-oc-error"),
      null,
    );

    await page.getByTestId("route-control").click();
    await page.getByText("Dynamic route 1", { exact: true }).waitFor();

    assert.equal(new URL(page.url()).pathname, "/spa/1");
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
    );
    assert.equal(
      await page.locator('script[data-oc-resource="analytics-script"]').count(),
      2,
    );
    assert.deepEqual(analyticsRequests, []);

    await page.context().clearCookies();
    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/strict-csp`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
    );

    await page.getByRole("button", { name: "Accept all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 1);
    await page.getByTestId("route-control").click();
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 2);
    assert.equal(
      analyticsRequests.filter(
        (requestUrl) => new URL(requestUrl).pathname === "/analytics.js",
      ).length,
      2,
    );
    assert.equal(
      analyticsRequests.filter(
        (requestUrl) => new URL(requestUrl).pathname === "/frame",
      ).length,
      1,
    );

    await page.goto(
      `http://shop.${fixture.name}.opencookie.test:4400/strict-csp`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 1);
    assert.equal(
      analyticsRequests.filter(
        (requestUrl) => new URL(requestUrl).pathname === "/analytics.js",
      ).length,
      3,
    );
    assert.equal(
      analyticsRequests.filter(
        (requestUrl) => new URL(requestUrl).pathname === "/frame",
      ).length,
      2,
    );
    assert.equal(
      await page.locator("html").getAttribute("data-oc-error"),
      null,
    );
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await browser.close();
  }
}

async function readConsentModeCalls(page) {
  return page.evaluate(() =>
    structuredClone(globalThis.__ocConsentModeCalls ?? []),
  );
}

const deniedConsentModeState = Object.freeze({
  ad_personalization: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  analytics_storage: "denied",
});

async function openReadyFixture(page, fixture) {
  const response = await page.goto(
    `http://app.${fixture.name}.opencookie.test:4400/strict-csp`,
    { waitUntil: "networkidle" },
  );
  assert.equal(response?.status(), 200);
  await page.locator("html[data-oc-ready=true]").waitFor();
  await waitForFirstVisitConsentSurface(page);
}

async function verifyRestrictedSignal({ browser, fixture, signal }) {
  const context = await browser.newContext(
    signal === "server" ? { extraHTTPHeaders: { "Sec-GPC": "1" } } : undefined,
  );
  if (signal === "browser") {
    await context.addInitScript(() => {
      Object.defineProperty(globalThis.navigator, "globalPrivacyControl", {
        configurable: true,
        value: true,
      });
      globalThis.document.addEventListener(
        "DOMContentLoaded",
        () => {
          globalThis.document.documentElement.dataset.ocBrowserGpcEvidence =
            "synthetic-test-only";
        },
        { once: true },
      );
    });
  }

  try {
    const page = await context.newPage();
    const trackerRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname.startsWith("tracker.")) {
        trackerRequests.push(request.url());
      }
    });
    await openReadyFixture(page, fixture);
    assert.equal(
      await page.locator("html").getAttribute("data-oc-server-gpc"),
      signal === "server" ? "enabled" : "absent",
    );
    assert.equal(
      await page.locator("html").getAttribute("data-oc-browser-gpc-evidence"),
      signal === "browser" ? "synthetic-test-only" : null,
    );
    assert.deepEqual(await readConsentModeCalls(page), [
      ["consent", "default", deniedConsentModeState],
    ]);

    await page.getByRole("button", { name: "Accept all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(
      () => (globalThis.__ocConsentModeCalls?.length ?? 0) === 2,
    );
    assert.deepEqual((await readConsentModeCalls(page))[1], [
      "consent",
      "update",
      deniedConsentModeState,
    ]);
    assert.equal(
      await page.evaluate(
        () => globalThis.__ocOpenCookieSnapshot?.().record?.method,
      ),
      "accept-all",
    );
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
    );
    assert.deepEqual(trackerRequests, []);
  } finally {
    await context.close();
  }
}

async function verifySignalContract(fixture, fixturePort) {
  const target = `http://127.0.0.1:${String(fixturePort)}`;
  const proxy = createForwardProxy({
    targets: {
      [`app.${fixture.name}.opencookie.test`]: target,
      [`shop.${fixture.name}.opencookie.test`]: target,
      [`tracker.${fixture.name}.opencookie.test`]: target,
    },
  });
  const proxyPort = await listen(proxy);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: `http://127.0.0.1:${String(proxyPort)}` },
  });

  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openReadyFixture(page, fixture);
      assert.deepEqual(await readConsentModeCalls(page), [
        ["consent", "default", deniedConsentModeState],
      ]);

      await page.getByRole("button", { name: "Accept all" }).click();
      await waitForSettledConsentSurface(page);
      await page.waitForFunction(
        () => (globalThis.__ocConsentModeCalls?.length ?? 0) === 2,
      );
      assert.deepEqual((await readConsentModeCalls(page))[1], [
        "consent",
        "update",
        { ...deniedConsentModeState, analytics_storage: "granted" },
      ]);

      // Withdrawal reloads the tab (Pass B's M-C), which clears the page's
      // call log, so the calls made from here on are copied to sessionStorage.
      await page.evaluate(() => {
        const calls = globalThis.__ocConsentModeCalls;
        const push = calls.push.bind(calls);
        calls.push = (...items) => {
          const log = JSON.parse(
            globalThis.sessionStorage.getItem("oc-consent-mode") ?? "[]",
          );
          log.push(...items);
          globalThis.sessionStorage.setItem(
            "oc-consent-mode",
            JSON.stringify(log),
          );
          return push(...items);
        };
      });
      await page.getByRole("button", { name: "Privacy choices" }).click();
      await page.locator("dialog.oc-panel").waitFor({ state: "visible" });
      const reloaded = page.waitForEvent("load");
      await page.getByRole("button", { name: "Withdraw consent" }).click();
      await reloaded;
      await waitForSettledConsentSurface(page);
      const afterWithdrawal = JSON.parse(
        (await page.evaluate(() =>
          globalThis.sessionStorage.getItem("oc-consent-mode"),
        )) ?? "[]",
      );
      assert.deepEqual(afterWithdrawal[0], [
        "consent",
        "update",
        deniedConsentModeState,
      ]);
    } finally {
      await context.close();
    }

    await verifyRestrictedSignal({ browser, fixture, signal: "server" });
    await verifyRestrictedSignal({ browser, fixture, signal: "browser" });
  } finally {
    await browser.close();
  }
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

describe("Vite production fixtures", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} records exact official scaffold provenance`, async () => {
      const provenance = await readJson(
        new URL(".scaffold.json", fixture.root),
      );
      assert.equal(provenance.fixture, fixture.name);
      assert.equal(provenance.generator, "create-vite");
      assert.equal(provenance.generatorVersion, "9.1.2");
      assert.equal(provenance.template, fixture.template);
      assert.equal(provenance.scaffoldedAt, "2026-08-22");
      assert.equal(
        provenance.command,
        `pnpm dlx create-vite@9.1.2 fixtures/${fixture.name} --template ${fixture.template} --no-interactive`,
      );
      assert.deepEqual(provenance.sources, [
        "https://vite.dev/guide/",
        fixture.source,
      ]);
    });

    it(`${fixture.name} uses workspace OpenCookie packages and stable browser hooks`, async () => {
      const manifest = await readJson(new URL("package.json", fixture.root));
      const index = await readFile(new URL("index.html", fixture.root), "utf8");
      const main = await readFile(
        new URL(
          fixture.framework === "react" ? "src/main.tsx" : "src/main.ts",
          fixture.root,
        ),
        "utf8",
      );
      const app = await readFile(
        new URL(
          fixture.framework === "react" ? "src/App.tsx" : "src/App.vue",
          fixture.root,
        ),
        "utf8",
      );

      assert.equal(manifest.private, true);
      assert.equal(manifest.dependencies[fixture.adapter], "workspace:*");
      assert.equal(
        manifest.dependencies["@opencookie-dev/core"],
        "workspace:*",
      );
      assert.equal(
        manifest.dependencies["@opencookie-dev/vanilla"],
        "workspace:*",
      );
      assert.equal(manifest.scripts.build.includes("vite build"), true);
      assert.equal(manifest.scripts.start, "node server.mjs");
      assert.match(index, /nonce="fixture-nonce"/u);
      assert.match(index, /type="text\/plain"/u);
      assert.match(index, /data-oc-resource="analytics-script"/u);
      assert.equal(main.includes(fixture.adapter), true);
      assert.match(main, /@opencookie-dev\/vanilla/u);
      assert.match(app, /history[.]pushState/u);
      assert.match(app, /ocResource/u);
      assert.match(app, /fixture-status/u);
      assert.match(app, /data-testid/u);
    });

    it(`${fixture.name} builds and serves deterministic production routes`, async () => {
      await execute("pnpm", ["build"], {
        cwd: fileURLToPath(fixture.root),
        env: process.env,
      });
      const { createViteFixtureServer } = await import(
        new URL(`server.mjs?fixture-test=${Date.now()}`, fixture.root)
      );
      const server = createViteFixtureServer();
      const port = await listen(server);
      const appHost = `app.${fixture.name}.opencookie.test`;
      const trackerHost = `tracker.${fixture.name}.opencookie.test`;

      const page = await requestFixture(port, "/", appHost);
      const html = page.body.toString("utf8");
      assert.equal(page.statusCode, 200);
      assert.match(page.headers["cache-control"] ?? "", /no-store/u);
      assert.match(html, /data-fixture-root=/u);
      assert.match(html, /data-oc-server-gpc="absent"/u);

      const shortExpiry = await requestFixture(port, "/short-expiry", appHost);
      assert.match(
        shortExpiry.body.toString("utf8"),
        /data-oc-expiry-ms="1000"/u,
      );

      const enabledGpcPage = await requestFixture(port, "/", appHost, {
        "sec-gpc": "1",
      });
      assert.match(
        enabledGpcPage.body.toString("utf8"),
        /data-oc-server-gpc="enabled"/u,
      );
      for (const invalidValue of ["0", "01", "true", "1, 1"]) {
        const invalidGpcPage = await requestFixture(port, "/", appHost, {
          "sec-gpc": invalidValue,
        });
        assert.match(
          invalidGpcPage.body.toString("utf8"),
          /data-oc-server-gpc="absent"/u,
          `Sec-GPC: ${invalidValue} must not enable the server observation`,
        );
      }

      const health = await requestFixture(port, "/__fixture/health", appHost);
      assert.equal(health.statusCode, 200);
      assert.equal(health.headers["x-opencookie-fixture-health"], "ready");
      const assetPath = html.match(/\/assets\/[a-zA-Z0-9._-]+[.]js/u)?.[0];
      assert.ok(assetPath);
      const asset = await requestFixture(port, assetPath, appHost);
      assert.equal(asset.statusCode, 200);
      assert.match(asset.headers["content-type"] ?? "", /javascript/u);
      assert.ok(asset.body.byteLength > 1_000);

      const spa = await requestFixture(port, "/spa/contract", appHost);
      assert.equal(spa.statusCode, 200);
      assert.match(spa.body.toString("utf8"), /data-fixture-root=/u);

      const shop = await requestFixture(
        port,
        "/",
        `shop.${fixture.name}.opencookie.test`,
      );
      assert.equal(shop.statusCode, 200);

      const status = await requestFixture(port, "/__fixture/status", appHost);
      assert.deepEqual(JSON.parse(status.body.toString("utf8")), {
        fixture: fixture.name,
        status: "ready",
      });

      const strict = await requestFixture(port, "/strict-csp", appHost);
      const policy = strict.headers["content-security-policy"] ?? "";
      assert.equal(strict.statusCode, 200);
      assert.match(policy, /script-src 'self' 'nonce-fixture-nonce'/u);
      assert.match(policy, /style-src 'self' 'nonce-fixture-nonce'/u);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/u);
      assert.match(strict.body.toString("utf8"), /nonce="fixture-nonce"/u);

      const tracker = await requestFixture(
        port,
        "/analytics.js?resource=contract",
        trackerHost,
      );
      assert.equal(tracker.statusCode, 200);
      assert.equal(tracker.headers["x-opencookie-resource"], "analytics");
      assert.match(tracker.body.toString("utf8"), /__ocAnalyticsLoads/u);

      const unknown = await requestFixture(port, "/", "unknown.test");
      assert.equal(unknown.statusCode, 421);

      const invalidHosts = [
        `${appHost}:evil`,
        `${appHost}:4400.evil`,
        `a\tpp.${fixture.name}.opencookie.test:4400`,
        `%61pp.${fixture.name}.opencookie.test:4400`,
      ];
      const invalidPaths = [
        "/%00",
        "/%E0%A4%A",
        "/assets\\..\\index.html",
        "/assets/%2e%2e/index.html",
        "//evil.opencookie.test/index.html",
        "/%2f%2fevil.opencookie.test/index.html",
      ];
      const [hostileHosts, hostilePaths] = await Promise.all([
        Promise.all(
          invalidHosts.map((host) =>
            requestWithHostHeader(port, "/__fixture/status", host),
          ),
        ),
        Promise.all(
          invalidPaths.map((path) => requestFixture(port, path, appHost)),
        ),
      ]);
      assert.deepEqual(
        {
          hosts: hostileHosts.map((response) => response.statusCode),
          paths: hostilePaths.map((response) => response.statusCode),
        },
        {
          hosts: [421, 421, 421, 421],
          paths: [400, 400, 400, 400, 400, 400],
        },
      );
      for (const hostile of hostilePaths) {
        assert.doesNotMatch(
          hostile.body.toString("utf8"),
          /\/Users\/|opencookie-fixtures-vite/u,
        );
      }
    });

    it(`${fixture.name} enforces consent across sibling hosts`, async () => {
      await execute("pnpm", ["build"], {
        cwd: fileURLToPath(fixture.root),
        env: process.env,
      });
      const { createViteFixtureServer } = await import(
        new URL(`server.mjs?browser-test=${Date.now()}`, fixture.root)
      );
      const server = createViteFixtureServer();
      const port = await listen(server);

      await verifyBrowserContract(fixture, port);
    });

    it(`${fixture.name} broadcasts consent and honors each GPC source`, async () => {
      await execute("pnpm", ["build"], {
        cwd: fileURLToPath(fixture.root),
        env: process.env,
      });
      const { createViteFixtureServer } = await import(
        new URL(`server.mjs?signal-test=${Date.now()}`, fixture.root)
      );
      const server = createViteFixtureServer();
      const port = await listen(server);

      await verifySignalContract(fixture, port);
    });
  }
});
