import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createForwardProxy } from "./forward-proxy.mjs";

const execute = promisify(execFile);
const servers = new Set();
const builds = new Map();
const fixtures = [
  {
    name: "next-app",
    root: new URL("../../fixtures/next-app/", import.meta.url),
    router: "app",
    source: "https://nextjs.org/docs/app/getting-started/installation",
  },
  {
    name: "next-pages",
    root: new URL("../../fixtures/next-pages/", import.meta.url),
    router: "pages",
    source: "https://nextjs.org/docs/pages/getting-started/installation",
  },
];

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

async function ensureBuilt(fixture) {
  let build = builds.get(fixture.name);
  if (build === undefined) {
    build = execute(
      process.execPath,
      [
        fileURLToPath(new URL("node_modules/next/dist/bin/next", fixture.root)),
        "build",
      ],
      {
        cwd: fileURLToPath(fixture.root),
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      },
    );
    builds.set(fixture.name, build);
  }
  await build;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  server.close();
  await once(server, "close");
  servers.delete(server);
  return port;
}

function requestFixture(port, pathname, hostname) {
  return requestWithHostHeader(port, pathname, `${hostname}:4400`);
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

function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

function responseNonce(response) {
  const policy = response.headers["content-security-policy"] ?? "";
  const nonce = policy.match(/'nonce-([^']+)'/u)?.[1];
  assert.ok(nonce, "the response CSP must include a nonce");
  return nonce;
}

