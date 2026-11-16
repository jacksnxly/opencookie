import { randomBytes } from "node:crypto";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import next from "next";

const FIXTURE_NAME = "next-app";
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));
const allowedHosts = new Set([
  `app.${FIXTURE_NAME}.opencookie.test`,
  `shop.${FIXTURE_NAME}.opencookie.test`,
  `tracker.${FIXTURE_NAME}.opencookie.test`,
]);

function send(response, statusCode, body, headers = {}) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-opencookie-fixture": FIXTURE_NAME,
    ...headers,
  });
  response.end(body);
}

function requestHostname(hostHeader) {
  if (hostHeader.length === 0) return undefined;
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
  if (!/^[A-Za-z0-9.-]+$/u.test(hostname)) return undefined;
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

function safeRequestPath(requestTarget) {
  if (
    containsControlCharacter(requestTarget) ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//") ||
    requestTarget.includes("\\") ||
    requestTarget.includes("#")
  ) {
    return undefined;
  }
  const queryStart = requestTarget.indexOf("?");
  const pathname =
    queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  if (pathname.includes("%")) return undefined;
  const segments = pathname.split("/");
  return segments.some((segment) => segment === "." || segment === "..")
    ? undefined
    : pathname;
}

function strictCsp(nonce) {
  const trackerOrigin = `http://tracker.${FIXTURE_NAME}.opencookie.test:4400`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${trackerOrigin}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `frame-src ${trackerOrigin}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function requestProfiles(request) {
  const target = new URL(request.url, "http://fixture.invalid");
  const gpcSource =
    request.headers["sec-gpc"] === "1"
      ? "sec-gpc"
      : target.searchParams.get("oc-gpc") === "synthetic"
        ? "synthetic-test-only"
        : "none";
  const expiryProfile =
    target.pathname === "/short-expiry" ||
    target.searchParams.get("oc-expiry") === "short"
      ? "short-real-time"
      : "standard";
  return { expiryProfile, gpcSource };
}

function validatedHost(request) {
  const hostHeaders = request.headersDistinct?.host;
  if (hostHeaders === undefined || hostHeaders.length !== 1) return undefined;
  const hostname = requestHostname(hostHeaders[0]);
  return hostname !== undefined && allowedHosts.has(hostname)
    ? hostname
    : undefined;
}

export async function createNextFixtureServer() {
  const nextApplication = next({ dev: false, dir: fixtureRoot, quiet: true });
  await nextApplication.prepare();
  const handle = nextApplication.getRequestHandler();
  let applicationClosed = false;

  const server = http.createServer((request, response) => {
    const hostname = validatedHost(request);
    if (hostname === undefined) {
      send(response, 421, "Unknown fixture host.");
      return;
    }
    if (
      request.url === undefined ||
      safeRequestPath(request.url) === undefined
    ) {
      send(response, 400, "Invalid request path.");
      return;
    }

    if (hostname.startsWith("tracker.")) {
      if (safeRequestPath(request.url) === "/analytics.js") {
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
      if (safeRequestPath(request.url) === "/frame") {
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

    if (safeRequestPath(request.url) === "/__fixture/health") {
      send(response, 200, "ready", {
        "x-opencookie-fixture-health": "ready",
      });
      return;
    }

    if (safeRequestPath(request.url) === "/__fixture/status") {
      send(
        response,
        200,
        JSON.stringify({ fixture: FIXTURE_NAME, status: "ready" }),
        { "content-type": "application/json; charset=utf-8" },
      );
      return;
    }

    const nonce = randomBytes(18).toString("base64url");
    const policy = strictCsp(nonce);
    const profiles = requestProfiles(request);
    request.headers["content-security-policy"] = policy;
    request.headers["x-nonce"] = nonce;
    request.headers["x-opencookie-expiry-profile"] = profiles.expiryProfile;
    request.headers["x-opencookie-gpc-source"] = profiles.gpcSource;
    response.setHeader("content-security-policy", policy);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-opencookie-expiry-profile", profiles.expiryProfile);
    response.setHeader("x-opencookie-fixture", FIXTURE_NAME);
    response.setHeader("x-opencookie-gpc-source", profiles.gpcSource);
    void Promise.resolve(handle(request, response)).catch(() => {
      send(response, 500, "Fixture server failure.");
    });
  });

  return Object.freeze({
    async close() {
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
      }
      if (!applicationClosed) {
        applicationClosed = true;
        await nextApplication.close();
      }
    },
    server,
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  const port = Number.parseInt(process.env.PORT ?? "4530", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("PORT must be an integer from 1 through 65535.");
  }
  const fixture = await createNextFixtureServer();
  fixture.server.listen(port, "127.0.0.1", () => {
    console.log(
      `Next App fixture listening on http://127.0.0.1:${String(port)}`,
    );
  });
}
