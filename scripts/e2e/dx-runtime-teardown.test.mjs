import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createCanonicalPackedTemporaryDirectory,
  hasSameProcessIdentity,
  isProcessGroupAlive,
  isRegistryPublicationInvocation,
  createConsumerProcessEnvironment,
  neutralizeAgentEnvironment,
  npmEnvironments,
  packedConsumerStoreDirectory,
  normalizeConsumerRegistryEnvironment,
  pinPnpmCachePreference,
  readTarballMember,
  runPackedCommand,
  signalProcessTarget,
  stopTrackedProcessTree,
} from "./dx-runtime.mjs";

const execFileAsync = promisify(execFile);

test("consumer command guards discard inherited registry overrides", () => {
  assert.deepEqual(
    normalizeConsumerRegistryEnvironment(
      {
        KEEP: "yes",
        NPM_CONFIG_REGISTRY: "https://upper.invalid/",
        PNPM_CONFIG_REGISTRY: "https://pnpm-upper.invalid/",
        npm_config_registry: "http://127.0.0.1:4873/",
        pnpm_config_registry: "https://pnpm-lower.invalid/",
        pnpm_config_pm_on_fail: "ignore",
      },
      "https://registry.npmjs.org/",
    ),
    {
      KEEP: "yes",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
      pnpm_config_pm_on_fail: "ignore",
    },
  );
});

test("packed pnpm consumers prefer cached data without requiring offline state", () => {
  assert.deepEqual(
    pinPnpmCachePreference(
      {
        KEEP: "yes",
        PNPM_CONFIG_PREFER_OFFLINE: "false",
      },
      "pnpm",
    ),
    {
      KEEP: "yes",
      PNPM_CONFIG_PREFER_OFFLINE: "true",
    },
  );
  assert.deepEqual(pinPnpmCachePreference({ KEEP: "yes" }, "npm"), {
    KEEP: "yes",
  });
});

test("packed consumers never inherit the operator's agent identity", () => {
  const inherited = Object.freeze({
    AGENT: "crush",
    AIDER_API_KEY: "key",
    AI_AGENT: "crush",
    AMP_CURRENT_THREAD_ID: "thread",
    ANTIGRAVITY_AGENT: "1",
    ANTIGRAVITY_PROJECT_ID: "project",
    AUGMENT_AGENT: "1",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CODEIUM_EDITOR_APP_ROOT: "/opt/codeium",
    CODEX_THREAD_ID: "thread",
    CRUSH: "1",
    CURSOR_TRACE_ID: "trace",
    GEMINI_CLI: "1",
    GIT_PAGER: "cat",
    HOME: "/Users/developer",
    OPENCODE: "1",
    OPENCODE_APP_INFO: "info",
    OPENCODE_BIN_PATH: "/opt/opencode",
    OPENCODE_MODES: "modes",
    OPENCODE_SERVER: "server",
    PAGER: "head -n 10000 | cat",
    PATH: "/usr/bin",
    PI_CODING_AGENT: "true",
    QWEN_CODE: "1",
    REPLIT_MODE: "assistant",
    REPL_ID: "repl",
    SHELL: "/bin/zsh",
    USER: "developer",
    npm_config_registry: "http://127.0.0.1:4873/",
  });

  assert.deepEqual(neutralizeAgentEnvironment(inherited), {
    HOME: "/Users/developer",
    PATH: "/usr/bin",
    SHELL: "/bin/zsh",
    USER: "developer",
    npm_config_registry: "http://127.0.0.1:4873/",
  });
  assert.equal(inherited.CLAUDECODE, "1");
});

test("packed consumer processes are both cache-preferred and agent-neutral", () => {
  assert.deepEqual(
    createConsumerProcessEnvironment(
      { CLAUDECODE: "1", KEEP: "yes", PAGER: "cat" },
      "pnpm",
    ),
    {
      KEEP: "yes",
      PNPM_CONFIG_PREFER_OFFLINE: "true",
    },
  );
  assert.deepEqual(
    createConsumerProcessEnvironment(
      { CODEX_THREAD_ID: "t", KEEP: "yes" },
      "npm",
    ),
    { KEEP: "yes" },
  );
});

