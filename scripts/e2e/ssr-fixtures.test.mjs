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
const fixtureRuntimes = new Set();
const builtFixtures = new Map();
const fixtures = [
  {
    adapter: "@opencookie-dev/nuxt",
    framework: "nuxt",
    frameworkVersion: "4.5.2",
    generator: "create-nuxt",
    generatorVersion: "3.37.0",
    name: "nuxt",
    root: new URL("../../fixtures/nuxt/", import.meta.url),
    scaffoldCommand:
      "pnpm dlx create-nuxt@3.37.0 fixtures/nuxt --template minimal --packageManager pnpm --no-install --gitInit false",
    scaffoldedAt: "2026-09-23",
    sources: [
      "https://nuxt.com/docs/4.x/getting-started/installation",
      "https://nuxt.com/docs/4.x/getting-started/deployment",
      "https://nuxt.com/docs/4.x/guide/concepts/rendering",
    ],
  },
  {
    adapter: "@opencookie-dev/svelte",
    framework: "sveltekit",
    frameworkVersion: "2.70.3",
    generator: "sv",
    generatorVersion: "0.17.0",
    name: "sveltekit",
    root: new URL("../../fixtures/sveltekit/", import.meta.url),
    scaffoldCommand:
      "pnpm dlx sv@0.17.0 create fixtures/sveltekit --template minimal --types ts --no-add-ons --no-install",
    sources: [
      "https://svelte.dev/docs/kit/creating-a-project",
      "https://svelte.dev/docs/kit/adapter-node",
      "https://svelte.dev/docs/kit/configuration#csp",
    ],
  },
  {
    adapter: "@opencookie-dev/astro",
    framework: "astro",
    frameworkVersion: "7.2.4",
    generator: "create-astro",
    generatorVersion: "5.2.3",
    name: "astro",
    root: new URL("../../fixtures/astro/", import.meta.url),
    scaffoldCommand:
      "pnpm dlx create-astro@5.2.3 fixtures/astro --template minimal --no-install --no-git --no-ai --yes",
    sources: [
      "https://docs.astro.build/en/install-and-setup/",
      "https://docs.astro.build/en/guides/on-demand-rendering/",
      "https://docs.astro.build/en/guides/integrations-guide/node/",
      "https://docs.astro.build/en/guides/view-transitions/",
    ],
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

function requestWithHostHeader(port, pathname, hostHeader, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        headers: { ...extraHeaders, host: hostHeader },
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

function requestFixture(port, pathname, hostname) {
  return requestWithHostHeader(port, pathname, `${hostname}:4400`);
}

async function ensureBuilt(fixture) {
  let build = builtFixtures.get(fixture.name);
  if (build === undefined) {
    build = execute("pnpm", ["--ignore-workspace", "run", "build"], {
      cwd: fileURLToPath(fixture.root),
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    builtFixtures.set(fixture.name, build);
  }
  await build;
}

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function consentModeCalls(page) {
  return page.evaluate(() => globalThis.__ocConsentModeCalls ?? []);
}

function assertConsentModeOrder(calls, analyticsStorage) {
  assert.ok(calls.length >= 2);
  assert.equal(calls[0]?.[0], "consent");
  assert.equal(calls[0]?.[1], "default");
  assert.deepEqual(calls[0]?.[2], {
    ad_personalization: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    analytics_storage: "denied",
  });
  assert.equal(calls.at(-1)?.[0], "consent");
  assert.equal(calls.at(-1)?.[1], "update");
  assert.deepEqual(calls.at(-1)?.[2], {
    ad_personalization: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    analytics_storage: analyticsStorage,
  });
  assert.deepEqual(
    calls.slice(1).map((call) => call[1]),
    calls.slice(1).map(() => "update"),
  );
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

async function verifyGpcContract(browser, fixture, kind) {
  const nativeHeader = kind === "server";
  const context = await browser.newContext({
    ...(nativeHeader ? { extraHTTPHeaders: { "Sec-GPC": "1" } } : {}),
  });
  try {
    const page = await context.newPage();
    const runtimeErrors = captureRuntimeErrors(page);
    const analyticsRequests = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname.startsWith("tracker.")) {
        analyticsRequests.push(request.url());
      }
    });
    const query = kind === "synthetic" ? "?synthetic-gpc=1" : "";
    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/strict-csp${query}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    assert.equal(
      await page.locator("html").getAttribute("data-oc-error"),
      null,
    );
    assert.equal(
      await page.locator("html").getAttribute("data-oc-gpc-effective"),
      "enabled",
    );
    if (nativeHeader) {
      assert.equal(
        await page.locator("html").getAttribute("data-oc-server-gpc"),
        "enabled",
      );
    } else {
      assert.equal(
        await page.locator("html").getAttribute("data-oc-gpc-browser"),
        "synthetic-enabled",
      );
    }

    await waitForFirstVisitConsentSurface(page);

    await page.getByRole("button", { name: "Accept all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
      "GPC must keep analytics blocked after Accept all",
    );
    assert.deepEqual(analyticsRequests, []);
    assertConsentModeOrder(await consentModeCalls(page), "denied");
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function verifyShortExpiry(browser, fixture) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const runtimeErrors = captureRuntimeErrors(page);
    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/short-expiry`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    assert.equal(
      await page.locator("html").getAttribute("data-oc-expiry-mode"),
      "real-clock-short",
    );
    assert.equal(
      await page.locator("html").getAttribute("data-oc-expiry-ms"),
      "1000",
    );
    await waitForFirstVisitConsentSurface(page);
    await page.getByRole("button", { name: "Reject all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForTimeout(1_250);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
}

async function startFixture(fixture) {
  await ensureBuilt(fixture);
  const { startSsrFixtureServer } = await import(
    new URL(`server.mjs?test=${Date.now()}`, fixture.root)
  );
  const running = await startSsrFixtureServer({ port: 0 });
  servers.add(running.server);
  fixtureRuntimes.add(running);
  return running;
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
    const context = await browser.newContext();
    const page = await context.newPage();
    const analyticsRequests = [];
    const runtimeErrors = captureRuntimeErrors(page);
    page.on("request", (request) => {
      if (new URL(request.url()).hostname.startsWith("tracker.")) {
        analyticsRequests.push(request.url());
      }
    });

    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/strict-csp`,
      { waitUntil: "domcontentloaded" },
    );
    const sentinelBeforeReady = await page
      .getByTestId("content-sentinel")
      .boundingBox();
    await page.locator("html[data-oc-ready=true]").waitFor();
    const sentinelAfterReady = await page
      .getByTestId("content-sentinel")
      .boundingBox();
    assert.ok(sentinelBeforeReady);
    assert.ok(sentinelAfterReady);
    assert.ok(Math.abs(sentinelBeforeReady.x - sentinelAfterReady.x) <= 0.5);
    assert.ok(Math.abs(sentinelBeforeReady.y - sentinelAfterReady.y) <= 0.5);
    assert.ok(
      Math.abs(sentinelBeforeReady.width - sentinelAfterReady.width) <= 0.5,
    );
    assert.ok(
      Math.abs(sentinelBeforeReady.height - sentinelAfterReady.height) <= 0.5,
    );
    assert.equal(
      await page.locator("html").getAttribute("data-oc-hydrated"),
      "true",
    );
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
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForSettledConsentSurface(page);

    await page.goto(
      `http://shop.${fixture.name}.opencookie.test:4400/strict-csp`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForSettledConsentSurface(page);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
    );

    const consentCookies = await page.context().cookies();
    assert.equal(
      consentCookies.some(
        (cookie) =>
          cookie.name === "opencookie.consent" &&
          cookie.domain.replace(/^\./u, "") ===
            `${fixture.name}.opencookie.test`,
      ),
      true,
      "the persisted state must be the real OpenCookie decision cookie",
    );

    await page.context().clearCookies();
    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/strict-csp`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
    await page.getByRole("button", { name: "Accept all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 1);
    assertConsentModeOrder(await consentModeCalls(page), "granted");

    const navigationEntries = await page.evaluate(
      () => performance.getEntriesByType("navigation").length,
    );
    await page.getByTestId("route-control").click();
    await page.getByText("Dynamic route 1", { exact: true }).waitFor();
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 2);
    assert.equal(new URL(page.url()).pathname, "/spa/1");
    assert.equal(
      await page.evaluate(
        () => performance.getEntriesByType("navigation").length,
      ),
      navigationEntries,
      "route control must use framework client navigation",
    );

    await page.getByRole("button", { name: "Privacy choices" }).click();
    await page.locator("dialog.oc-panel").waitFor({ state: "visible" });
    // Withdrawal reloads the tab, because the scripts it ran cannot be
    // unloaded (Pass B's M-C); the reloaded page never starts them.
    const reloaded = page.waitForEvent("load");
    await page.getByRole("button", { name: "Withdraw consent" }).click();
    await reloaded;
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(
      () =>
        globalThis.document
          .querySelector('[data-testid="consent-status"]')
          ?.textContent?.trim() === "withdrawn",
    );
    await page.evaluate((fixtureName) => {
      const script = globalThis.document.createElement("script");
      script.type = "text/plain";
      script.dataset.ocResource = "analytics-script";
      script.dataset.ocCategory = "analytics";
      script.dataset.src = `http://tracker.${fixtureName}.opencookie.test:4400/analytics.js?resource=after-withdrawal`;
      globalThis.document.head.append(script);
    }, fixture.name);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
      "withdrawal must re-block newly discovered analytics scripts",
    );
    assert.equal(
      analyticsRequests.filter(
        (requestUrl) => new URL(requestUrl).pathname === "/analytics.js",
      ).length,
      2,
    );
    assert.ok(
      analyticsRequests.some(
        (requestUrl) => new URL(requestUrl).pathname === "/frame",
      ),
    );
    assert.deepEqual(runtimeErrors, []);
    await context.close();

    await verifyGpcContract(browser, fixture, "server");
    await verifyGpcContract(browser, fixture, "synthetic");
    await verifyShortExpiry(browser, fixture);
  } finally {
    await browser.close();
  }
}

