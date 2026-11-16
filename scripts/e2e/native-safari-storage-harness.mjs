import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_PARENT_PORT = 4760;
const DEFAULT_CHILD_PORT = 4761;
const PARENT_HOST = "::1";
const CHILD_HOST = "127.0.0.1";
const NONCE = "opencookie-native-safari-proof";

function normalizedRepositoryRoot(repositoryRoot) {
  if (repositoryRoot instanceof URL) return fileURLToPath(repositoryRoot);
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new TypeError(
      "Repository root must be an absolute path or file URL.",
    );
  }
  return path.normalize(repositoryRoot);
}

function validatedPort(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new TypeError(`${label} must be an integer between 0 and 65535.`);
  }
  return value;
}

function validatedRunId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value)
  ) {
    throw new TypeError(
      "Run id must contain 1 to 64 lowercase letters, digits, or hyphens.",
    );
  }
  return value;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Native Safari harness did not expose a TCP port."));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-opencookie-native-safari-harness": "true",
    ...headers,
  });
  response.end(body);
}

function statusScript({ context, storageKey }) {
  return `
<script nonce="${NONCE}">
(() => {
  const context = ${JSON.stringify(context)};
  const storageKey = ${JSON.stringify(storageKey)};
  const cookiePrefix = encodeURIComponent(storageKey) + "=";
  const value = (id, next) => {
    const target = document.getElementById(id);
    if (target && target.textContent !== next) target.textContent = next;
  };
  const visible = (target) =>
    target !== null && target.getClientRects().length > 0;
  const render = async () => {
    let cookiePresent = false;
    try {
      cookiePresent = document.cookie
        .split(";")
        .some((entry) => entry.trim().startsWith(cookiePrefix));
    } catch {}
    const dialog = document.querySelector("dialog.oc-panel[open]");
    const alert = document.querySelector('[role="alert"]');
    value("cookie-present", cookiePresent ? "yes" : "no");
    value("optional-runs", String(globalThis.__openCookieNativeOptionalRuns ?? 0));
    value("dialog-state", visible(dialog) ? "open" : "closed");
    value("alert-state", visible(alert) ? "visible" : "none");
    try {
      const response = await fetch("/proof-status?context=" + context, {
        cache: "no-store",
      });
      const status = await response.json();
      value("optional-requests", String(status.optionalRequests));
    } catch {
      value("optional-requests", "probe failed");
    }
  };
  new MutationObserver(() => void render()).observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  addEventListener("load", () => void render(), { once: true });
  setInterval(() => void render(), 250);
  void render();
})();
</script>`;
}

function childPage({ context, integrity, parentOrigin, runId }) {
  const crossSite = context === "cross-site";
  const contextLabel = crossSite
    ? "cross-site iframe"
    : "first-party top-level control";
  const storageKey = `opencookie.native.${crossSite ? "cross-site" : "first-party"}.${runId}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OpenCookie native Safari ${contextLabel}</title>
    <style nonce="${NONCE}">
      :root { color-scheme: light dark; font: 16px/1.45 system-ui, sans-serif; }
      body { margin: 0; padding: 24px; }
      main { max-width: 760px; margin: 0 auto; }
      .proof { border: 2px solid #5563de; border-radius: 14px; padding: 16px; background: color-mix(in srgb, Canvas 92%, #5563de 8%); }
      .proof h2 { margin-top: 0; }
      dl { display: grid; grid-template-columns: minmax(190px, 1fr) 1fr; gap: 8px 16px; margin-bottom: 0; }
      dt { font-weight: 700; }
      dd { margin: 0; font-family: ui-monospace, SFMono-Regular, monospace; }
      code { overflow-wrap: anywhere; }
    </style>
    <script
      defer
      nonce="${NONCE}"
      src="/auto.iife.js"
      integrity="${integrity}"
      crossorigin="anonymous"
      data-oc-policy-version="native-safari-${runId}"
      data-oc-storage="cookie"
      data-oc-storage-key="${storageKey}"
      data-oc-purpose-id="analytics"
      data-oc-purpose-label="Analytics"
      data-oc-purpose-description="Run the local optional proof script."
    ></script>
    <script
      type="text/plain"
      data-src="/optional.js?context=${context}"
      data-oc-resource="native-safari-optional-script"
      data-oc-category="analytics"
    ></script>
  </head>
  <body>
    <main>
      <h1>OpenCookie native Safari storage proof</h1>
      <p>Context: <strong>${contextLabel}</strong></p>
      <p>Decision key: <code>${storageKey}</code></p>
      <section class="proof" aria-labelledby="proof-status-title">
        <h2 id="proof-status-title">Live proof status</h2>
        <dl>
          <dt>Decision cookie present</dt><dd id="cookie-present">checking</dd>
          <dt>Optional script requests</dt><dd id="optional-requests">checking</dd>
          <dt>Optional script runs</dt><dd id="optional-runs">0</dd>
          <dt>Consent dialog</dt><dd id="dialog-state">checking</dd>
          <dt>Persistence alert</dt><dd id="alert-state">checking</dd>
        </dl>
      </section>
      ${
        crossSite
          ? `<p>This child is embedded by <code>${parentOrigin}</code> while its own origin is <code>http://${CHILD_HOST}</code>.</p>`
          : "<p>This control uses the same child origin as a top-level page.</p>"
      }
    </main>
    ${statusScript({ context, storageKey })}
  </body>