test("packed consumers resolve the store pnpm documents for the platform", () => {
  assert.equal(
    packedConsumerStoreDirectory("/Users/developer", "darwin"),
    path.join("/Users/developer", "Library", "pnpm", "store"),
  );
  assert.equal(
    packedConsumerStoreDirectory("/home/developer", "linux"),
    path.join("/home/developer", ".local", "share", "pnpm", "store"),
  );
  assert.equal(
    packedConsumerStoreDirectory("C:\\Users\\developer", "win32"),
    path.join("C:\\Users\\developer", "AppData", "Local", "pnpm", "store"),
  );
  assert.throws(
    () => packedConsumerStoreDirectory("", "darwin"),
    /home directory/u,
  );
});

test("packed consumer stores ignore the harness's own package store", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-dx-store-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const previous = {
    PNPM_HOME: process.env.PNPM_HOME,
    PNPM_STORE_DIR: process.env.PNPM_STORE_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  // PNPM_HOME is pnpm's first storeDir resolution step and the one the clean
  // room actually sets, so the precondition must be established here rather
  // than inherited from the host.
  process.env.PNPM_HOME = path.join(root, "pass-local", "pnpm-home");
  process.env.PNPM_STORE_DIR = path.join(root, "pass-local", "pnpm-store");
  process.env.XDG_DATA_HOME = path.join(root, "pass-local", "data");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { consumer } = await npmEnvironments(
    root,
    "http://127.0.0.1:4873/",
    [],
  );
  const expected = packedConsumerStoreDirectory(homedir(), process.platform);
  assert.equal(consumer.environment.PNPM_CONFIG_STORE_DIR, expected);
  assert.equal(consumer.runtimeEnvironment.PNPM_CONFIG_STORE_DIR, expected);
  assert.equal(consumer.runtimeEnvironment.npm_config_store_dir, undefined);
  assert.equal(consumer.runtimeEnvironment.XDG_DATA_HOME, undefined);
  assert.equal(consumer.runtimeEnvironment.PNPM_STORE_DIR, undefined);
  assert.equal(consumer.runtimeEnvironment.PNPM_HOME, undefined);

  // Every path the harness publishes is one it owns and removes at teardown.
  // The persistent store is deliberately none of those, so it must never be
  // published as a path: the Pass C evidence verifier asserts each one is
  // absent after cleanup.
  const unmanaged = Object.entries(consumer.paths).filter(
    ([, value]) => value !== root && !value.startsWith(`${root}${path.sep}`),
  );
  assert.deepEqual(
    unmanaged,
    [],
    `consumer paths escape the managed runtime root: ${JSON.stringify(unmanaged)}`,
  );
});

test("packed consumer environments add no configuration npm rejects", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-dx-npmcfg-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  const { consumer } = await npmEnvironments(
    root,
    "http://127.0.0.1:4873/",
    [],
  );
  // The packed harness parses npm's combined output as JSON, so any config
  // key npm does not recognise turns a warning line into a parse failure.
  const { stderr } = await execFileAsync("npm", ["config", "get", "registry"], {
    env: consumer.runtimeEnvironment,
  });
  assert.doesNotMatch(stderr, /Unknown env config/u);
});

test("packed consumer runtimes start beneath a canonical temporary root", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "opencookie-dx-canonical-root-"),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const actualRoot = path.join(root, "actual");
  const aliasedRoot = path.join(root, "alias");
  await mkdir(actualRoot);
  await symlink(
    actualRoot,
    aliasedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  const runtimeRoot = await createCanonicalPackedTemporaryDirectory({
    temporaryRoot: aliasedRoot,
  });

  assert.equal(runtimeRoot, await realpath(runtimeRoot));
  assert.equal(path.dirname(runtimeRoot), await realpath(actualRoot));
});