async function createRunningFixture(fixture) {
  await ensureBuilt(fixture);
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: fileURLToPath(fixture.root),
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Fixture process exited early.\n${output}`);
    }
    try {
      const status = await requestFixture(
        port,
        "/__fixture/status",
        `app.${fixture.name}.opencookie.test`,
      );
      if (status.statusCode === 200) break;
    } catch {
      // The production server has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (Date.now() >= deadline) {
    child.kill("SIGTERM");
    throw new Error(`Fixture process did not become ready.\n${output}`);
  }
  const fixtureServer = {
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
  return { fixtureServer, port };
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

async function verifyBrowserContract(fixture) {
  const { fixtureServer, port: fixturePort } =
    await createRunningFixture(fixture);
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
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: { server: `http://127.0.0.1:${String(proxyPort)}` },
    });
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

    await page.goto(`http://app.${fixture.name}.opencookie.test:4400/`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await page.locator("html[data-oc-hydrated=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
    assert.equal(
      await page.locator("html").getAttribute("data-oc-error"),
      null,
    );
    assert.equal(await page.evaluate(() => globalThis.__ocEssentialLoads), 1);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
    );
    assert.deepEqual(analyticsRequests, []);
    const serverGeometry = await page.evaluate(
      () => globalThis.__ocSsrGeometry,
    );
    const hydratedGeometry = await page
      .getByTestId("content-sentinel")
      .boundingBox();
    assert.ok(serverGeometry);
    assert.ok(hydratedGeometry);
    assert.ok(Math.abs(serverGeometry.x - hydratedGeometry.x) < 0.5);
    assert.ok(Math.abs(serverGeometry.y - hydratedGeometry.y) < 0.5);
    assert.ok(Math.abs(serverGeometry.width - hydratedGeometry.width) < 0.5);
    assert.deepEqual(
      await page.evaluate(() => globalThis.__ocConsentModeCalls),
      [
        [
          "consent",
          "default",
          {
            ad_personalization: "denied",
            ad_storage: "denied",
            ad_user_data: "denied",
            analytics_storage: "denied",
          },
        ],
      ],
    );

    await page.getByRole("button", { name: "Reject all" }).click();
    await waitForSettledConsentSurface(page);
    assert.equal(
      await page.evaluate(() => globalThis.__ocConsentModeCalls?.at(-1)?.[1]),
      "update",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForSettledConsentSurface(page);

    await page.goto(`http://shop.${fixture.name}.opencookie.test:4400/`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForSettledConsentSurface(page);
    await page.getByTestId("route-control").click();
    await page
      .getByTestId("fixture-status")
      .getByText("Dynamic route 1", { exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).pathname, "/spa/1");
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
    );
    assert.deepEqual(analyticsRequests, []);

    await page.context().clearCookies();
    await page.goto(`http://app.${fixture.name}.opencookie.test:4400/`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
    await page.getByRole("button", { name: "Accept all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 1);
    assert.equal(
      await page.evaluate(
        () => globalThis.__ocConsentModeCalls?.at(-1)?.[2].analytics_storage,
      ),
      "granted",
    );
    await page.getByTestId("route-control").click();
    await page.waitForFunction(() => (globalThis.__ocAnalyticsLoads ?? 0) >= 2);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads),
      2,
      "client navigation must activate only the newly discovered script",
    );
    assert.equal(new URL(page.url()).pathname, "/spa/1");
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

    await page.getByRole("button", { name: "Privacy choices" }).click();
    await page.locator("dialog.oc-panel").waitFor({ state: "visible" });
    // Withdrawal reloads the tab, because the scripts it ran cannot be
    // unloaded (Pass B's M-C); the reloaded page never starts them.
    const reloaded = page.waitForEvent("load");
    await page.getByRole("button", { name: "Withdraw consent" }).click();
    await reloaded;
    await waitForSettledConsentSurface(page);
    await page.getByTestId("route-control").click();
    await page
      .getByTestId("fixture-status")
      .getByText("Dynamic route 2", { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
      "withdrawal must re-block scripts added on later client navigation",
    );
    assert.equal(
      analyticsRequests.filter(
        (requestUrl) => new URL(requestUrl).pathname === "/analytics.js",
      ).length,
      2,
      "no analytics request may follow the withdrawal",
    );

    await page.context().clearCookies();
    await page.goto(`http://app.${fixture.name}.opencookie.test:4400/`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
    await page.getByRole("button", { name: "Accept all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 1);

    await page.goto(`http://shop.${fixture.name}.opencookie.test:4400/`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForSettledConsentSurface(page);
    await page.waitForFunction(() => globalThis.__ocAnalyticsLoads === 1);
    assert.equal(
      await page.locator("html").getAttribute("data-oc-error"),
      null,
    );
    assert.deepEqual(runtimeErrors, []);

    await page.context().clearCookies();
    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/?oc-gpc=synthetic`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    assert.equal(
      await page.locator("html").getAttribute("data-oc-gpc-source"),
      "synthetic-test-only",
    );
    await waitForFirstVisitConsentSurface(page);
    await page.getByRole("button", { name: "Accept all" }).click();
    await waitForSettledConsentSurface(page);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0),
      0,
      "GPC must keep analytics blocked even after Accept all",
    );
    assert.equal(
      await page.evaluate(
        () => globalThis.__ocConsentModeCalls?.at(-1)?.[2].analytics_storage,
      ),
      "denied",
    );

    await page.context().clearCookies();
    await page.goto(
      `http://app.${fixture.name}.opencookie.test:4400/?oc-expiry=short`,
      { waitUntil: "domcontentloaded" },
    );
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
    assert.equal(
      await page.locator("html").getAttribute("data-oc-expiry-profile"),
      "short-real-time",
    );
    await page.getByRole("button", { name: "Accept all" }).click();
    await page.waitForTimeout(1_300);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("html[data-oc-ready=true]").waitFor();
    await waitForFirstVisitConsentSurface(page);
  } finally {
    await browser?.close();
    await fixtureServer.close();
  }
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(async (server) => {
      if (!server.listening) return;
      server.closeAllConnections?.();
      server.close();
      await once(server, "close");
    }),
  );
  servers.clear();
});

describe("Next production fixtures", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} records exact official scaffold provenance`, async () => {
      const provenance = await readJson(
        new URL(".scaffold.json", fixture.root),
      );
      assert.equal(provenance.fixture, fixture.name);
      assert.equal(provenance.generator, "create-next-app");
      assert.equal(provenance.generatorVersion, "16.3.2");
      assert.equal(provenance.router, fixture.router);
      assert.equal(provenance.scaffoldedAt, "2026-08-22");
      assert.match(provenance.command, /create-next-app@16[.]3[.]2/u);
      assert.match(provenance.command, /--skip-install/u);
      assert.deepEqual(provenance.sources, [
        fixture.source,
        "https://nextjs.org/docs/app/guides/content-security-policy",
        "https://nextjs.org/docs/pages/guides/custom-server",
      ]);
      assert.deepEqual(provenance.resolvedVersions, {
        "create-next-app": "16.3.2",
        next: "16.3.2",
        react: "19.2.8",
        "react-dom": "19.2.8",
      });
    });

    it(`${fixture.name} uses workspace OpenCookie packages and router-native files`, async () => {
      const manifest = await readJson(new URL("package.json", fixture.root));
      const server = await readFile(
        new URL("server.mjs", fixture.root),
        "utf8",
      );
      const runtime = await readFile(
        new URL("components/consent-runtime.tsx", fixture.root),
        "utf8",
      );
      const shell = await readFile(
        new URL("components/fixture-shell.tsx", fixture.root),
        "utf8",
      );
      const cookieStorage = await readFile(
        new URL("components/cookie-storage.ts", fixture.root),
        "utf8",
      );
      const routerEntry = await readFile(
        new URL(
          fixture.router === "app" ? "app/layout.tsx" : "pages/_app.tsx",
          fixture.root,
        ),
        "utf8",
      );
      const signalEntry = await readFile(
        new URL(
          fixture.router === "app" ? "app/layout.tsx" : "pages/_document.tsx",
          fixture.root,
        ),
        "utf8",
      );

      assert.equal(manifest.private, true);
      assert.equal(
        manifest.dependencies["@opencookie-dev/core"],
        "workspace:*",
      );
      assert.equal(
        manifest.dependencies["@opencookie-dev/next"],
        "workspace:*",
      );
      assert.equal(
        manifest.dependencies["@opencookie-dev/vanilla"],
        "workspace:*",
      );
      assert.equal(manifest.dependencies.next, "16.4.6");
      assert.equal(manifest.scripts.build, "next build");
      assert.equal(manifest.scripts.start, "node server.mjs");
      assert.match(runtime, /@opencookie-dev\/next/u);
      assert.match(runtime, /bootstrapOpenCookie/u);
      assert.match(runtime, /createFixtureCookieStorage/u);
      assert.match(runtime, /createGoogleConsentModeBroadcaster/u);
      assert.match(runtime, /projectGoogleConsentModeState/u);
      assert.match(shell, /data-testid="route-control"/u);
      assert.match(shell, /ocResource/u);
      assert.match(cookieStorage, /SameSite=Lax/u);
      assert.match(cookieStorage, /Domain=/u);
      assert.match(cookieStorage, /Max-Age=/u);
      assert.match(cookieStorage, /location[.]hostname/u);
      assert.match(routerEntry, /ConsentRuntime/u);
      assert.match(signalEntry, /data-oc-server-gpc/u);
      assert.match(server, /randomBytes/u);
      assert.match(server, /content-security-policy/u);
      assert.match(server, /headersDistinct/u);
    });

    it(`${fixture.name} builds, serves, applies fresh nonces, and rejects hostile requests`, async () => {
      const { fixtureServer, port } = await createRunningFixture(fixture);
      const appHost = `app.${fixture.name}.opencookie.test`;
      const trackerHost = `tracker.${fixture.name}.opencookie.test`;

      try {
        const first = await requestFixture(port, "/", appHost);
        const second = await requestFixture(port, "/", appHost);
        assert.equal(first.statusCode, 200);
        assert.equal(second.statusCode, 200);
        assert.match(first.headers["cache-control"] ?? "", /no-store/u);
        assert.equal(first.headers["x-opencookie-fixture"], fixture.name);
        assert.notEqual(responseNonce(first), responseNonce(second));
        assert.doesNotMatch(
          first.headers["content-security-policy"] ?? "",
          /unsafe-inline|unsafe-eval/u,
        );
        assert.match(first.body.toString("utf8"), /data-fixture-root=/u);
        assert.match(first.body.toString("utf8"), /type="text\/plain"/u);

        const route = await requestFixture(port, "/spa/contract", appHost);
        assert.equal(route.statusCode, 200);
        assert.match(
          route.body.toString("utf8"),
          /Dynamic route (?:<!-- -->)?contract/u,
        );

        const status = await requestFixture(port, "/__fixture/status", appHost);
        assert.deepEqual(JSON.parse(status.body.toString("utf8")), {
          fixture: fixture.name,
          status: "ready",
        });
        const health = await requestFixture(port, "/__fixture/health", appHost);
        assert.equal(health.statusCode, 200);
        assert.equal(health.headers["x-opencookie-fixture-health"], "ready");

        const tracker = await requestFixture(
          port,
          "/analytics.js?resource=contract",
          trackerHost,
        );
        assert.equal(tracker.statusCode, 200);
        assert.equal(tracker.headers["x-opencookie-resource"], "analytics");

        const gpc = await requestWithHostHeader(port, "/", `${appHost}:4400`, {
          "sec-gpc": "1",
        });
        assert.equal(gpc.statusCode, 200);
        assert.equal(gpc.headers["x-opencookie-gpc-source"], "sec-gpc");
        assert.match(gpc.body.toString("utf8"), /data-gpc-source="sec-gpc"/u);

        const syntheticGpc = await requestFixture(
          port,
          "/?oc-gpc=synthetic",
          appHost,
        );
        assert.equal(
          syntheticGpc.headers["x-opencookie-gpc-source"],
          "synthetic-test-only",
        );

        const shortExpiry = await requestFixture(
          port,
          "/?oc-expiry=short",
          appHost,
        );
        assert.equal(
          shortExpiry.headers["x-opencookie-expiry-profile"],
          "short-real-time",
        );

        const shortExpiryRoute = await requestFixture(
          port,
          "/short-expiry",
          appHost,
        );
        assert.equal(shortExpiryRoute.statusCode, 200);
        assert.equal(
          shortExpiryRoute.headers["x-opencookie-expiry-profile"],
          "short-real-time",
        );
        assert.match(
          shortExpiryRoute.body.toString("utf8"),
          /short-real-time/u,
        );

        const invalidHosts = [
          `${appHost}:evil`,
          `${appHost}:4400.evil`,
          `a\tpp.${fixture.name}.opencookie.test:4400`,
          `%61pp.${fixture.name}.opencookie.test:4400`,
          `${appHost}:65536`,
        ];
        const invalidPaths = [
          "/%00",
          "/%E0%A4%A",
          "/assets\\..\\index.html",
          "/assets/%2e%2e/index.html",
          "/assets/%252e%252e/index.html",
          "//evil.opencookie.test/index.html",
          "/%2f%2fevil.opencookie.test/index.html",
          "/route#fragment",
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
          hostileHosts.map((response) => response.statusCode),
          [421, 421, 421, 421, 421],
        );
        assert.deepEqual(
          hostilePaths.map((response) => response.statusCode),
          [400, 400, 400, 400, 400, 400, 400, 400],
        );
        const rawHostilePaths = await Promise.all(
          invalidPaths.map((requestTarget) =>
            rawRequest(
              port,
              `GET ${requestTarget} HTTP/1.1\r\nHost: ${appHost}:4400\r\nConnection: close\r\n\r\n`,
            ),
          ),
        );
        assert.deepEqual(
          rawHostilePaths.map(
            (response) => response.match(/^HTTP\/1[.]1 ([0-9]{3}) /u)?.[1],
          ),
          ["400", "400", "400", "400", "400", "400", "400", "400"],
        );
        const duplicateHost = await rawRequest(
          port,
          `GET /__fixture/status HTTP/1.1\r\nHost: ${appHost}:4400\r\nHost: evil.test\r\nConnection: close\r\n\r\n`,
        );
        assert.match(duplicateHost, /^HTTP\/1[.]1 421 /u);
        for (const hostile of [...hostileHosts, ...hostilePaths]) {
          assert.doesNotMatch(
            hostile.body.toString("utf8"),
            /\/Users\/|[.]opencookie-worktrees/u,
          );
        }
      } finally {
        await fixtureServer.close();
      }
    });

    it(`${fixture.name} enforces consent in real Chromium without hydration errors`, async () => {
      await verifyBrowserContract(fixture);
    });
  }
});