</html>`;
}

function parentPage(crossSiteChildUrl) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OpenCookie native Safari cross-site proof</title>
    <style nonce="${NONCE}">
      :root { color-scheme: light dark; font: 16px/1.45 system-ui, sans-serif; }
      body { margin: 0; padding: 24px; }
      main { max-width: 1100px; margin: 0 auto; }
      iframe { width: 100%; height: 780px; border: 2px solid #5563de; border-radius: 14px; background: Canvas; }
      code { overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>Safari native cross-site cookie policy</h1>
      <p>This top-level page is on <code>localhost</code>. The consent surface below is a real iframe on <code>127.0.0.1</code>.</p>
      <iframe title="Cross-site OpenCookie consent surface" src="${crossSiteChildUrl}"></iframe>
    </main>
  </body>
</html>`;
}

/** Starts a loopback-only two-origin harness for direct, branded Safari proof. */
export async function startNativeSafariStorageHarness({
  childPort = DEFAULT_CHILD_PORT,
  parentPort = DEFAULT_PARENT_PORT,
  repositoryRoot,
  runId,
}) {
  const root = normalizedRepositoryRoot(repositoryRoot);
  const validatedChildPort = validatedPort(childPort, "Child port");
  const validatedParentPort = validatedPort(parentPort, "Parent port");
  const validatedId = validatedRunId(runId);
  const bundle = await readFile(
    path.join(root, "packages/adapters/vanilla/dist/auto.iife.js"),
  );
  const integrity = `sha384-${createHash("sha384")
    .update(bundle)
    .digest("base64")}`;
  const optionalRequests = { "cross-site": 0, "first-party": 0 };
  let parentOrigin = "";

  const childServer = http.createServer((request, response) => {
    const requestedUrl = new URL(request.url ?? "/", `http://${CHILD_HOST}`);
    if (requestedUrl.pathname === "/auto.iife.js") {
      send(response, 200, bundle, {
        "content-type": "text/javascript; charset=utf-8",
      });
      return;
    }
    if (requestedUrl.pathname === "/optional.js") {
      const context = requestedUrl.searchParams.get("context");
      if (context !== "cross-site" && context !== "first-party") {
        send(response, 400, "Unknown proof context.");
        return;
      }
      optionalRequests[context] += 1;
      send(
        response,
        200,
        "globalThis.__openCookieNativeOptionalRuns = (globalThis.__openCookieNativeOptionalRuns ?? 0) + 1;",
        { "content-type": "text/javascript; charset=utf-8" },
      );
      return;
    }
    if (requestedUrl.pathname === "/proof-status") {
      const context = requestedUrl.searchParams.get("context");
      if (context !== "cross-site" && context !== "first-party") {
        send(response, 400, "Unknown proof context.");
        return;
      }
      send(
        response,
        200,
        `${JSON.stringify({ optionalRequests: optionalRequests[context] })}\n`,
        { "content-type": "application/json; charset=utf-8" },
      );
      return;
    }
    if (
      requestedUrl.pathname === "/cross-site" ||
      requestedUrl.pathname === "/first-party"
    ) {
      const context = requestedUrl.pathname.slice(1);
      send(
        response,
        200,
        childPage({ context, integrity, parentOrigin, runId: validatedId }),
        {
          "content-security-policy": [
            "default-src 'none'",
            `script-src 'self' 'nonce-${NONCE}'`,
            `style-src 'nonce-${NONCE}'`,
            "connect-src 'self'",
            `frame-ancestors ${parentOrigin}`,
            "base-uri 'none'",
            "form-action 'none'",
          ].join("; "),
          "content-type": "text/html; charset=utf-8",
        },
      );
      return;
    }
    send(response, 404, "Unknown native Safari harness route.");
  });

  let childListeningPort;
  let parentServer;
  try {
    childListeningPort = await listen(
      childServer,
      validatedChildPort,
      CHILD_HOST,
    );
    const crossSiteChildUrl = `http://${CHILD_HOST}:${String(childListeningPort)}/cross-site`;
    parentServer = http.createServer((request, response) => {
      const requestedUrl = new URL(request.url ?? "/", "http://localhost");
      if (
        requestedUrl.pathname !== "/" &&
        requestedUrl.pathname !== "/cross-site"
      ) {
        send(response, 404, "Unknown native Safari harness route.");
        return;
      }
      send(response, 200, parentPage(crossSiteChildUrl), {
        "content-security-policy": [
          "default-src 'none'",
          `style-src 'nonce-${NONCE}'`,
          `frame-src http://${CHILD_HOST}:${String(childListeningPort)}`,
          "base-uri 'none'",
          "form-action 'none'",
        ].join("; "),
        "content-type": "text/html; charset=utf-8",
      });
    });
    const parentListeningPort = await listen(
      parentServer,
      validatedParentPort,
      PARENT_HOST,
    );
    parentOrigin = `http://localhost:${String(parentListeningPort)}`;

    let closed = false;
    return Object.freeze({
      bundleIntegrity: integrity,
      bundleUrl: `http://${CHILD_HOST}:${String(childListeningPort)}/auto.iife.js`,
      childOrigin: `http://${CHILD_HOST}:${String(childListeningPort)}`,
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all([
          closeServer(parentServer),
          closeServer(childServer),
        ]);
      },
      crossSiteChildUrl,
      firstPartyUrl: `http://${CHILD_HOST}:${String(childListeningPort)}/first-party`,
      parentUrl: `${parentOrigin}/cross-site`,
      runId: validatedId,
    });
  } catch (error) {
    await Promise.all([
      closeServer(childServer),
      ...(parentServer === undefined ? [] : [closeServer(parentServer)]),
    ]);
    throw error;
  }
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value.`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--child-port", "--parent-port", "--run-id"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index])) {
      throw new Error(`Unknown option: ${String(args[index])}`);
    }
    if (args[index + 1] === undefined) {
      throw new Error(`${String(args[index])} requires a value.`);
    }
  }
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const defaultRunId = `manual-${new Date()
    .toISOString()
    .replaceAll(/[^0-9]/gu, "")
    .slice(0, 14)}`;
  const harness = await startNativeSafariStorageHarness({
    childPort: Number.parseInt(
      optionValue(args, "--child-port", String(DEFAULT_CHILD_PORT)),
      10,
    ),
    parentPort: Number.parseInt(
      optionValue(args, "--parent-port", String(DEFAULT_PARENT_PORT)),
      10,
    ),
    repositoryRoot,
    runId: optionValue(args, "--run-id", defaultRunId),
  });
  console.log("OpenCookie native Safari storage harness ready.");
  console.log(`Cross-site URL: ${harness.parentUrl}`);
  console.log(`First-party control URL: ${harness.firstPartyUrl}`);
  console.log(`Bundle integrity: ${harness.bundleIntegrity}`);

  const stop = async () => {
    await harness.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
