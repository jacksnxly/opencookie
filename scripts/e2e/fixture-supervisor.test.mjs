import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { E2E_FIXTURES } from "./project-matrix.mjs";
import {
  createFixtureEnvironment,
  createFixtureRunPlan,
  parseFixtureSelection,
  signalChild,
  startE2EEnvironment,
} from "./fixture-supervisor.mjs";

const environments = new Set();

async function availablePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

function proxyRequest(proxyPort, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const targetHost = new URL(absoluteUrl).host;
    const request = http.get(
      {
        headers: { host: targetHost },
        host: "127.0.0.1",
        path: absoluteUrl,
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
  });
}

afterEach(async () => {
  await Promise.all(
    [...environments].map((environment) => environment.close()),
  );
  environments.clear();
});

describe("fixture supervisor", () => {
  it("does not combine NO_COLOR with an inherited FORCE_COLOR override", () => {
    assert.deepEqual(
      createFixtureEnvironment(
        {
          FORCE_COLOR: "1",
          NODE_ENV: "development",
          TOKEN: "preserved",
        },
        4510,
      ),
      {
        CI: "1",
        FORCE_COLOR: "1",
        NODE_ENV: "production",
        PORT: "4510",
        TOKEN: "preserved",
      },
    );
    assert.deepEqual(createFixtureEnvironment({ CI: "0" }, 4511), {
      CI: "0",
      NODE_ENV: "production",
      NO_COLOR: "1",
      PORT: "4511",
    });
  });

  it("parses an explicit development fixture subset without weakening validation", () => {
    assert.deepEqual(parseFixtureSelection(undefined), E2E_FIXTURES);
    assert.deepEqual(parseFixtureSelection("plain-cdn, vue-vite"), [
      "plain-cdn",
      "vue-vite",
    ]);
    assert.throws(
      () => parseFixtureSelection("plain-cdn,plain-cdn"),
      /Duplicate E2E fixture/u,
    );
    assert.throws(
      () => parseFixtureSelection("plain-cdn,unknown"),
      /Unknown E2E fixture/u,
    );
  });

  it("defines one deterministic production process for every matrix fixture", () => {
    const repositoryRoot = path.resolve(".");
    const plan = createFixtureRunPlan(repositoryRoot);

    assert.deepEqual(
      plan.map((entry) => entry.fixtureId),
      E2E_FIXTURES,
    );
    assert.equal(new Set(plan.map((entry) => entry.port)).size, 8);
    for (const entry of plan) {
      assert.equal(entry.command, "pnpm");
      assert.deepEqual(entry.args, [
        "--filter",
        `@opencookie-fixtures/${entry.fixtureId}`,
        "start",
      ]);
      assert.equal(entry.cwd, repositoryRoot);
      assert.equal(entry.healthHost, `app.${entry.fixtureId}.opencookie.test`);
      assert.equal(entry.healthPath, "/__fixture/health");
    }
  });

  it("starts a real fixture, waits for health, forwards bytes, and closes cleanly", async () => {
    const fixturePort = await availablePort();
    const environment = await startE2EEnvironment({
      fixtureIds: ["plain-cdn"],
      fixturePorts: { "plain-cdn": fixturePort },
      proxyPort: 0,
      repositoryRoot: path.resolve("."),
      startupTimeoutMs: 15_000,
    });
    environments.add(environment);

    const response = await proxyRequest(
      environment.proxyPort,
      "http://app.plain-cdn.opencookie.test:4400/",
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-opencookie-cdn-substitution"], "local");
    assert.match(response.body, /OpenCookie plain CDN fixture/u);

    await environment.close();
    environments.delete(environment);
    await assert.rejects(
      proxyRequest(
        environment.proxyPort,
        "http://app.plain-cdn.opencookie.test:4400/",
      ),
    );
  });
});

// A process group whose only member has exited but is not yet reaped. This
// process's event loop stays blocked until `ps` shows the zombie, so Node
// cannot reap it first. macOS then answers every signal to the group,
// even 0, with EPERM, until the parent reaps it.
function zombieGroupLeader() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    detached: true,
    stdio: "ignore",
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(child.pid)], {
      encoding: "utf8",
    }).stdout.trim();
    if (state.startsWith("Z")) return child;
  }
  throw new Error("The child never became an unreaped zombie.");
}

describe("fixture teardown", () => {
  it("treats an exited, unreaped group as nothing left to signal", async () => {
    const child = zombieGroupLeader();
    const exited = once(child, "exit");

    assert.doesNotThrow(() => signalChild(child, "SIGTERM"));

    await exited;
  });
});
