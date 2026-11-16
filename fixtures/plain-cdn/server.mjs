import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { pathToFileURL } from "node:url";

// The pinned CDN address follows the recorded package version, so a version
// bump cannot leave the fixture serving a page whose script never loads.
const cdnPin = JSON.parse(
  await readFile(
    new URL(
      "../../packages/adapters/vanilla/cdn-integrity.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const PUBLIC_CDN_URL = `https://cdn.jsdelivr.net/npm/${cdnPin.package}@${cdnPin.version}/${cdnPin.file}`;
const LOCAL_CDN_URL = "/__opencookie/auto.iife.js";
const fixtureRoot = new URL("./", import.meta.url);
const bundleUrl = new URL(
  "../../packages/adapters/vanilla/dist/auto.iife.js",
  import.meta.url,
);
const allowedHosts = new Set([
  "app.plain-cdn.opencookie.test",
  "shop.plain-cdn.opencookie.test",
  "tracker.plain-cdn.opencookie.test",
]);

function contentType(pathname) {
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

async function fixtureAsset(pathname) {
  const filename = pathname.slice(1);
  if (!["essential.js", "fixture.js", "site.css"].includes(filename)) {
    return undefined;
  }
  return readFile(new URL(filename, fixtureRoot));
}

function renderStorageFixtureRoute(html, pathname, localIntegrity) {
  const mode =
    pathname === "/__storage/local"
      ? "local"
      : pathname === "/__storage/cookie"
        ? "cookie"
        : undefined;
  if (mode === undefined) return html;
  const marked = html
    .replace("<html ", `<html data-oc-storage-fixture="${mode}" `)
    .replace(/\bintegrity="[^"]+"/u, `integrity="${localIntegrity}"`);
  if (mode === "cookie") return marked;
  return marked
    .replace('data-oc-storage="cookie"', 'data-oc-storage="local-storage"')
    .replace(/\s+data-oc-cookie-domain="[^"]*"/u, "")
    .replace(/\s+data-oc-registrable-domain="[^"]*"/u, "");
}

export function createPlainFixtureServer() {
  let localBundlePromise;
  const localBundle = () => {
    localBundlePromise ??= readFile(bundleUrl);
    return localBundlePromise;
  };
  return http.createServer(async (request, response) => {
    const hostname = (request.headers.host ?? "").split(":")[0]?.toLowerCase();
    if (hostname === undefined || !allowedHosts.has(hostname)) {
      send(response, 421, "Unknown fixture host.");
      return;
    }
    const requestedUrl = new URL(request.url ?? "/", `http://${hostname}`);

    try {
      if (requestedUrl.pathname === "/__fixture/health") {
        send(response, 200, "ready", {
          "x-opencookie-fixture-health": "ready",
        });
        return;
      }

      if (hostname.startsWith("tracker.")) {
        if (requestedUrl.pathname === "/analytics.js") {
          send(
            response,
            200,
            "globalThis.__ocAnalyticsLoads = (globalThis.__ocAnalyticsLoads ?? 0) + 1; document.cookie = 'oc_optional_loaded=1; Path=/; SameSite=Lax';",
            {
              "content-type": "text/javascript; charset=utf-8",
              "x-opencookie-resource": "analytics",
            },
          );
          return;
        }
        if (requestedUrl.pathname === "/frame") {
          send(
            response,
            200,
            '<!doctype html><html lang="en"><body><p>Optional frame loaded</p></body></html>',
            {
              "content-type": "text/html; charset=utf-8",
              "x-opencookie-resource": "product-video",
            },
          );
          return;
        }
        send(response, 404, "Unknown tracker resource.");
        return;
      }

      if (requestedUrl.pathname === "/__opencookie/auto.iife.js") {
        send(response, 200, await localBundle(), {
          "content-type": "text/javascript; charset=utf-8",
          "x-opencookie-artifact": "packed-equivalent-auto-iife",
        });
        return;
      }

      const asset = await fixtureAsset(requestedUrl.pathname);
      if (asset !== undefined) {
        send(response, 200, asset, {
          "content-type": contentType(requestedUrl.pathname),
        });
        return;
      }

      let html = await readFile(new URL("index.html", fixtureRoot), "utf8");
      html = html.replaceAll(PUBLIC_CDN_URL, LOCAL_CDN_URL);
      html = html.replaceAll(
        "__OC_SERVER_GPC__",
        request.headers["sec-gpc"] === "1" ? "enabled" : "absent",
      );
      const storageRoute =
        requestedUrl.pathname === "/__storage/local" ||
        requestedUrl.pathname === "/__storage/cookie";
      const localIntegrity = storageRoute
        ? `sha384-${createHash("sha384")
            .update(await localBundle())
            .digest("base64")}`
        : undefined;
      html = renderStorageFixtureRoute(
        html,
        requestedUrl.pathname,
        localIntegrity,
      );
      if (requestedUrl.pathname === "/policy-v2") {
        html = html.replace(
          'data-oc-policy-version="policy-1"',
          'data-oc-policy-version="policy-2"',
        );
      }
      if (requestedUrl.pathname === "/short-expiry") {
        html = html
          .replace("<html ", '<html data-oc-expiry-ms="1000" ')
          .replace(
            'data-oc-policy-version="policy-1"',
            'data-oc-consent-duration-ms="1000" data-oc-policy-version="policy-1"',
          );
      }
      const strictCsp = requestedUrl.pathname === "/strict-csp";
      send(response, 200, html, {
        "content-type": "text/html; charset=utf-8",
        ...(strictCsp
          ? {
              "content-security-policy": [
                "default-src 'self'",
                "script-src 'self' 'nonce-fixture-nonce' http://tracker.plain-cdn.opencookie.test:4400",
                "style-src 'self' 'nonce-fixture-nonce'",
                "frame-src http://tracker.plain-cdn.opencookie.test:4400",
                "object-src 'none'",
                "base-uri 'none'",
                "frame-ancestors 'none'",
              ].join("; "),
            }
          : {}),
        "x-opencookie-cdn-substitution": "local",
      });
    } catch (error) {
      send(
        response,
        500,
        error instanceof Error ? error.message : "Fixture server failure.",
      );
    }
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  const port = Number.parseInt(process.env.PORT ?? "4510", 10);
  const server = createPlainFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Plain CDN fixture listening on http://127.0.0.1:${String(port)}`,
    );
  });
}
