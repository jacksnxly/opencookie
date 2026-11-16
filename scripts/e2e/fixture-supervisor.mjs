import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";

import { createForwardProxy } from "./forward-proxy.mjs";
import { E2E_FIXTURES } from "./project-matrix.mjs";

const DEFAULT_FIXTURE_PORT_BASE = 4510;
const DEFAULT_PROXY_PORT = 4400;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_HEADER = "x-opencookie-fixture-health";
const HEALTH_PATH = "/__fixture/health";
const HOST_ROLES = Object.freeze(["app", "shop", "tracker"]);

function validatePort(value, label, allowZero = false) {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 65_535
  ) {
    throw new TypeError(`${label} must be a valid TCP port.`);
  }
  return value;
}

function validateRepositoryRoot(repositoryRoot) {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new TypeError("Fixture repository root must be absolute.");
  }
  return path.normalize(repositoryRoot);
}

function validateFixtureIds(fixtureIds) {
  const seen = new Set();
  return Object.freeze(
    fixtureIds.map((fixtureId) => {
      if (!E2E_FIXTURES.includes(fixtureId)) {
        throw new TypeError(`Unknown E2E fixture: ${fixtureId}`);
      }
      if (seen.has(fixtureId)) {
        throw new TypeError(`Duplicate E2E fixture: ${fixtureId}`);
      }
      seen.add(fixtureId);
      return fixtureId;
    }),
  );
}

/** Parses the optional comma-separated development fixture selection. */
export function parseFixtureSelection(configuredSelection) {
  if (
    configuredSelection === undefined ||
    configuredSelection.trim().length === 0
  ) {
    return validateFixtureIds(E2E_FIXTURES);
  }
  return validateFixtureIds(
    configuredSelection.split(",").map((fixtureId) => fixtureId.trim()),
  );
}

/** Creates the deterministic process plan used by local runs and CI. */
export function createFixtureRunPlan(
  repositoryRoot,
  { fixturePorts = {} } = {},
) {
  const cwd = validateRepositoryRoot(repositoryRoot);
  return Object.freeze(
    E2E_FIXTURES.map((fixtureId, index) => {
      const configuredPort = fixturePorts[fixtureId];
      const port = validatePort(
        configuredPort ?? DEFAULT_FIXTURE_PORT_BASE + index,
        `${fixtureId} fixture port`,
      );
      return Object.freeze({
        args: Object.freeze([
          "--filter",
          `@opencookie-fixtures/${fixtureId}`,
          "start",
        ]),
        command: "pnpm",
        cwd,
        fixtureId,
        healthHost: `app.${fixtureId}.opencookie.test`,
        healthPath: HEALTH_PATH,
        port,
      });
    }),
  );
}

function proxyTargets(plan) {
  return Object.fromEntries(
    plan.flatMap((entry) =>
      HOST_ROLES.map((role) => [
        `${role}.${entry.fixtureId}.opencookie.test`,
        `http://127.0.0.1:${String(entry.port)}`,
      ]),
    ),
  );
}

function healthRequest(entry) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        headers: { host: `${entry.healthHost}:4400` },
        host: "127.0.0.1",
        path: entry.healthPath,
        port: entry.port,
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(
            response.statusCode === 200 &&
              response.headers[HEALTH_HEADER] === "ready",
          );
        });
      },
    );
    request.on("error", () => resolve(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth(entry, child, logs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `${entry.fixtureId} exited before becoming healthy (${String(child.exitCode)}).\n${logs.join("")}`,
      );
    }
    if (await healthRequest(entry)) return;
    await delay(100);
  }
  throw new Error(
    `${entry.fixtureId} did not become healthy within ${String(timeoutMs)} ms.\n${logs.join("")}`,
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

/**
 * Signals a fixture server's process group. macOS answers EPERM for a group
 * whose members have all exited and wait to be reaped, which leaves nothing
 * to stop; the exit wait that follows decides the outcome.
 */
export function signalChild(child, signal) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  signalChild(child, "SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(2_000).then(() => false),
  ]);
  if (stopped) return;
  signalChild(child, "SIGKILL");
  await exited;
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

/** Builds a child environment without contradictory color directives. */
export function createFixtureEnvironment(parentEnvironment, port) {
  const environment = {
    ...parentEnvironment,
    CI: parentEnvironment.CI ?? "1",
    NODE_ENV: "production",
    PORT: String(port),
  };
  if (parentEnvironment.FORCE_COLOR === undefined) {
    environment.NO_COLOR = parentEnvironment.NO_COLOR ?? "1";
  } else {
    delete environment.NO_COLOR;
  }
  return environment;
}

/** Starts selected production fixtures and their loopback forward proxy. */
export async function startE2EEnvironment({
  fixtureIds = E2E_FIXTURES,
  fixturePorts = {},
  proxyPort = DEFAULT_PROXY_PORT,
  repositoryRoot,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
}) {
  const selectedFixtureIds = validateFixtureIds(fixtureIds);
  validatePort(proxyPort, "E2E proxy port", true);
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1) {
    throw new TypeError("Fixture startup timeout must be a positive integer.");
  }
  const selected = new Set(selectedFixtureIds);
  const plan = createFixtureRunPlan(repositoryRoot, { fixturePorts }).filter(
    (entry) => selected.has(entry.fixtureId),
  );
  const processes = [];
  let proxy;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([
      ...(proxy === undefined ? [] : [closeServer(proxy)]),
      ...processes.map(({ child }) => stopChild(child)),
    ]);
  };

  try {
    for (const entry of plan) {
      const logs = [];
      const child = spawn(entry.command, entry.args, {
        cwd: entry.cwd,
        detached: process.platform !== "win32",
        env: createFixtureEnvironment(process.env, entry.port),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk) => {
        logs.push(String(chunk));
        if (logs.length > 200) logs.shift();
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      processes.push({ child, entry, logs });
    }

    await Promise.all(
      processes.map(({ child, entry, logs }) =>
        waitForHealth(entry, child, logs, startupTimeoutMs),
      ),
    );
    proxy = createForwardProxy({ targets: proxyTargets(plan) });
    await listen(proxy, proxyPort);
    const address = proxy.address();
    if (address === null || typeof address === "string") {
      throw new Error("E2E proxy did not expose a TCP address.");
    }

    return Object.freeze({
      close,
      fixtureIds: selectedFixtureIds,
      proxyPort: address.port,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
