import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";

const exactStableVersion =
  /^(?:0|[1-9]\d*)[.](?:0|[1-9]\d*)[.](?:0|[1-9]\d*)$/u;
const sha384Token = /^sha384-[A-Za-z0-9+/]{64}$/u;
const scriptTag = /<script\b(?<attributes>[^>]*)>/giu;
const htmlAttribute =
  /(?<name>[^\s"'=<>`]+)(?:\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s"'=<>`]+)))?/gu;

export const CDN_BUILD_COMMAND = Object.freeze({
  args: Object.freeze(["--filter", "@opencookie-dev/vanilla...", "build"]),
  command: "pnpm",
});

export function sha384Integrity(bytes) {
  if (!ArrayBuffer.isView(bytes)) {
    throw new TypeError("SRI input must be an exact byte view.");
  }
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

export function validateCdnIntegrityMetadata(metadata) {
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new TypeError("CDN integrity metadata must be an object.");
  }
  if (metadata.package !== "@opencookie-dev/vanilla") {
    throw new Error(
      "CDN integrity metadata must name @opencookie-dev/vanilla.",
    );
  }
  if (!exactStableVersion.test(metadata.version ?? "")) {
    throw new Error(
      "CDN integrity metadata must use an exact semantic version.",
    );
  }
  if (metadata.file !== "dist/auto.iife.js") {
    throw new Error("CDN integrity metadata must bind dist/auto.iife.js.");
  }
  if (
    metadata.algorithm !== "sha384" ||
    !sha384Token.test(metadata.integrity ?? "")
  ) {
    throw new Error("CDN integrity metadata must contain one SHA-384 token.");
  }
  return metadata;
}

export function canonicalCdnUrl(metadata) {
  const valid = validateCdnIntegrityMetadata(metadata);
  return `https://cdn.jsdelivr.net/npm/${valid.package}@${valid.version}/${valid.file}`;
}

function parseAttributes(source) {
  const attributes = new Map();
  for (const match of source.matchAll(htmlAttribute)) {
    const name = match.groups.name.toLowerCase();
    if (attributes.has(name)) {
      throw new Error(`CDN script contains duplicate ${name} attributes.`);
    }
    attributes.set(
      name,
      match.groups.double ?? match.groups.single ?? match.groups.bare ?? "",
    );
  }
  return attributes;
}

export function assertCdnScriptMarkup(
  markup,
  metadata,
  { expectedCount, label = "CDN source" },
) {
  if (typeof markup !== "string") {
    throw new TypeError(`${label} must be text.`);
  }
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new TypeError(
      `${label} expectedCount must be a non-negative integer.`,
    );
  }
  const expectedUrl = canonicalCdnUrl(metadata);
  let count = 0;
  for (const match of markup.matchAll(scriptTag)) {
    const attributes = parseAttributes(match.groups.attributes);
    const source = attributes.get("src");
    if (
      source === undefined ||
      !source.startsWith(
        "https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@",
      )
    ) {
      continue;
    }
    count += 1;
    if (source !== expectedUrl) {
      throw new Error(`${label} must use the exact-version canonical CDN URL.`);
    }
    if (attributes.get("integrity") !== metadata.integrity) {
      throw new Error(`${label} must bind the packed SHA-384 integrity token.`);
    }
    if (attributes.get("crossorigin") !== "anonymous") {
      throw new Error(`${label} must set crossorigin="anonymous".`);
    }
  }
  if (count !== expectedCount) {
    throw new Error(
      `${label} contains ${String(count)} protected CDN scripts; expected ${String(expectedCount)}.`,
    );
  }
  return count;
}

function listen(server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("SRI proof server did not expose a TCP address.");
    }
    return address.port;
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  server.close();
  await once(server, "close");
}

function send(response, statusCode, contentType, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function proofPage(cdnOrigin, integrity, variant) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SRI ${variant}</title></head>
<body><script>
globalThis.__ocSriOutcome = undefined;
const script = document.createElement("script");
script.src = ${JSON.stringify(`${cdnOrigin}/${variant}.js`)};
script.integrity = ${JSON.stringify(integrity)};
script.crossOrigin = "anonymous";
script.addEventListener("load", () => {
  globalThis.__ocSriOutcome = {
    loaded: true,
    namespacePresent: Boolean(globalThis.OpenCookie),
  };
});
script.addEventListener("error", () => {
  globalThis.__ocSriOutcome = {
    loaded: false,
    namespacePresent: Boolean(globalThis.OpenCookie),
  };
});
document.head.append(script);
</script></body></html>`;
}

export async function proveCrossOriginSri({
  browserType,
  bundleBytes,
  integrity,
}) {
  if (typeof browserType?.launch !== "function") {
    throw new TypeError(
      "SRI browser proof requires a Playwright browser type.",
    );
  }
  if (!ArrayBuffer.isView(bundleBytes) || bundleBytes.byteLength === 0) {
    throw new TypeError("SRI browser proof requires non-empty bundle bytes.");
  }
  if (!sha384Token.test(integrity ?? "")) {
    throw new TypeError(
      "SRI browser proof requires a SHA-384 integrity token.",
    );
  }

  const tamperedBytes = Buffer.concat([
    Buffer.from(
      bundleBytes.buffer,
      bundleBytes.byteOffset,
      bundleBytes.byteLength,
    ),
    Buffer.from("\n;globalThis.__ocSriTampered = true;\n"),
  ]);
  const cdnServer = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://cdn.local").pathname;
    if (pathname === "/genuine.js") {
      send(response, 200, "text/javascript; charset=utf-8", bundleBytes, {
        "access-control-allow-origin": "*",
      });
      return;
    }
    if (pathname === "/tampered.js") {
      send(response, 200, "text/javascript; charset=utf-8", tamperedBytes, {
        "access-control-allow-origin": "*",
      });
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found.");
  });
  let cdnOrigin;
  const pageServer = http.createServer((request, response) => {
    const variant = new URL(
      request.url ?? "/",
      "http://page.local",
    ).searchParams.get("case");
    if (variant !== "genuine" && variant !== "tampered") {
      send(response, 400, "text/plain; charset=utf-8", "Invalid SRI case.");
      return;
    }
    send(
      response,
      200,
      "text/html; charset=utf-8",
      proofPage(cdnOrigin, integrity, variant),
    );
  });
  let browser;
  try {
    const cdnPort = await listen(cdnServer);
    cdnOrigin = `http://127.0.0.1:${String(cdnPort)}`;
    const pagePort = await listen(pageServer);
    const pageOrigin = `http://127.0.0.1:${String(pagePort)}`;
    browser = await browserType.launch({ headless: true });

    const outcomes = {};
    for (const variant of ["genuine", "tampered"]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${pageOrigin}/?case=${variant}`, {
          waitUntil: "domcontentloaded",
        });
        await page.waitForFunction(
          () => globalThis.__ocSriOutcome !== undefined,
          undefined,
          { timeout: 10_000 },
        );
        outcomes[variant] = await page.evaluate(
          () => globalThis.__ocSriOutcome,
        );
      } finally {
        await context.close();
      }
    }
    return Object.freeze({
      genuine: Object.freeze(outcomes.genuine),
      tampered: Object.freeze(outcomes.tampered),
    });
  } finally {
    await browser?.close();
    await Promise.all([closeServer(pageServer), closeServer(cdnServer)]);
  }
}
