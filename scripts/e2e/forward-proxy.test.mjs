import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import { createForwardProxy } from "./forward-proxy.mjs";

const servers = new Set();

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.add(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

function requestThrough(proxyPort, targetUrl, body = "") {
  return new Promise((resolve, reject) => {
    let targetHost = "app.plain-cdn.opencookie.test:4400";
    try {
      targetHost = new URL(targetUrl).host;
    } catch {
      // Keep a valid Host header so the proxy itself receives malformed paths.
    }
    const request = http.request(
      {
        headers: {
          "content-type": "text/plain",
          host: targetHost,
        },
        host: "127.0.0.1",
        method: body.length === 0 ? "GET" : "POST",
        path: targetUrl,
        port: proxyPort,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

afterEach(async () => {
  await Promise.all([...servers].map(close));
  servers.clear();
});

describe("local E2E forward proxy", () => {
  it("forwards real request and response bytes while preserving the test host", async () => {
    const backend = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(201, {
          "content-type": "application/json",
          "x-fixture-backend": "plain-cdn",
        });
        response.end(
          JSON.stringify({
            body: Buffer.concat(chunks).toString("utf8"),
            host: request.headers.host,
            path: request.url,
          }),
        );
      });
    });
    const backendPort = await listen(backend);
    const proxy = createForwardProxy({
      targets: {
        "app.plain-cdn.opencookie.test": `http://127.0.0.1:${backendPort}`,
      },
    });
    const proxyPort = await listen(proxy);

    const result = await requestThrough(
      proxyPort,
      "http://app.plain-cdn.opencookie.test:4400/consent?run=42",
      "real-body",
    );

    assert.equal(result.statusCode, 201);
    assert.equal(result.headers["x-fixture-backend"], "plain-cdn");
    assert.deepEqual(JSON.parse(result.body), {
      body: "real-body",
      host: "app.plain-cdn.opencookie.test:4400",
      path: "/consent?run=42",
    });
  });

  it("rejects unknown, non-test, and malformed destinations without forwarding", async () => {
    const proxy = createForwardProxy({ targets: {} });
    const proxyPort = await listen(proxy);

    for (const target of [
      "http://unknown.opencookie.test:4400/",
      "http://example.com/",
      "/relative-path",
    ]) {
      const result = await requestThrough(proxyPort, target);
      assert.equal(result.statusCode, 421);
    }
  });
});
