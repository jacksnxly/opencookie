import http from "node:http";

const RESERVED_HOST_SUFFIX = ".opencookie.test";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizedTargets(configuredTargets) {
  const targets = new Map();
  for (const [configuredHostname, configuredTarget] of Object.entries(
    configuredTargets,
  )) {
    const hostname = configuredHostname.toLowerCase();
    if (!hostname.endsWith(RESERVED_HOST_SUFFIX) || hostname.includes(":")) {
      throw new TypeError(
        `Forward proxy hostname must be a reserved OpenCookie test host: ${configuredHostname}`,
      );
    }
    const target = new URL(configuredTarget);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
      throw new TypeError(
        `Forward proxy target must use loopback HTTP: ${configuredTarget}`,
      );
    }
    if (target.pathname !== "/" || target.search || target.hash) {
      throw new TypeError(
        `Forward proxy target cannot contain a path, query, or fragment: ${configuredTarget}`,
      );
    }
    targets.set(hostname, target);
  }
  return targets;
}

function forwardedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) =>
        value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
    ),
  );
}

function reject(response, statusCode, message) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

/**
 * Creates a loopback-only HTTP forward proxy for reserved `.test` origins.
 * The caller owns listening and closing the returned server.
 */
export function createForwardProxy({ targets: configuredTargets }) {
  const targets = normalizedTargets(configuredTargets);
  const server = http.createServer((request, response) => {
    let requestedUrl;
    try {
      requestedUrl = new URL(request.url ?? "");
    } catch {
      reject(response, 421, "Absolute reserved test URL required.");
      return;
    }

    const hostname = requestedUrl.hostname.toLowerCase();
    const target = targets.get(hostname);
    if (
      requestedUrl.protocol !== "http:" ||
      !hostname.endsWith(RESERVED_HOST_SUFFIX) ||
      target === undefined
    ) {
      reject(response, 421, "Unknown reserved test origin.");
      return;
    }

    const upstream = http.request(
      {
        headers: forwardedHeaders(request.headers),
        host: target.hostname,
        method: request.method,
        path: `${requestedUrl.pathname}${requestedUrl.search}`,
        port: target.port,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          forwardedHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );

    upstream.on("error", () => {
      if (!response.headersSent) {
        reject(response, 502, "Fixture server unavailable.");
      } else {
        response.destroy();
      }
    });
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });

  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
  });
  return server;
}
