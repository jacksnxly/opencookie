import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_NAME = "react-vite";
const CSP_NONCE = "fixture-nonce";
const distRoot = fileURLToPath(new URL("./dist/", import.meta.url));
const allowedHosts = new Set([
  `app.${FIXTURE_NAME}.opencookie.test`,
  `shop.${FIXTURE_NAME}.opencookie.test`,
  `tracker.${FIXTURE_NAME}.opencookie.test`,
]);

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-opencookie-fixture": FIXTURE_NAME,
    ...headers,
  });
  response.end(body);
}

function contentType(pathname) {
  const extension = extname(pathname);
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".json" || extension === ".map") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function requestHostname(hostHeader) {
  if (hostHeader === undefined || hostHeader.length === 0) return undefined;
  const portSeparator = hostHeader.lastIndexOf(":");
  const hostname =
    portSeparator === -1 ? hostHeader : hostHeader.slice(0, portSeparator);
  if (portSeparator !== -1) {
    if (hostHeader.indexOf(":") !== portSeparator) return undefined;
    const port = hostHeader.slice(portSeparator + 1);
    if (!/^[0-9]{1,5}$/u.test(port) || Number(port) > 65_535) {
      return undefined;
    }
  }
  if (!/^[A-Za-z0-9.-]+$/u.test(hostname)) {
    return undefined;
  }
  return hostname.toLowerCase();
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function decodedRequestPath(requestTarget) {
  if (
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//") ||
    requestTarget.includes("#")
  ) {
    return undefined;
  }
  const queryStart = requestTarget.indexOf("?");
  const pathname =
    queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  try {
    const decoded = decodeURIComponent(pathname);
    if (containsControlCharacter(decoded) || decoded.includes("\\")) {
      return undefined;
    }
    if (decoded.startsWith("//")) return undefined;
    const segments = decoded.split("/");
    return segments.some((segment) => segment === "." || segment === "..")
      ? undefined
      : decoded;
  } catch {
    return undefined;
  }
}

function confinedAssetPath(pathname) {
  const candidate = resolve(distRoot, `.${pathname}`);
  const fromRoot = relative(distRoot, candidate);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith("../")) {
    return undefined;
  }
  return candidate;
}

async function productionAsset(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

function nonceScripts(html) {
  return html.replace(
    /<script(?![^>]*\bnonce=)/gu,
    `<script nonce="${CSP_NONCE}"`,
  );
}

function serverGpcObservation(request) {
  return request.headers["sec-gpc"] === "1" ? "enabled" : "absent";
}

export function renderViteFixtureIndex(html, request) {
  const pathname = decodedRequestPath(request.url ?? "");
  if (pathname === undefined) {
    throw new TypeError("Cannot render an invalid fixture request path.");
  }
  let rendered = nonceScripts(html).replaceAll(
    "__OC_SERVER_GPC__",
    serverGpcObservation(request),
  );
  const storageMode =
    pathname === "/__storage/local"
      ? "local"
      : pathname === "/__storage/cookie"
        ? "cookie"
        : undefined;
  if (storageMode !== undefined) {
    rendered = rendered.replace(
      "<html ",
      `<html data-oc-storage-fixture="${storageMode}" `,
    );
  }
  return pathname === "/short-expiry"
    ? rendered.replace("<html ", '<html data-oc-expiry-ms="1000" ')
    : rendered;
}

function strictCsp() {
  const trackerOrigin = `http://tracker.${FIXTURE_NAME}.opencookie.test:4400`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${CSP_NONCE}' ${trackerOrigin}`,
    `style-src 'self' 'nonce-${CSP_NONCE}'`,
    `frame-src ${trackerOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function createViteFixtureServer() {
  return http.createServer(async (request, response) => {
    const hostname = requestHostname(request.headers.host);
    if (hostname === undefined || !allowedHosts.has(hostname)) {
      send(response, 421, "Unknown fixture host.");
      return;
    }
    if (request.url === undefined) {
      send(response, 400, "Invalid request target.");
      return;
    }
    const decodedPathname = decodedRequestPath(request.url);
    if (decodedPathname === undefined) {
      send(response, 400, "Invalid request path.");
      return;
    }
    const assetPath = confinedAssetPath(decodedPathname);
    if (assetPath === undefined) {
      send(response, 400, "Invalid request path.");
      return;
    }

    try {
      if (hostname.startsWith("tracker.")) {
        if (decodedPathname === "/analytics.js") {
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
        if (decodedPathname === "/frame") {
          send(
            response,
            200,
            "<!doctype html><title>Optional product video</title><p>Loaded after consent.</p>",
            { "content-type": "text/html; charset=utf-8" },
          );
          return;
        }
        send(response, 404, "Unknown tracker resource.");
        return;
      }

      if (decodedPathname === "/__fixture/status") {
        send(
          response,
          200,
          JSON.stringify({ fixture: FIXTURE_NAME, status: "ready" }),
          { "content-type": "application/json; charset=utf-8" },
        );
        return;
      }

      if (decodedPathname === "/__fixture/health") {
        send(response, 200, "ready", {
          "x-opencookie-fixture-health": "ready",
        });
        return;
      }

      const asset = await productionAsset(assetPath);
      if (asset !== undefined && decodedPathname !== "/") {
        send(response, 200, asset, {
          "cache-control": "public, max-age=31536000, immutable",
          "content-type": contentType(decodedPathname),
        });
        return;
      }
      if (decodedPathname.startsWith("/assets/")) {
        send(response, 404, "Unknown production asset.");
        return;
      }

      const strict = decodedPathname === "/strict-csp";
      const index = await readFile(resolve(distRoot, "index.html"), "utf8");
      send(response, 200, renderViteFixtureIndex(index, request), {
        "content-type": "text/html; charset=utf-8",
        ...(strict ? { "content-security-policy": strictCsp() } : {}),
      });
    } catch {
      send(response, 500, "Fixture server failure.");
    }
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  const port = Number.parseInt(process.env.PORT ?? "4520", 10);
  const server = createViteFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `React Vite fixture listening on http://127.0.0.1:${String(port)}`,
    );
  });
}