async function waitForFile(filePath) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function terminateExactGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForPidExit(pid, milliseconds = 1_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

test("DX descendant identity rejects PID reuse but permits reparenting", () => {
  const captured = {
    commandIdentity: "node astro.mjs preview",
    parentPid: 100,
    pid: 200,
    processGroupId: 200,
    startedAt: "Sat Aug 22 12:51:15 2026",
  };
  assert.equal(
    hasSameProcessIdentity(captured, {
      ...captured,
      parentPid: 1,
      processGroupId: 201,
    }),
    true,
  );
  assert.equal(
    hasSameProcessIdentity(captured, {
      ...captured,
      startedAt: "Sat Aug 22 12:51:16 2026",
    }),
    false,
  );
  assert.equal(
    hasSameProcessIdentity(captured, {
      ...captured,
      commandIdentity: "node unrelated.mjs",
    }),
    false,
  );
});

test("DX teardown awaits process-tree signals and surfaces delivery failures", async () => {
  const processTree = [{ pid: 123 }];
  const calls = [];
  let releaseTerm;
  const termDelivered = new Promise((resolve) => {
    releaseTerm = resolve;
  });
  const stopping = stopTrackedProcessTree({
    closed: Promise.resolve(),
    processTree,
    signalTree: async (_snapshot, signal) => {
      calls.push(`${signal}:started`);
      await termDelivered;
      calls.push(`${signal}:finished`);
    },
    terminationGraceMs: 25,
    waitForExit: async () => {
      calls.push("waited");
      return true;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["SIGTERM:started"]);
  releaseTerm();
  await stopping;
  assert.deepEqual(calls, ["SIGTERM:started", "SIGTERM:finished", "waited"]);

  await assert.rejects(
    stopTrackedProcessTree({
      closed: Promise.resolve(),
      processTree,
      signalTree: async () => {
        throw new Error("process inspection failed");
      },
      terminationGraceMs: 25,
      waitForExit: async () => {
        throw new Error("exit polling must not start");
      },
    }),
    /process inspection failed/iu,
  );
});

test("DX cancellation kills the direct child when process inspection fails", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "opencookie-dx-inspection-failure-"),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const pidFile = path.join(root, "child.pid");
  const childProgram = [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const abortController = new AbortController();
  const running = runPackedCommand(process.execPath, ["-e", childProgram], {
    abortSignal: abortController.signal,
    cwd: root,
    env: process.env,
    label: "DX command with unavailable process inspection",
    terminationGraceMs: 50,
  });
  await waitForFile(pidFile);
  const childPid = Number(await readFile(pidFile, "utf8"));
  t.after(() => terminateExactGroup(childPid));
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = path.join(root, "missing-path");
    abortController.abort(new Error("DX inspection failure cancellation."));
    await assert.rejects(running, /ENOENT|inspect|ps/iu);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  assert.throws(
    () => process.kill(childPid, 0),
    /ESRCH/iu,
    "the directly owned child must die even when process inspection fails",
  );
});

test("DX inspection fallback escalates a stubborn same-group descendant", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "opencookie-dx-group-escalation-"),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const leaderPidFile = path.join(root, "leader.pid");
  const descendantPidFile = path.join(root, "descendant.pid");
  const readyFile = path.join(root, "descendant.ready");
  const descendantProgram = [
    'const { writeFileSync } = require("node:fs");',
    "process.on('SIGTERM', () => {});",
    `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const leaderProgram = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(leaderPidFile)}, String(process.pid));`,
    "const descendant = spawn(process.execPath,",
    `["-e", ${JSON.stringify(descendantProgram)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const abortController = new AbortController();
  const running = runPackedCommand(process.execPath, ["-e", leaderProgram], {
    abortSignal: abortController.signal,
    cwd: root,
    env: process.env,
    label: "DX stubborn same-group descendant",
    terminationGraceMs: 50,
  });
  await Promise.all([
    waitForFile(leaderPidFile),
    waitForFile(descendantPidFile),
    waitForFile(readyFile),
  ]);
  const leaderPid = Number(await readFile(leaderPidFile, "utf8"));
  const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
  t.after(() => terminateExactGroup(leaderPid));
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = path.join(root, "missing-path");
    abortController.abort(new Error("DX group escalation cancellation."));
    await assert.rejects(running, /ENOENT|inspect|ps/iu);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  assert.equal(
    await waitForPidExit(descendantPid),
    true,
    "the fallback must KILL a same-group descendant that ignores TERM",
  );
});

/**
 * How long a bounded teardown may take on this machine.
 *
 * The defect this bound catches is an await with no deadline, which never
 * settles at all, so the budget only has to be finite. Teardown performs a
 * bounded number of process inspections, each costing a process spawn, so a
 * busy machine can push a bounded teardown past a fixed deadline. The original
 * 600 ms stays as the floor, and the measured cost of a spawn here can only
 * raise it, never lower it: a slow machine is tolerated, a hanging teardown is
 * still caught.
 */
const BASE_CLOSURE_BUDGET_MS = 600;

/** The measured cost of one process inspection on this machine, now. */
async function inspectionCostMs() {
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await execFileAsync("ps", ["-o", "pid=", "-p", String(process.pid)]).catch(
      () => undefined,
    );
  }
  return Math.max(1, Math.round((Date.now() - started) / 3));
}

function closureBudgetMs(inspection) {
  // Teardown here inspects the tree, tries identity-checked signals, then
  // falls back to the group: up to five grace waits and a few inspections.
  return Math.min(
    10_000,
    Math.max(
      BASE_CLOSURE_BUDGET_MS,
      300 + 5 * terminationGraceMs(inspection) + 8 * inspection,
    ),
  );
}

/**
 * How long teardown waits for a signalled process group to go.
 *
 * A killed process is gone only once this process has reaped it, which a busy
 * machine delays: a fixed 50 ms reported a sound teardown as failed while
 * other suites ran beside this one, and a spawn's cost does not predict the
 * delay. So the floor is 250 ms, the grace grows with the measured cost, and
 * the budget always covers every wait teardown can make. Any finite grace
 * still catches a teardown that never settles.
 */
function terminationGraceMs(inspection) {
  return Math.min(1_000, Math.max(250, 4 * inspection));
}

test("DX cancellation bounds closure when the owned child changes its command identity", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "opencookie-dx-command-identity-change-"),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const pidFile = path.join(root, "child.pid");
  const readyFile = path.join(root, "child.ready");
  const childProgram = [
    'const { writeFileSync } = require("node:fs");',
    "process.on('SIGTERM', () => { process.title = 'opencookie-stubborn-child'; });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const abortController = new AbortController();
  const inspection = await inspectionCostMs();
  const running = runPackedCommand(process.execPath, ["-e", childProgram], {
    abortSignal: abortController.signal,
    cwd: root,
    env: process.env,
    label: "DX mutable command identity cancellation",
    terminationGraceMs: terminationGraceMs(inspection),
  });
  await Promise.all([waitForFile(pidFile), waitForFile(readyFile)]);
  const childPid = Number(await readFile(pidFile, "utf8"));
  t.after(() => terminateExactGroup(childPid));

  const budget = closureBudgetMs(
    Math.max(inspection, await inspectionCostMs()),
  );
  abortController.abort(new Error("DX mutable command identity cancelled."));
  const settled = running.then(
    () => ({ kind: "resolved" }),
    (error) => ({ error, kind: "rejected" }),
  );
  const within = (milliseconds) =>
    Promise.race([
      settled,
      new Promise((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), milliseconds),
      ),
    ]);
  let outcome;
  try {
    outcome = await within(budget);
    // Teardown's own process inspections slow down with machine load. If the
    // load rose after calibrating, measure again and wait once more; a
    // teardown without a deadline still never settles.
    if (outcome.kind === "timeout") {
      outcome = await within(closureBudgetMs(await inspectionCostMs()));
    }
  } finally {
    terminateExactGroup(childPid);
    await running.catch(() => {});
  }

  assert.equal(
    outcome.kind,
    "rejected",
    "owned-child teardown must not await close without a deadline after identity changes",
  );
  assert.match(outcome.error.message, /cancel/iu);
  assert.throws(
    () => process.kill(childPid, 0),
    /ESRCH/iu,
    "the owned process group must be terminated after the command identity changes",
  );
});

test("DX teardown preserves tracked identities after a later inspection failure", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "opencookie-dx-tracker-failure-"),
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const exitFile = path.join(root, "exit-launcher");
  const descendantPidFile = path.join(root, "preview.pid");
  const readyFile = path.join(root, "preview.ready");
  const previewProgram = [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const launcherProgram = [
    'const { existsSync, writeFileSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    "const preview = spawn(process.execPath,",
    `["-e", ${JSON.stringify(previewProgram)}],`,
    '{ detached: true, stdio: "ignore" });',
    "preview.unref();",
    `writeFileSync(${JSON.stringify(descendantPidFile)}, String(preview.pid));`,
    `setInterval(() => { if (existsSync(${JSON.stringify(exitFile)})) process.exit(0); }, 10);`,
  ].join(" ");
  const running = runPackedCommand(process.execPath, ["-e", launcherProgram], {
    cwd: root,
    env: process.env,
    label: "DX tracked descendant after inspection failure",
    terminationGraceMs: 100,
    trackDescendants: true,
  });
  await Promise.all([waitForFile(descendantPidFile), waitForFile(readyFile)]);
  const descendantPid = Number(await readFile(descendantPidFile, "utf8"));
  t.after(() => terminateExactGroup(descendantPid));
  await new Promise((resolve) => setTimeout(resolve, 150));
  // A fixed window let a slow in-flight sample span it under load, so no
  // sample failed at all. This ps fails and says so; the window stays open
  // until a tracker sample has actually failed.
  const failingBin = path.join(root, "failing-bin");
  const failedInspection = path.join(root, "ps.failed");
  await mkdir(failingBin);
  await writeFile(
    path.join(failingBin, "ps"),
    `#!/bin/sh\necho failed > '${failedInspection}'\nexit 1\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = failingBin;
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await access(failedInspection);
        break;
      } catch {
        if (Date.now() > deadline) {
          throw new Error("No tracker sample ran while inspection failed.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  await writeFile(exitFile, "exit");

  await assert.rejects(running, /ENOENT|inspect|ps/iu);
  assert.throws(
    () => process.kill(descendantPid, 0),
    /ESRCH/iu,
    "a known tracked preview must still be cleaned after refresh failure",
  );
});

test("consumer command guards conservatively block exact publication alias tokens", () => {
  for (const alias of [
    "pu",
    "pub",
    "publ",
    "publi",
    "publis",
    "publish",
    "unp",
    "unpu",
    "unpub",
    "unpubl",
    "unpubli",
    "unpublis",
    "unpublish",
  ]) {
    assert.equal(
      isRegistryPublicationInvocation("npm", [alias]),
      true,
      `npm ${alias} must be blocked`,
    );
  }

  for (const [command, args] of [
    ["npm", ["--registry", "https://registry.npmjs.org/", "publis"]],
    ["npm", ["--tag", "latest", "publish", "."]],
    ["npm", ["--fetch-timeout", "60000", "publish"]],
    ["npm", ["view", "publish"]],
    ["/opt/homebrew/bin/npm", ["pub"]],
    ["pnpm", ["--filter", "@opencookie-dev/core", "publish"]],
    ["npx", ["npm", "pub"]],
    ["npx", ["--yes", "npm@11", "publ"]],
    ["npx", ["pnpm", "publish"]],
    ["npx", ["-c", "npm pub"]],
    ["npx", ["--call", "pnpm --registry https://registry.npmjs.org publish"]],
  ]) {
    assert.equal(
      isRegistryPublicationInvocation(command, args),
      true,
      `${command} ${args.join(" ")} must be blocked`,
    );
  }

  for (const [command, args] of [
    ["npm", ["view", "@scope/publish"]],
    ["npm", ["install", "publish@1.0.0"]],
    ["pnpm", ["view", "@scope/publish"]],
    ["npx", ["npm", "view", "publish@1.0.0"]],
    ["npx", ["opencookie", "publish"]],
  ]) {
    assert.equal(
      isRegistryPublicationInvocation(command, args),
      false,
      `${command} ${args.join(" ")} must remain readable`,
    );
  }
});

test("DX cancellation terminates a detached preview descendant", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-dx-teardown-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const descendantFile = path.join(root, "preview.pid");
  const previewProgram = [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(path.join(root, "preview.ready"))}, "ready");`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const launcherProgram = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    "const preview = spawn(process.execPath,",
    `["-e", ${JSON.stringify(previewProgram)}],`,
    '{ detached: true, stdio: "ignore" });',
    "preview.unref();",
    `writeFileSync(${JSON.stringify(descendantFile)}, String(preview.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const abortController = new AbortController();
  const running = runPackedCommand(process.execPath, ["-e", launcherProgram], {
    abortSignal: abortController.signal,
    cwd: root,
    env: process.env,
    label: "detached DX preview",
    terminationGraceMs: 50,
  });
  await waitForFile(descendantFile);
  const descendantPid = Number(await readFile(descendantFile, "utf8"));
  t.after(() => terminateExactGroup(descendantPid));
  await waitForFile(path.join(root, "preview.ready"));

  abortController.abort(new Error("DX preview cancelled."));

  await assert.rejects(running, /cancel/iu);
  assert.throws(
    () => process.kill(descendantPid, 0),
    /ESRCH/iu,
    "the detached preview process group must not outlive its DX controller",
  );
});

test("DX teardown kills a detached descendant whose launcher exits before any sample", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-dx-unsampled-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const descendantFile = path.join(root, "preview.pid");
  // The launcher exits within a millisecond or two of spawning, far inside
  // one tracker sampling interval, so sampling alone cannot see the preview.
  const launcherProgram = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const preview = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"],',
    '{ detached: true, stdio: "ignore" });',
    "preview.unref();",
    `writeFileSync(${JSON.stringify(descendantFile)}, String(preview.pid));`,
    "process.exit(0);",
  ].join(" ");
  const running = runPackedCommand(process.execPath, ["-e", launcherProgram], {
    cwd: root,
    env: process.env,
    label: "DX unsampled detached descendant",
    terminationGraceMs: 100,
    trackDescendants: true,
  });
  await running;
  const descendantPid = Number(await readFile(descendantFile, "utf8"));
  t.after(() => terminateExactGroup(descendantPid));

  assert.throws(
    () => process.kill(descendantPid, 0),
    /ESRCH/iu,
    "a descendant the tracker never sampled must still be killed",
  );
});

for (const exitCode of [0, 7]) {
  test(`DX ${exitCode === 0 ? "success" : "failure"} cleans a reparented preview descendant`, async (t) => {
    const root = await mkdtemp(
      path.join(tmpdir(), `opencookie-dx-reparent-${String(exitCode)}-`),
    );
    t.after(() => rm(root, { force: true, recursive: true }));
    const descendantFile = path.join(root, "preview.pid");
    const previewProgram = "setInterval(() => {}, 1000);";
    const launcherProgram = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "const preview = spawn(process.execPath,",
      `["-e", ${JSON.stringify(previewProgram)}],`,
      '{ detached: true, stdio: "ignore" });',
      "preview.unref();",
      `writeFileSync(${JSON.stringify(descendantFile)}, String(preview.pid));`,
      `setTimeout(() => process.exit(${String(exitCode)}), 150);`,
    ].join(" ");
    const running = runPackedCommand(
      process.execPath,
      ["-e", launcherProgram],
      {
        cwd: root,
        env: process.env,
        label: `reparented DX preview exit ${String(exitCode)}`,
        terminationGraceMs: 100,
        trackDescendants: true,
      },
    );
    await waitForFile(descendantFile);
    const descendantPid = Number(await readFile(descendantFile, "utf8"));
    t.after(() => terminateExactGroup(descendantPid));

    if (exitCode === 0) await running;
    else await assert.rejects(running, /exited with 7/iu);

    assert.throws(
      () => process.kill(descendantPid, 0),
      /ESRCH/iu,
      "the tracked preview must be killed after its launcher is reparented",
    );
  });
}

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

