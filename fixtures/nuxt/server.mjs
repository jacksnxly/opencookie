import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_NAME = "nuxt";
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));
const upstreamEntrypoint = fileURLToPath(
  new URL("./.output/server/index.mjs", import.meta.url),
);
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

function csp(nonce) {
  const trackerOrigin = `http://tracker.${FIXTURE_NAME}.opencookie.test:4400`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${trackerOrigin}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `frame-src ${trackerOrigin}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function nonceHtml(html, nonce) {
  const stripped = html.replace(/\snonce=(?:"[^"]*"|'[^']*')/gu, "");
  return stripped
    .replace(/<(script|style)\b([^>]*)>/gu, `<$1 nonce="${nonce}"$2>`)
    .replace(
      /<meta\b([^>]*\bdata-oc-csp(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*)>/gu,
      `<meta nonce="${nonce}"$1>`,
    );
}

function serverSignalHtml(html, gpcEnabled) {
  return html.replace(
    /<html\b/u,
    `<html data-oc-server-gpc="${gpcEnabled ? "enabled" : "absent"}"`,
  );
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function reservePort() {
  const server = http.createServer();
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve an upstream port.");
  }
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

function upstreamReady(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        headers: { host: `app.${FIXTURE_NAME}.opencookie.test:4400` },
        host: "127.0.0.1",
        path: "/",
        port,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode === 200));
      },
    );
    request.on("error", () => resolve(false));
  });
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForUpstream(child, port, logs) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Nuxt upstream exited before startup (${String(child.exitCode)}).\n${logs.join("")}`,
      );
    }
    if (await upstreamReady(port)) return;
    await delay(100);
  }
  throw new Error(`Nuxt upstream startup timed out.\n${logs.join("")}`);
}

function proxyHeaders(headers, hostname, upstreamPort) {
  const forwarded = { ...headers };
  delete forwarded["accept-encoding"];
  delete forwarded.connection;
  delete forwarded["content-length"];
  forwarded.host = `${hostname}:${String(upstreamPort)}`;
  return forwarded;
}

function proxyResponseHeaders(headers) {
  const forwarded = { ...headers };
  delete forwarded.connection;
  delete forwarded["content-length"];
  delete forwarded["transfer-encoding"];
  forwarded["cache-control"] = "no-store";
  forwarded["x-content-type-options"] = "nosniff";
  forwarded["x-opencookie-fixture"] = FIXTURE_NAME;
  return forwarded;
}

function proxyToUpstream(
  request,
  response,
  upstreamPort,
  hostname,
  strict,
  gpcEnabled,
) {
  const upstreamRequest = http.request(
    {
      headers: proxyHeaders(request.headers, hostname, upstreamPort),
      host: "127.0.0.1",
      method: request.method,
      path: request.url,
      port: upstreamPort,
    },
    (upstreamResponse) => {
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const headers = proxyResponseHeaders(upstreamResponse.headers);
        let body = Buffer.concat(chunks);
        if (String(headers["content-type"] ?? "").includes("text/html")) {
          let html = serverSignalHtml(body.toString("utf8"), gpcEnabled);
          if (strict) {
            const nonce = randomBytes(18).toString("base64");
            html = nonceHtml(html, nonce);
            headers["content-security-policy"] = csp(nonce);
          }
          body = Buffer.from(html);
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, headers);
        response.end(body);
      });
    },
  );
  upstreamRequest.on("error", () => {
    if (!response.headersSent) send(response, 502, "Fixture upstream failure.");
    else response.destroy();
  });
  request.pipe(upstreamRequest);
}

function createFrontServer(upstreamPort) {
  return http.createServer((request, response) => {
    const hostname = requestHostname(request.headers.host);
    if (hostname === undefined || !allowedHosts.has(hostname)) {
      send(response, 421, "Unknown fixture host.");
      return;
    }
    if (request.url === undefined) {
      send(response, 400, "Invalid request target.");
      return;
    }
    const pathname = decodedRequestPath(request.url);
    if (pathname === undefined) {
      send(response, 400, "Invalid request path.");
      return;
    }

    if (hostname.startsWith("tracker.")) {
      if (pathname === "/analytics.js") {
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
      if (pathname === "/frame") {
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

    if (pathname === "/__fixture/status" || pathname === "/__fixture/health") {
      send(
        response,
        200,
        JSON.stringify({ fixture: FIXTURE_NAME, status: "ready" }),
        {
          "content-type": "application/json; charset=utf-8",
          "x-opencookie-fixture-health": "ready",
        },
      );
      return;
    }

    proxyToUpstream(
      request,
      response,
      upstreamPort,
      hostname,
      pathname === "/strict-csp",
      request.headers["sec-gpc"] === "1",
    );
  });
}

export async function startSsrFixtureServer({ port = 0 } = {}) {
  const upstreamPort = await reservePort();
  const logs = [];
  const child = spawn(process.execPath, [upstreamEntrypoint], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      NITRO_HOST: "127.0.0.1",
      NITRO_PORT: String(upstreamPort),
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 200) logs.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  try {
    await waitForUpstream(child, upstreamPort, logs);
    const server = createFrontServer(upstreamPort);
    await listen(server, port);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Nuxt fixture did not expose a TCP port.");
    }
    let closed = false;
    return Object.freeze({
      async close() {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        server.close();
        if (server.listening) await once(server, "close");
        if (child.exitCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await Promise.race([exited, delay(2_000)]);
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      },
      port: address.port,
      server,
    });
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  const requestedPort = Number.parseInt(process.env.PORT ?? "4515", 10);
  const running = await startSsrFixtureServer({ port: requestedPort });
  console.log(
    `Nuxt fixture listening on http://127.0.0.1:${String(running.port)}`,
  );
  const shutdown = async () => {
    await running.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
