import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_NAME = "sveltekit";
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));
const upstreamEntrypoint = fileURLToPath(
  new URL("./build/index.js", import.meta.url),
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
  const separator = hostHeader.lastIndexOf(":");
  const hostname =
    separator === -1 ? hostHeader : hostHeader.slice(0, separator);
  if (separator !== -1) {
    if (hostHeader.indexOf(":") !== separator) return undefined;
    const port = hostHeader.slice(separator + 1);
    if (!/^[0-9]{1,5}$/u.test(port) || Number(port) > 65_535) return undefined;
  }
  return /^[A-Za-z0-9.-]+$/u.test(hostname)
    ? hostname.toLowerCase()
    : undefined;
}

function decodedRequestPath(target) {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#")
  ) {
    return undefined;
  }
  const query = target.indexOf("?");
  const encoded = query === -1 ? target : target.slice(0, query);
  try {
    const decoded = decodeURIComponent(encoded);
    if (
      [...decoded].some((character) => {
        const point = character.codePointAt(0);
        return point !== undefined && (point <= 0x1f || point === 0x7f);
      }) ||
      decoded.includes("\\") ||
      decoded.startsWith("//") ||
      decoded.split("/").some((part) => part === "." || part === "..")
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

function strictPolicy(nonce) {
  const tracker = `http://tracker.${FIXTURE_NAME}.opencookie.test:4400`;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${tracker}`,
    // SvelteKit's route announcer has this exact accessibility style.
    `style-src 'self' 'nonce-${nonce}' 'unsafe-hashes' 'sha256-S8qMpvofolR8Mpjy4kQvEm7m1q8clzU4dfDH0AmvZjo='`,
    `frame-src ${tracker}`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function applyNonce(html, nonce) {
  return html
    .replace(/\snonce=(?:"[^"]*"|'[^']*')/gu, "")
    .replace(/<(script|style)\b([^>]*)>/gu, `<$1 nonce="${nonce}"$2>`)
    .replace(
      /<meta\b([^>]*\bdata-oc-csp(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*)>/gu,
      `<meta nonce="${nonce}"$1>`,
    );
}

function applyServerSignals(html, gpcEnabled) {
  return html.replace(
    /<html\b/u,
    `<html data-oc-server-gpc="${gpcEnabled ? "enabled" : "absent"}"`,
  );
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function availablePort() {
  const server = http.createServer();
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve an upstream port.");
  }
  server.close();
  await once(server, "close");
  return address.port;
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForUpstream(child, port, logs) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `SvelteKit upstream exited before startup (${String(child.exitCode)}).\n${logs.join("")}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`);
      if (response.ok) return;
    } catch {
      // The production server is still starting.
    }
    await delay(100);
  }
  throw new Error(`SvelteKit upstream startup timed out.\n${logs.join("")}`);
}

async function proxy(
  request,
  response,
  upstreamPort,
  hostname,
  strict,
  gpcEnabled,
) {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value !== undefined &&
        name !== "accept-encoding" &&
        name !== "connection" &&
        name !== "content-length" &&
        name !== "host"
      ) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    headers.set("accept-encoding", "identity");
    headers.set("host", `${hostname}:4400`);
    headers.set("x-forwarded-host", hostname);
    headers.set("x-forwarded-port", "4400");
    headers.set("x-forwarded-proto", "http");
    const upstream = await fetch(
      `http://127.0.0.1:${String(upstreamPort)}${request.url}`,
      { headers, method: request.method },
    );
    const responseHeaders = Object.fromEntries(upstream.headers);
    delete responseHeaders["content-encoding"];
    delete responseHeaders["content-length"];
    delete responseHeaders["transfer-encoding"];
    responseHeaders["cache-control"] = "no-store";
    responseHeaders["x-content-type-options"] = "nosniff";
    responseHeaders["x-opencookie-fixture"] = FIXTURE_NAME;
    let body = Buffer.from(await upstream.arrayBuffer());
    if ((upstream.headers.get("content-type") ?? "").includes("text/html")) {
      let html = applyServerSignals(body.toString("utf8"), gpcEnabled);
      if (strict) {
        const nonce = randomBytes(18).toString("base64");
        html = applyNonce(html, nonce);
        responseHeaders["content-security-policy"] = strictPolicy(nonce);
      }
      body = Buffer.from(html);
    }
    response.writeHead(upstream.status, responseHeaders);
    response.end(body);
  } catch {
    send(response, 502, "Fixture upstream failure.");
  }
}

function frontServer(upstreamPort) {
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
    void proxy(
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
  const upstreamPort = await availablePort();
  const logs = [];
  const child = spawn(process.execPath, [upstreamEntrypoint], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      HOST_HEADER: "x-forwarded-host",
      NODE_ENV: "production",
      PORT: String(upstreamPort),
      PORT_HEADER: "x-forwarded-port",
      PROTOCOL_HEADER: "x-forwarded-proto",
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
    const server = frontServer(upstreamPort);
    await listen(server, port);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("SvelteKit fixture did not expose a TCP port.");
    }
    let closed = false;
    return Object.freeze({
      async close() {
        if (closed) return;
        closed = true;
        server.closeAllConnections();
        server.close();
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
  const requestedPort = Number.parseInt(process.env.PORT ?? "4516", 10);
  const running = await startSsrFixtureServer({ port: requestedPort });
  console.log(
    `SvelteKit fixture listening on http://127.0.0.1:${String(running.port)}`,
  );
  const shutdown = async () => {
    await running.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