afterEach(async () => {
  await Promise.all([...fixtureRuntimes].map((runtime) => runtime.close()));
  fixtureRuntimes.clear();
  await Promise.all(
    [...servers].map(async (server) => {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
    }),
  );
  servers.clear();
});

describe("SSR production fixtures", () => {
  it("defers Nuxt type generation until workspace adapters are built", async () => {
    const manifest = await readJson(
      new URL("../../fixtures/nuxt/package.json", import.meta.url),
    );

    assert.equal(
      manifest.scripts.prepare,
      undefined,
      "an artifact-free workspace install must not load @opencookie-dev/nuxt before dist exists",
    );
    assert.equal(
      manifest.scripts["generate:types"],
      "node node_modules/@nuxt/cli/bin/nuxi.mjs prepare",
    );
    assert.equal(
      manifest.scripts.build,
      "node node_modules/@nuxt/cli/bin/nuxi.mjs build",
    );
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} records exact official scaffold provenance`, async () => {
      const provenance = await readJson(
        new URL(".scaffold.json", fixture.root),
      );
      assert.equal(provenance.fixture, fixture.name);
      assert.equal(provenance.generator, fixture.generator);
      assert.equal(provenance.generatorVersion, fixture.generatorVersion);
      assert.equal(provenance.framework, fixture.framework);
      assert.equal(provenance.frameworkVersion, fixture.frameworkVersion);
      assert.equal(
        provenance.scaffoldedAt,
        fixture.scaffoldedAt ?? "2026-08-22",
      );
      assert.equal(provenance.command, fixture.scaffoldCommand);
      assert.deepEqual(provenance.sources, fixture.sources);
      assert.equal(provenance.lifecycle, undefined);
    });

    it(`${fixture.name} wires an SSR-safe workspace adapter`, async () => {
      const manifest = await readJson(new URL("package.json", fixture.root));
      const sources = (
        await Promise.all(
          manifest.opencookieFixtureSources.map((source) =>
            readFile(new URL(source, fixture.root), "utf8"),
          ),
        )
      ).join("\n");

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
      assert.match(manifest.scripts.build, /build/u);
      assert.equal(manifest.scripts.start, "node server.mjs");
      assert.match(
        sources,
        new RegExp(fixture.adapter.replace("/", "\\/"), "u"),
      );
      assert.match(sources, /bootstrapOpenCookie/u);
      assert.match(sources, /createFixtureCookieStorage/u);
      assert.match(sources, /data-oc-resource/u);
      assert.match(sources, /data-testid/u);
      assert.match(sources, /data-oc-hydrated/u);
      assert.match(sources, /data-oc-csp/u);
      assert.doesNotMatch(sources, /waitForUpdateMs/u);
    });

    it(`${fixture.name} builds and serves hardened SSR production output`, async () => {
      const running = await startFixture(fixture);
      const appHost = `app.${fixture.name}.opencookie.test`;
      const trackerHost = `tracker.${fixture.name}.opencookie.test`;

      const page = await requestFixture(running.port, "/", appHost);
      const html = page.body.toString("utf8");
      assert.equal(page.statusCode, 200);
      assert.match(page.headers["cache-control"] ?? "", /no-store/u);
      assert.match(html, new RegExp(`data-ssr-fixture="${fixture.name}"`, "u"));
      assert.match(html, /Initial route/u);
      assert.doesNotMatch(html, /data-oc-ready="true"/u);

      const serverGpc = await requestWithHostHeader(
        running.port,
        "/",
        `${appHost}:4400`,
        { "sec-gpc": "1" },
      );
      assert.match(
        serverGpc.body.toString("utf8"),
        /data-oc-server-gpc="enabled"/u,
      );

      const status = await requestFixture(
        running.port,
        "/__fixture/status",
        appHost,
      );
      assert.deepEqual(JSON.parse(status.body.toString("utf8")), {
        fixture: fixture.name,
        status: "ready",
      });
      assert.equal(status.headers["x-opencookie-fixture-health"], "ready");

      const strict = await requestFixture(running.port, "/strict-csp", appHost);
      const policy = strict.headers["content-security-policy"] ?? "";
      const nonce = policy.match(/script-src[^;]*'nonce-([^']+)'/u)?.[1];
      assert.equal(strict.statusCode, 200);
      assert.ok(nonce);
      assert.match(policy, /script-src 'self' 'nonce-/u);
      assert.match(policy, /style-src 'self' 'nonce-/u);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/u);
      assert.ok(strict.body.toString("utf8").includes(`nonce="${nonce}"`));

      const tracker = await requestFixture(
        running.port,
        "/analytics.js?resource=contract",
        trackerHost,
      );
      assert.equal(tracker.statusCode, 200);
      assert.equal(tracker.headers["x-opencookie-resource"], "analytics");
      assert.match(tracker.body.toString("utf8"), /__ocAnalyticsLoads/u);

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
        "/path#fragment",
      ];
      const [hostileHosts, hostilePaths] = await Promise.all([
        Promise.all(
          invalidHosts.map((host) =>
            requestWithHostHeader(running.port, "/__fixture/status", host),
          ),
        ),
        Promise.all(
          invalidPaths.map((path) =>
            requestFixture(running.port, path, appHost),
          ),
        ),
      ]);
      assert.deepEqual(
        hostileHosts.map((response) => response.statusCode),
        [421, 421, 421, 421],
      );
      assert.deepEqual(
        hostilePaths.map((response) => response.statusCode),
        [400, 400, 400, 400, 400, 400, 400],
      );
      for (const hostile of hostilePaths) {
        assert.doesNotMatch(
          hostile.body.toString("utf8"),
          /\/Users\/|opencookie-worktrees/u,
        );
      }

      await running.close();
      fixtureRuntimes.delete(running);
      servers.delete(running.server);
    });

    it(`${fixture.name} enforces consent in real Chromium`, async () => {
      const running = await startFixture(fixture);
      await verifyBrowserContract(fixture, running.port);
      await running.close();
      fixtureRuntimes.delete(running);
      servers.delete(running.server);
    });
  }
});