test("DX teardown treats an exited, unreaped group as gone rather than failed", async () => {
  const child = zombieGroupLeader();
  const exited = once(child, "exit");

  // verify:all stopped twice on EPERM from exactly this state.
  assert.doesNotThrow(() => signalProcessTarget(-child.pid, "SIGKILL"));
  assert.equal(isProcessGroupAlive(child.pid), true);

  await exited;
  assert.equal(isProcessGroupAlive(child.pid), false);
});

test("readTarballMember keeps every byte of a packed drop-in", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-dx-member-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const phrase = "Einstellungen schließen über ";
  const unit = Buffer.from(phrase);
  const member = Buffer.alloc(200_000);
  let offset = 0;
  while (offset + unit.length <= member.length) {
    unit.copy(member, offset);
    offset += unit.length;
  }
  member.fill(0x61, offset);
  assert.equal(member.byteLength, 200_000);
  assert.equal(member.subarray(0, unit.length).toString("utf8"), phrase);
  assert.equal(member.subarray(0, 128_000).includes(Buffer.from("ß")), true);
  assert.equal(member.subarray(128_000).includes(Buffer.from("ß")), true);
  assert.equal(member.subarray(0, 128_000).includes(Buffer.from("ü")), true);
  assert.equal(member.subarray(128_000).includes(Buffer.from("ü")), true);

  const memberPath = path.join(root, "package", "dist", "auto.iife.js");
  await mkdir(path.dirname(memberPath), { recursive: true });
  await writeFile(memberPath, member);
  const tarball = path.join(root, "vanilla.tgz");
  await execFileAsync("tar", ["-czf", tarball, "-C", root, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });

  const actual = await readTarballMember(tarball, "package/dist/auto.iife.js", {
    cwd: root,
  });
  assert.equal(actual.byteLength, member.byteLength);
  assert.equal(
    createHash("sha256").update(actual).digest("hex"),
    createHash("sha256").update(member).digest("hex"),
  );
});
