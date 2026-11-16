import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "@playwright/test";

import {
  assertLoopbackRegistryUrl,
  sortPackagesForPublication,
  validateVerdaccioConfiguration,
  withDisposableRegistry,
} from "../verify-packages-lib.mjs";
import {
  discoverPublicPackages,
  parsePackResult,
} from "../verify-packages-workflow.mjs";
import { isRegistryPublicationInvocation } from "./registry-guard.mjs";
import {
  EXPECTED_DEMO_REQUEST_COUNTS,
  RICH_MODULE_REQUEST_PATHS,
  verifyDxLifecycle,
} from "./run-dx-lib.mjs";

export { isRegistryPublicationInvocation };

export const PACKED_CATEGORY_ID = "optional";

const PUBLIC_CDN_ORIGIN = "https://cdn.jsdelivr.net";
// A pinned CDN address names an exact vanilla version. The plain server reads
// it from the page it serves, so it needs no repository files.
const VANILLA_CDN_PATH_PATTERN =
  /https:\/\/cdn\.jsdelivr\.net(?<path>\/npm\/@opencookie-dev\/vanilla@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/dist\/auto\.iife\.js)/u;

function vanillaCdnPath(version) {
  return `/npm/@opencookie-dev/vanilla@${version}/dist/auto.iife.js`;
}
const VANILLA_SELF_HOST_PATH = "/vendor/opencookie/auto.iife.js";
const DEMO_RESOURCE_PATH = "/opencookie-demo.js";
const DEMO_RESOURCE_ID = "opencookie-demo-script";
const CONSENT_STORAGE_KEY = "opencookie.consent";
const RICH_EVIDENCE_PATH = "/opencookie-rich-evidence/";
const RICH_EVIDENCE_DOCUMENT_PATH = `${RICH_EVIDENCE_PATH}index.html`;
const RICH_RESOURCE_PATH = `${RICH_EVIDENCE_PATH}resource.js`;
const RICH_RESOURCE_ID = "opencookie-rich-demo-script";
const RICH_STORAGE_KEY = "opencookie.rich.consent";
const RICH_NESTED_CATEGORY_ID = "advertising";
const RICH_PURPOSE_IDS = Object.freeze([
  "ads",
  "analytics",
  "profile",
  "recommendations",
]);
const TREE_IGNORES = new Set([".git", "node_modules"]);

export const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org/";

export function pinPnpmCachePreference(environment, packageManager) {
  if (packageManager !== "pnpm") return { ...environment };
  return {
    ...environment,
    PNPM_CONFIG_PREFER_OFFLINE: "true",
  };
}

/**
 * Environment variables that identify the operator as an AI coding agent.
 *
 * Modern framework CLIs branch on these. Astro 7.2 asks `am-i-vibing`
 * whether an agent is driving it and, when the answer is yes, silently
 * turns `astro preview` into a detached background daemon that reports
 * JSON. A packed DX consumer must behave the way it behaves for a
 * developer, so the harness must not hand it this session's identity.
 *
 * Compound detectors also key on pager preferences, which no
 * non-interactive consumer build needs. Detectors that inspect process
 * ancestry rather than the environment cannot be answered from here.
 */
export const AGENT_IDENTITY_ENVIRONMENT_KEYS = Object.freeze([
  "AGENT",
  "AIDER_API_KEY",
  "AI_AGENT",
  "AMP_CURRENT_THREAD_ID",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_PROJECT_ID",
  "AUGMENT_AGENT",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEIUM_EDITOR_APP_ROOT",
  "CODEX_THREAD_ID",
  "CRUSH",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "GIT_PAGER",
  "OPENCODE",
  "OPENCODE_APP_INFO",
  "OPENCODE_BIN_PATH",
  "OPENCODE_MODES",
  "OPENCODE_SERVER",
  "PAGER",
  "PI_CODING_AGENT",
  "QWEN_CODE",
  "REPLIT_MODE",
  "REPL_ID",
]);

const AGENT_IDENTITY_ENVIRONMENT_KEY_SET = new Set(
  AGENT_IDENTITY_ENVIRONMENT_KEYS,
);

export function neutralizeAgentEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !AGENT_IDENTITY_ENVIRONMENT_KEY_SET.has(key),
    ),
  );
}

/**
 * The package store a brand-new consumer app installs into.
 *
 * Pass A points XDG_DATA_HOME and PNPM_STORE_DIR at a pass-local
 * directory so the repository's own frozen install proves it resolves
 * from the lockfile alone. Consumer apps are not that install: they are
 * the developer's brand-new project, and the DX lifecycle budget is
 * calibrated against the store a developer already has. Inheriting the
 * harness's pass-local store makes every clean-room pass re-download
 * every consumer dependency, which measures registry bandwidth instead
 * of the product.
 *
 * pnpm resolves storeDir as $PNPM_HOME/store, then
 * $XDG_DATA_HOME/pnpm/store, then a platform default, so the harness's
 * own PNPM_HOME and XDG_DATA_HOME silently capture the consumer's
 * store. Mirroring the documented platform default keeps a brand-new
 * app on exactly the store it would use for a developer, inside Pass A
 * and outside it alike. See https://pnpm.io/settings/store.
 *
 * The pin uses PNPM_CONFIG_STORE_DIR rather than the npm-style spelling:
 * pnpm ignores `npm_config_store_dir`, and npm warns about it on stderr,
 * which the harness merges into the stdout it parses as JSON.
 *
 * Reuse is safe because the store is content-addressed: pnpm keys every
 * blob by its integrity hash and re-verifies on read, so a store hit is
 * byte-identical to a fresh fetch and a changed tarball cannot be served
 * from it.
 *
 * The store is not a path the harness owns: it is not published on the
 * descriptor, it is not created here, and it is never removed at
 * teardown. pnpm creates it on first use, exactly as it does for a
 * developer.
 *
 * Registry metadata is a separate cache under XDG_CACHE_HOME. Pass A
 * pins that pass-local; elsewhere the consumer inherits the operator's.
 * That does not let a stale `@opencookie-dev/*` tarball through, because
 * each run publishes to a fresh loopback registry on a new port and the
 * consumer npmrc points `@opencookie-dev` at that origin, but it is worth
 * knowing that metadata isolation is a property of Pass A rather than
 * of this boundary.
 */
export function packedConsumerStoreDirectory(homeDirectory, platform) {
  if (typeof homeDirectory !== "string" || homeDirectory.length === 0) {
    throw new Error(
      "Packed DX consumers require a resolvable home directory for their store.",
    );
  }
  if (platform === "win32") {
    return path.join(homeDirectory, "AppData", "Local", "pnpm", "store");
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "pnpm", "store");
  }
  return path.join(homeDirectory, ".local", "share", "pnpm", "store");
}

export function createConsumerProcessEnvironment(environment, packageManager) {
  return neutralizeAgentEnvironment(
    pinPnpmCachePreference(environment, packageManager),
  );
}

export function normalizeConsumerRegistryEnvironment(environment, registry) {
  return {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) => !/^(?:npm|pnpm)_config_registry$/iu.test(key),
      ),
    ),
    NPM_CONFIG_REGISTRY: registry,
  };
}

export const PASS_C_CANDIDATE_INSTALL_ARGS = Object.freeze([
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
]);

export async function createCanonicalPackedTemporaryDirectory({
  temporaryRoot = tmpdir(),
} = {}) {
  const canonicalTemporaryRoot = await realpath(temporaryRoot);
  const createdDirectory = await mkdtemp(
    path.join(canonicalTemporaryRoot, "opencookie-packed-dx-"),
  );
  try {
    return await realpath(createdDirectory);
  } catch (error) {
    await rm(createdDirectory, { force: true, recursive: true }).catch(
      () => {},
    );
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Signals a process or, given a negative pid, its whole group.
 *
 * ESRCH means it is already gone. For a group, macOS answers EPERM when no
 * member could be signalled, which for this harness's own processes means
 * every member has exited and waits to be reaped; a live member is still
 * signalled normally. Nothing is left to stop, so the bounded exit wait, not
 * this call, decides whether teardown succeeded.
 */
export function signalProcessTarget(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    if (pid < 0 && error?.code === "EPERM") return;
    throw error;
  }
}

async function readProcessTable() {
  if (process.platform === "win32") return [];
  const child = spawn("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`Unable to inspect the DX process tree.\n${stderr}`.trim());
  }
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.trim().split(/\s+/u);
      return {
        commandIdentity: fields.slice(8).join(" "),
        parentPid: Number(fields[1]),
        pid: Number(fields[0]),
        processGroupId: Number(fields[2]),
        startedAt: fields.slice(3, 8).join(" "),
      };
    })
    .filter(
      ({ commandIdentity, parentPid, pid, processGroupId, startedAt }) =>
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        Number.isSafeInteger(parentPid) &&
        parentPid >= 0 &&
        Number.isSafeInteger(processGroupId) &&
        processGroupId > 0 &&
        startedAt.length > 0 &&
        commandIdentity.length > 0,
    );
}

async function snapshotProcessTree(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) return [];
  if (process.platform === "win32") {
    return [];
  }
  const processTable = await readProcessTable();
  const childrenByParent = new Map();
  for (const record of processTable) {
    const children = childrenByParent.get(record.parentPid) ?? [];
    children.push(record);
    childrenByParent.set(record.parentPid, children);
  }
  const recordsByPid = new Map(
    processTable.map((record) => [record.pid, record]),
  );
  if (!recordsByPid.has(rootPid)) {
    return processTable.filter(
      ({ processGroupId }) => processGroupId === rootPid,
    );
  }
  const snapshot = new Map();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (snapshot.has(pid)) continue;
    const record = recordsByPid.get(pid);
    if (record !== undefined) snapshot.set(pid, record);
    for (const child of childrenByParent.get(pid) ?? []) {
      pending.push(child.pid);
    }
  }
  return [...snapshot.values()];
}

// Polling ps misses a detached descendant whose launcher exits between two
// samples, so a tracked child also carries this per-run token, which every
// descendant inherits and teardown looks for.
const DX_OWNER_VARIABLE = "OPENCOOKIE_DX_OWNER";

async function readLaunchEnvironments() {
  if (process.platform === "linux") {
    const environments = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const environ = await readFile(`/proc/${entry}/environ`);
        environments.push({
          pid: Number(entry),
          variables: environ.toString("utf8").split("\0"),
        });
      } catch {
        // The process exited or belongs to another user; neither is ours.
      }
    }
    return environments;
  }
  if (process.platform !== "darwin") return [];
  // macOS ps -E appends each process's launch environment to its command.
  const child = spawn("ps", ["-axE", "-o", "pid=,command="], {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error("Unable to inspect DX process environments.");
  }
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ...rest] = line.trim().split(/\s+/u);
      return { pid: Number(pid), variables: rest };
    });
}

async function markedProcessRecords(ownerToken) {
  const marker = `${DX_OWNER_VARIABLE}=${ownerToken}`;
  const markedPids = new Set(
    (await readLaunchEnvironments())
      .filter(({ variables }) => variables.includes(marker))
      .map(({ pid }) => pid),
  );
  if (markedPids.size === 0) return [];
  return (await readProcessTable()).filter(({ pid }) => markedPids.has(pid));
}

export function hasSameProcessIdentity(left, right) {
  return (
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.commandIdentity === right.commandIdentity
  );
}

async function matchingProcessRecords(snapshot) {
  const currentByPid = new Map(
    (await readProcessTable()).map((record) => [record.pid, record]),
  );
  return snapshot.filter((record) => {
    const current = currentByPid.get(record.pid);
    return current !== undefined && hasSameProcessIdentity(record, current);
  });
}

async function signalProcessTree(snapshot, signal) {
  for (const { pid } of await matchingProcessRecords(snapshot)) {
    signalProcessTarget(pid, signal);
  }
}

async function waitForProcessTreeExit(snapshot, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if ((await matchingProcessRecords(snapshot)).length === 0) return true;
    await delay(25);
  }
  return (await matchingProcessRecords(snapshot)).length === 0;
}

export async function stopTrackedProcessTree({
  closed,
  processTree,
  terminationGraceMs,
  signalTree = signalProcessTree,
  waitForExit = waitForProcessTreeExit,
}) {
  await signalTree(processTree, "SIGTERM");
  if (await waitForExit(processTree, terminationGraceMs)) {
    if (!(await waitForChildClose(closed, terminationGraceMs))) {
      throw new DirectChildClosurePendingError();
    }
    return;
  }
  await signalTree(processTree, "SIGKILL");
  const [childClosed, exited] = await Promise.all([
    waitForChildClose(closed, terminationGraceMs),
    waitForExit(processTree, terminationGraceMs),
  ]);
  if (!exited) {
    throw new Error("DX process tree survived bounded SIGKILL teardown.");
  }
  if (!childClosed) {
    throw new DirectChildClosurePendingError();
  }
}

function createProcessTreeTracker(rootPid) {
  const tracked = new Map();
  let disposed = false;
  let failure;
  let refreshing;
  const refresh = () => {
    if (disposed) return Promise.resolve();
    if (refreshing !== undefined) return refreshing;
    refreshing = (async () => {
      if (disposed) return;
      for (const record of await snapshotProcessTree(rootPid)) {
        tracked.set(record.pid, record);
      }
    })()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  void refresh();
  const interval = setInterval(() => void refresh(), 50);
  interval.unref();
  const lifetime = setTimeout(() => {
    failure = new Error(
      "DX descendant tracking exceeded its bounded lifetime.",
    );
    disposed = true;
    clearInterval(interval);
  }, 300_000);
  lifetime.unref();
  return {
    dispose() {
      disposed = true;
      clearInterval(interval);
      clearTimeout(lifetime);
    },
    async snapshot() {
      await refresh();
      return {
        error: failure,
        records: [...tracked.values()],
      };
    },
  };
}

function mergeProcessTrees(...snapshots) {
  return [
    ...new Map(snapshots.flat().map((record) => [record.pid, record])).values(),
  ];
}

async function stopWindowsChildOnly(child, closed, terminationGraceMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!(await waitForChildClose(closed, terminationGraceMs))) {
      throw new Error("Direct DX child did not report bounded closure.");
    }
    return;
  }
  child.kill("SIGTERM");
  if (
    await Promise.race([
      closed.then(() => true),
      delay(terminationGraceMs).then(() => false),
    ])
  ) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForChildClose(closed, terminationGraceMs))) {
    throw new Error("Direct DX child survived bounded SIGKILL teardown.");
  }
}

async function waitForChildClose(closed, terminationGraceMs) {
  return Promise.race([
    closed.then(() => true),
    delay(terminationGraceMs).then(() => false),
  ]);
}

class DirectChildClosurePendingError extends Error {
  constructor() {
    super("Direct DX child did not report bounded closure.");
    this.name = "DirectChildClosurePendingError";
  }
}

/** Whether a process group still exists. An unreaped group answers EPERM. */
export function isProcessGroupAlive(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(processGroupId)) return true;
    await delay(25);
  }
  return !isProcessGroupAlive(processGroupId);
}

async function stopPosixDirectProcessGroup(child, closed, terminationGraceMs) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    if (!(await waitForChildClose(closed, terminationGraceMs))) {
      throw new Error("Direct DX child did not report bounded closure.");
    }
    return;
  }
  const errors = [];
  let groupAlive = true;
  try {
    groupAlive = isProcessGroupAlive(child.pid);
  } catch (error) {
    errors.push(error);
  }
  if (groupAlive) {
    try {
      signalProcessTarget(-child.pid, "SIGTERM");
    } catch (error) {
      errors.push(error);
    }
    let groupExited = false;
    try {
      groupExited = await waitForProcessGroupExit(
        child.pid,
        terminationGraceMs,
      );
    } catch (error) {
      errors.push(error);
    }
    if (!groupExited) {
      try {
        signalProcessTarget(-child.pid, "SIGKILL");
      } catch (error) {
        errors.push(error);
      }
      try {
        groupExited = await waitForProcessGroupExit(
          child.pid,
          terminationGraceMs,
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (!groupExited) {
      errors.push(
        new Error("Direct DX process group survived bounded teardown."),
      );
    }
  }
  if (!(await waitForChildClose(closed, terminationGraceMs))) {
    errors.push(new Error("Direct DX child did not report bounded closure."));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Direct DX child teardown failed.");
  }
}

function throwCleanupErrors(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "DX process inspection and teardown encountered multiple failures.",
    );
  }
}

function captureChild(child, { ownerToken, trackDescendants = false } = {}) {
  let output = "";
  let spawnError;
  const processTreeTracker =
    trackDescendants && child.pid !== undefined
      ? createProcessTreeTracker(child.pid)
      : undefined;
  const append = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-128_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise((resolve) =>
    child.once("close", (exitCode, signalName) =>
      resolve({ exitCode, signalName }),
    ),
  );
  return {
    child,
    closed,
    get output() {
      return output;
    },
    get spawnError() {
      return spawnError;
    },
    async stop(terminationGraceMs = 2_000) {
      const cleanupErrors = [];
      try {
        if (process.platform === "win32") {
          await stopWindowsChildOnly(child, closed, terminationGraceMs);
          return;
        }
        let processTree = [];
        const inspectionResults = await Promise.allSettled([
          snapshotProcessTree(child.pid),
          processTreeTracker?.snapshot() ??
            Promise.resolve({ error: undefined, records: [] }),
          ownerToken === undefined
            ? Promise.resolve([])
            : markedProcessRecords(ownerToken),
        ]);
        const snapshots = [];
        const [currentInspection, trackedInspection, markedInspection] =
          inspectionResults;
        if (markedInspection.status === "fulfilled") {
          snapshots.push(markedInspection.value);
        } else {
          cleanupErrors.push(markedInspection.reason);
        }
        if (currentInspection.status === "fulfilled") {
          snapshots.push(currentInspection.value);
        } else {
          cleanupErrors.push(currentInspection.reason);
        }
        if (trackedInspection.status === "fulfilled") {
          snapshots.push(trackedInspection.value.records);
          if (trackedInspection.value.error !== undefined) {
            cleanupErrors.push(trackedInspection.value.error);
          }
        } else {
          cleanupErrors.push(trackedInspection.reason);
        }
        processTree = mergeProcessTrees(...snapshots);
        let identityCheckedTeardownSucceeded = false;
        let directGroupFallbackRequired = false;
        if (processTree.length > 0) {
          try {
            await stopTrackedProcessTree({
              closed,
              processTree,
              terminationGraceMs,
            });
            identityCheckedTeardownSucceeded = true;
          } catch (error) {
            if (error instanceof DirectChildClosurePendingError) {
              directGroupFallbackRequired = true;
            } else {
              cleanupErrors.push(error);
            }
          }
        }
        const directChildMayBeActive =
          child.exitCode === null && child.signalCode === null;
        if (
          directGroupFallbackRequired ||
          (!identityCheckedTeardownSucceeded &&
            (cleanupErrors.length > 0 || directChildMayBeActive))
        ) {
          try {
            await stopPosixDirectProcessGroup(
              child,
              closed,
              terminationGraceMs,
            );
          } catch (error) {
            cleanupErrors.push(error);
          }
        } else if (!identityCheckedTeardownSucceeded) {
          if (!(await waitForChildClose(closed, terminationGraceMs))) {
            cleanupErrors.push(
              new Error("Direct DX child did not report bounded closure."),
            );
          }
        }
        throwCleanupErrors(cleanupErrors);
      } finally {
        processTreeTracker?.dispose();
      }
    },
  };
}

function startChild(command, args, { cwd, env, trackDescendants = false }) {
  const ownerToken =
    trackDescendants && process.platform !== "win32"
      ? randomBytes(16).toString("hex")
      : undefined;
  return captureChild(
    spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env:
        ownerToken === undefined
          ? env
          : { ...env, [DX_OWNER_VARIABLE]: ownerToken },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    { ownerToken, trackDescendants },
  );
}

function cancellationError(abortSignal, label) {
  if (abortSignal?.reason instanceof Error) return abortSignal.reason;
  return new Error(`${label} was cancelled.`);
}

function throwIfAborted(abortSignal, label) {
  if (abortSignal?.aborted === true) {
    throw cancellationError(abortSignal, label);
  }
}

export async function runPackedCommand(
  command,
  args,
  {
    abortSignal,
    cwd,
    deadline,
    env = process.env,
    label = command,
    terminationGraceMs = 2_000,
    trackDescendants = false,
  },
) {
  throwIfAborted(abortSignal, label);
  const controller = startChild(command, args, {
    cwd,
    env,
    trackDescendants,
  });
  const remaining = deadline === undefined ? 600_000 : deadline - Date.now();
  if (remaining <= 0) {
    await controller.stop(terminationGraceMs);
    throw new Error(`${label} had no remaining DX budget.`);
  }
  let abortHandler;
  let timeout;
  const interrupted = new Promise((resolve) => {
    abortHandler = () => resolve({ kind: "aborted" });
    abortSignal?.addEventListener("abort", abortHandler, { once: true });
    timeout = setTimeout(() => resolve({ kind: "timeout" }), remaining);
    if (abortSignal?.aborted === true) abortHandler();
  });
  try {
    const outcome = await Promise.race([
      controller.closed.then((result) => ({ kind: "closed", result })),
      interrupted,
    ]);
    if (outcome.kind === "aborted") {
      await controller.stop(terminationGraceMs);
      throw cancellationError(abortSignal, label);
    }
    if (outcome.kind === "timeout") {
      await controller.stop(terminationGraceMs);
      throw new Error(`${label} exceeded its command deadline.`);
    }
    if (trackDescendants) {
      await controller.stop(terminationGraceMs);
    }
    if (controller.spawnError !== undefined) {
      throw new Error(`${label} could not start.`, {
        cause: controller.spawnError,
      });
    }
    if (outcome.result.exitCode !== 0) {
      throw new Error(
        `${label} exited with ${String(outcome.result.exitCode)} signal ${String(
          outcome.result.signalName,
        )}.\n${controller.output}`.trim(),
      );
    }
    return controller.output;
  } finally {
    clearTimeout(timeout);
    if (abortHandler !== undefined) {
      abortSignal?.removeEventListener("abort", abortHandler);
    }
  }
}

const runCommand = runPackedCommand;

export async function materializeCandidateCheckout({
  abortSignal,
  candidate,
  repositoryRoot,
  runtimeRoot,
}) {
  if (!/^[a-f0-9]{40}$/u.test(candidate ?? "")) {
    throw new Error("Packed consumer candidate must be a full commit SHA.");
  }
  const checkoutRoot = path.join(runtimeRoot, "candidate-checkout");
  await runCommand(
    "git",
    [
      "clone",
      "--no-hardlinks",
      "--no-local",
      "--no-checkout",
      "--",
      path.resolve(repositoryRoot),
      checkoutRoot,
    ],
    {
      abortSignal,
      cwd: runtimeRoot,
      label: "clone immutable Pass C candidate",
    },
  );
  await runCommand("git", ["checkout", "--detach", candidate], {
    abortSignal,
    cwd: checkoutRoot,
    label: "checkout exact Pass C candidate",
  });
  await runCommand("git", ["remote", "remove", "origin"], {
    abortSignal,
    cwd: checkoutRoot,
    label: "remove Pass C candidate origin",
  });
  const [head, status, remotes] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], {
      abortSignal,
      cwd: checkoutRoot,
      label: "verify Pass C candidate HEAD",
    }),
    runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      abortSignal,
      cwd: checkoutRoot,
      label: "verify Pass C candidate status",
    }),
    runCommand("git", ["remote"], {
      abortSignal,
      cwd: checkoutRoot,
      label: "verify Pass C candidate remotes",
    }),
  ]);
  if (
    head.trim() !== candidate ||
    status.trim() !== "" ||
    remotes.trim() !== ""
  ) {
    throw new Error(
      "Pass C candidate checkout must be exact, clean, detached, and remote-free.",
    );
  }
  try {
    await access(
      path.join(checkoutRoot, ".git", "objects", "info", "alternates"),
    );
    throw new Error("Pass C candidate clone must not borrow source objects.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { candidate, checkoutRoot };
}

async function reserveLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  if (port === 0) throw new Error("Unable to reserve a loopback DX port.");
  return port;
}

async function waitForUrl(url, controller, deadline, abortSignal) {
  while (Date.now() < deadline) {
    throwIfAborted(abortSignal, `wait for ${String(url)}`);
    if (controller?.spawnError !== undefined) {
      throw new Error("DX server failed to start.", {
        cause: controller.spawnError,
      });
    }
    if (
      controller !== undefined &&
      (controller.child.exitCode !== null ||
        controller.child.signalCode !== null)
    ) {
      throw new Error(
        `DX server exited before readiness.\n${controller.output}`,
      );
    }
    try {
      const timeoutSignal = AbortSignal.timeout(1_000);
      const signal =
        abortSignal === undefined
          ? timeoutSignal
          : AbortSignal.any([abortSignal, timeoutSignal]);
      const response = await fetch(url, { signal });
      if (response.ok) return;
    } catch (error) {
      if (abortSignal?.aborted === true) throw error;
      // The real production server is still starting.
    }
    await delay(100);
  }
  throw new Error(
    `DX server was not ready before its deadline: ${String(url)}`,
  );
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export async function readVerifiedVanillaBytes({
  expectedSha256,
  vanillaPath,
  vanillaScript,
}) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")) {
    throw new Error("Packed vanilla integrity requires an exact SHA-256 hash.");
  }
  if ((vanillaPath === undefined) === (vanillaScript === undefined)) {
    throw new Error("Provide exactly one packed vanilla source or path.");
  }
  const bytes =
    vanillaPath === undefined
      ? Buffer.from(vanillaScript)
      : await readFile(vanillaPath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Packed vanilla integrity hash mismatch: expected ${expectedSha256}, received ${actualSha256}.`,
    );
  }
  return bytes;
}

async function readPlainRichEvidenceAssets(projectRoot) {
  const relativeAssets = [
    "harness.js",
    "index.html",
    "packages/core-domain.js",
    "packages/core-infrastructure.js",
    "packages/core.js",
    "packages/vanilla.js",
    "resource.js",
  ];
  const evidenceRoot = path.join(projectRoot, RICH_EVIDENCE_PATH.slice(1));
  try {
    await access(path.join(evidenceRoot, "index.html"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  return new Map(
    await Promise.all(
      relativeAssets.map(async (relative) => [
        `${RICH_EVIDENCE_PATH}${relative}`,
        await readFile(path.join(evidenceRoot, relative)),
      ]),
    ),
  );
}

export async function startPackedPlainServer({
  expectedSha256,
  port,
  projectRoot,
  vanillaPath,
  vanillaScript,
}) {
  const exactVanillaBytes = await readVerifiedVanillaBytes({
    expectedSha256,
    vanillaPath,
    vanillaScript,
  });
  const exactPort = port ?? (await reserveLoopbackPort());
  const source = await readFile(path.join(projectRoot, "index.html"), "utf8");
  const cdnPath = VANILLA_CDN_PATH_PATTERN.exec(source)?.groups?.["path"];
  const usesPublicCdn = cdnPath !== undefined;
  const usesSelfHostedVanilla = source.includes(VANILLA_SELF_HOST_PATH);
  if (usesPublicCdn === usesSelfHostedVanilla) {
    throw new Error(
      "Plain DX source must use exactly one packed vanilla transport.",
    );
  }
  if (usesSelfHostedVanilla) {
    const generatedVanillaBytes = await readVerifiedVanillaBytes({
      expectedSha256,
      vanillaPath: path.join(projectRoot, VANILLA_SELF_HOST_PATH.slice(1)),
    });
    if (!generatedVanillaBytes.equals(exactVanillaBytes)) {
      throw new Error(
        "Plain DX self-hosted vanilla bytes differ from the packed artifact.",
      );
    }
  }
  const referencesDemoResource = source.includes(DEMO_RESOURCE_PATH);
  const demoBytes = referencesDemoResource
    ? await readFile(path.join(projectRoot, DEMO_RESOURCE_PATH.slice(1)))
    : undefined;
  const richEvidenceAssets = await readPlainRichEvidenceAssets(projectRoot);
  const servedHtml = usesPublicCdn
    ? source.replaceAll(
        PUBLIC_CDN_ORIGIN,
        `http://127.0.0.1:${String(exactPort)}`,
      )
    : source;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://127.0.0.1:${String(exactPort)}`,
    );
    if (requestUrl.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(servedHtml);
      return;
    }
    if (
      (usesPublicCdn && requestUrl.pathname === cdnPath) ||
      (usesSelfHostedVanilla && requestUrl.pathname === VANILLA_SELF_HOST_PATH)
    ) {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(exactVanillaBytes);
      return;
    }
    if (requestUrl.pathname === DEMO_RESOURCE_PATH && demoBytes !== undefined) {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(demoBytes);
      return;
    }
    const richEvidenceBytes = richEvidenceAssets.get(requestUrl.pathname);
    if (richEvidenceBytes !== undefined) {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": requestUrl.pathname.endsWith(".html")
          ? "text/html; charset=utf-8"
          : "text/javascript; charset=utf-8",
      });
      response.end(richEvidenceBytes);
      return;
    }
    response.writeHead(404).end("Not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(exactPort, "127.0.0.1", resolve);
  });
  return {
    stop: () => closeHttpServer(server),
    url: `http://127.0.0.1:${String(exactPort)}/`,
  };
}

function replacePort(args, port) {
  return args.map((argument) =>
    argument === "{port}" ? String(port) : argument,
  );
}

function startFrameworkServer(definition, projectRoot, env, port) {
  const serverEnvironment = {
    ...env,
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    PORT: String(port),
  };
  return startChild(
    definition.serve.command,
    replacePort(definition.serve.args, port),
    { cwd: projectRoot, env: serverEnvironment, trackDescendants: true },
  );
}

export function remainingBrowserTimeout(deadline, now = Date.now) {
  const remaining = deadline - now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error("DX browser proof exhausted the absolute case budget.");
  }
  return Math.max(1, Math.floor(remaining));
}

export function isSameSchemefulWebSocketOrigin(webSocketUrl, applicationUrl) {
  const socket = new URL(webSocketUrl);
  const application = new URL(applicationUrl);
  const applicationProtocol =
    socket.protocol === "ws:"
      ? "http:"
      : socket.protocol === "wss:"
        ? "https:"
        : undefined;
  if (applicationProtocol === undefined) return false;
  const socketApplicationOrigin = new URL(
    `${applicationProtocol}//${socket.host}`,
  ).origin;
  return socketApplicationOrigin === application.origin;
}

function browserTimeout(deadline) {
  return { timeout: remainingBrowserTimeout(deadline) };
}

export async function evaluateGeneratedPanel(
  locator,
  pageFunction,
  deadline,
  now = Date.now,
) {
  return locator.evaluate(pageFunction, undefined, {
    timeout: remainingBrowserTimeout(deadline, now),
  });
}

function assertDemoRequestCount(demoRequests, expected, label) {
  if (demoRequests.length !== expected) {
    throw new Error(
      `${label} expected ${String(expected)} cumulative demo requests but observed ${String(demoRequests.length)}.`,
    );
  }
}

async function waitForDurableConsentRecord(
  page,
  { decision, method },
  deadline,
) {
  const handle = await page.waitForFunction(
    ({ decision: expectedDecision, method: expectedMethod, storageKey }) => {
      const raw = globalThis.localStorage.getItem(storageKey);
      if (raw === null) return false;
      try {
        const envelope = JSON.parse(raw);
        if (
          envelope === null ||
          typeof envelope !== "object" ||
          Array.isArray(envelope) ||
          Object.hasOwn(envelope, "pendingGrant")
        ) {
          return false;
        }
        const record = envelope.record;
        if (
          record === null ||
          typeof record !== "object" ||
          Array.isArray(record) ||
          record.method !== expectedMethod
        ) {
          return false;
        }
        if (
          expectedDecision !== undefined &&
          (record.decisions === null ||
            typeof record.decisions !== "object" ||
            record.decisions.analytics !== expectedDecision)
        ) {
          return false;
        }
        if (
          expectedMethod === "withdrawal" &&
          !Number.isSafeInteger(record.withdrawnAt)
        ) {
          return false;
        }
        return raw;
      } catch {
        return false;
      }
    },
    {
      decision,
      method,
      storageKey: CONSENT_STORAGE_KEY,
    },
    browserTimeout(deadline),
  );
  try {
    const raw = await handle.jsonValue();
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`DX ${method} record was not durably persisted.`);
    }
    return raw;
  } finally {
    await handle.dispose();
  }
}

async function waitForStartedDemoResource(page, deadline) {
  await page.waitForFunction(
    ({ resourceId }) => {
      const active = globalThis.document.querySelector(
        `script[data-oc-active-resource="${resourceId}"]`,
      );
      return globalThis.__openCookieDemoRuns === 1 && active !== null;
    },
    { resourceId: DEMO_RESOURCE_ID },
    browserTimeout(deadline),
  );
}

async function waitForBlockedDemoResourceAndLauncher(page, deadline) {
  await page.waitForFunction(
    ({ resourceId, resourcePath }) => {
      const sources = Array.from(
        globalThis.document.querySelectorAll(
          `script[data-oc-resource="${resourceId}"]`,
        ),
      );
      const active = globalThis.document.querySelector(
        `script[data-oc-active-resource="${resourceId}"]`,
      );
      return (
        sources.length > 0 &&
        sources.every(
          (source) =>
            source.type === "text/plain" && source.dataset.src === resourcePath,
        ) &&
        active === null
      );
    },
    { resourceId: DEMO_RESOURCE_ID, resourcePath: DEMO_RESOURCE_PATH },
    browserTimeout(deadline),
  );
  await page
    .getByRole("button", { name: "Privacy choices", exact: true })
    .waitFor({ state: "visible", ...browserTimeout(deadline) });
  return Object.freeze({ launcherRendered: true, resourceBlocked: true });
}

async function waitForClosedPanel(page, deadline) {
  await page.waitForFunction(
    () => {
      const panel = globalThis.document.querySelector("dialog.oc-panel");
      return panel !== null && !panel.open;
    },
    undefined,
    browserTimeout(deadline),
  );
}

export function classifyGeneratedFocusTarget(target) {
  if (target === null) return null;
  if (target.isHostControl) return "host-control";
  if (target.isTitle) return "title";
  if (target.action !== null) {
    return target.action === "open" ? "privacy-choices" : target.action;
  }
  if (target.inputName !== null) {
    return `${target.inputName}:${target.inputValue}`;
  }
  return target.tagName;
}

async function activeGeneratedElement(page) {
  const target = await page.evaluate(() => {
    const active = globalThis.document.activeElement;
    if (!(active instanceof globalThis.HTMLElement)) return null;
    const input = active instanceof globalThis.HTMLInputElement ? active : null;
    return {
      action: active.dataset["ocAction"] ?? null,
      inputName: input?.name ?? null,
      inputValue: input?.value ?? null,
      isHostControl:
        active !== globalThis.document.body &&
        active !== globalThis.document.documentElement &&
        active.closest(".oc-root") === null,
      isTitle: active.classList.contains("oc-title"),
      tagName: active.tagName.toLowerCase(),
    };
  });
  return classifyGeneratedFocusTarget(target);
}

async function observeGeneratedStarterState(page, demoRequests, deadline) {
  const handle = await page.waitForFunction(
    ({ resourceId, storageKey }) => {
      const sources = [
        ...globalThis.document.querySelectorAll(
          `script[data-oc-resource="${resourceId}"]`,
        ),
      ];
      const activeResources = globalThis.document.querySelectorAll(
        `script[data-oc-active-resource="${resourceId}"]`,
      );
      if (sources.length !== 1 || activeResources.length !== 0) return false;
      const raw = globalThis.localStorage.getItem(storageKey);
      let persistedDecision = null;
      let persistedMethod = null;
      if (raw !== null) {
        try {
          const envelope = JSON.parse(raw);
          persistedDecision = envelope?.record?.decisions?.analytics ?? null;
          persistedMethod = envelope?.record?.method ?? null;
        } catch {
          return false;
        }
      }
      return {
        activeResourceCount: activeResources.length,
        inertResourceSourceCount: sources.filter(
          (source) => source.type === "text/plain",
        ).length,
        launcherRendered:
          globalThis.document.querySelector('[data-oc-action="open"]') !== null,
        persistedDecision,
        persistedMethod,
        persistedRecordPresent: raw !== null,
        resourceExecutions:
          typeof globalThis.__openCookieDemoRuns === "number"
            ? globalThis.__openCookieDemoRuns
            : 0,
      };
    },
    { resourceId: DEMO_RESOURCE_ID, storageKey: CONSENT_STORAGE_KEY },
    browserTimeout(deadline),
  );
  try {
    const observation = await handle.jsonValue();
    if (
      observation === null ||
      typeof observation !== "object" ||
      Array.isArray(observation)
    ) {
      throw new Error("DX generated starter state could not be observed.");
    }
    return {
      ...observation,
      resourceRequests: demoRequests.length,
    };
  } finally {
    await handle.dispose();
  }
}

async function generatedDialogState(page) {
  return page.evaluate(() => {
    const dialog = globalThis.document.querySelector("dialog.oc-panel");
    const active = globalThis.document.activeElement;
    const opener = globalThis.__openCookieDxOpener;
    const openerAction =
      opener instanceof globalThis.HTMLElement
        ? opener.dataset["ocAction"]
        : undefined;
    return {
      activeElement: active?.classList.contains("oc-title") ? "title" : null,
      dialogOpen: dialog instanceof globalThis.HTMLDialogElement && dialog.open,
      modal: dialog?.matches(":modal") ?? false,
      opener:
        openerAction === "open" ? "privacy-choices" : (openerAction ?? null),
    };
  });
}

async function generatedClosedDialogState(page) {
  return page.evaluate(() => {
    const dialog = globalThis.document.querySelector("dialog.oc-panel");
    const active = globalThis.document.activeElement;
    const opener = globalThis.__openCookieDxOpener;
    const action =
      active instanceof globalThis.HTMLElement
        ? active.dataset["ocAction"]
        : undefined;
    return {
      activeElement: action === "open" ? "privacy-choices" : (action ?? null),
      dialogOpen: dialog instanceof globalThis.HTMLDialogElement && dialog.open,
      modal: dialog?.matches(":modal") ?? false,
      openerConnected:
        opener instanceof globalThis.HTMLElement &&
        opener.isConnected &&
        active === opener,
    };
  });
}

async function proveGeneratedStarterSurface(
  page,
  demoRequests,
  { caseId, screenshotPath },
  deadline,
) {
  const documentPath = new URL(page.url()).pathname;
  const theme = await page.evaluate(() => {
    const libraryStyle = globalThis.document.querySelector(
      "style[data-opencookie]",
    );
    const root = globalThis.document.querySelector(".oc-root");
    const acceptAll = globalThis.document.querySelector(
      '[data-oc-action="accept-all"]',
    );
    const rejectAll = globalThis.document.querySelector(
      '[data-oc-action="reject-all"]',
    );
    const settings = globalThis.document.querySelector(
      '[data-oc-action="settings"]',
    );
    if (
      !(libraryStyle instanceof globalThis.HTMLStyleElement) ||
      !(root instanceof globalThis.HTMLElement) ||
      !(acceptAll instanceof globalThis.HTMLElement) ||
      !(rejectAll instanceof globalThis.HTMLElement) ||
      !(settings instanceof globalThis.HTMLElement)
    ) {
      throw new Error("DX generated starter theming targets are missing.");
    }
    const consumerStyle = globalThis.document.createElement("style");
    consumerStyle.dataset["ocConsumerTheme"] = "true";
    consumerStyle.textContent = ".oc-root{--oc-accent:#0b5fff}";
    globalThis.document.head.prepend(consumerStyle);
    const hostControl = globalThis.document.createElement("button");
    hostControl.dataset["ocDxHostControl"] = "true";
    hostControl.textContent = "DX host control";
    globalThis.document.body.append(hostControl);
    const styles = [...globalThis.document.querySelectorAll("style")];
    return {
      accentToken: globalThis
        .getComputedStyle(root)
        .getPropertyValue("--oc-accent")
        .trim(),
      acceptAllBackground:
        globalThis.getComputedStyle(acceptAll).backgroundColor,
      acceptAllColor: globalThis.getComputedStyle(acceptAll).color,
      consumerRulePrecedesLibrary:
        styles.indexOf(consumerStyle) < styles.indexOf(libraryStyle),
      paperToken: globalThis
        .getComputedStyle(root)
        .getPropertyValue("--oc-paper")
        .trim(),
      rejectAllBackground:
        globalThis.getComputedStyle(rejectAll).backgroundColor,
      rejectAllColor: globalThis.getComputedStyle(rejectAll).color,
      settingsBackground: globalThis.getComputedStyle(settings).backgroundColor,
      settingsColor: globalThis.getComputedStyle(settings).color,
    };
  });

  const rejectAll = page.locator('[data-oc-action="reject-all"]');
  const settings = page.locator('[data-oc-action="settings"]');
  await rejectAll.focus(browserTimeout(deadline));
  const barTabOrder = [await activeGeneratedElement(page)];
  await page.keyboard.press("Tab");
  barTabOrder.push(await activeGeneratedElement(page));
  await page.keyboard.press("Tab");
  barTabOrder.push(await activeGeneratedElement(page));
  await page.keyboard.press("Tab");
  const barEscape = await activeGeneratedElement(page);
  await settings.focus(browserTimeout(deadline));
  await page.evaluate(() => {
    globalThis.__openCookieDxOpener = globalThis.document.activeElement;
  });
  await page.keyboard.press("Enter");
  const panel = page.locator("dialog.oc-panel");
  await panel.waitFor({ state: "visible", ...browserTimeout(deadline) });
  const opened = await generatedDialogState(page);

  await page.evaluate(() => {
    const reject = globalThis.document.querySelector(
      '[data-oc-action="reject-all"]',
    );
    if (!(reject instanceof globalThis.HTMLElement)) {
      throw new Error("DX generated starter Reject all control is missing.");
    }
    reject.focus();
  });
  if ((await activeGeneratedElement(page)) !== "title") {
    throw new Error("DX generated modal allowed programmatic focus to escape.");
  }

  const panelTabOrder = [];
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Tab");
    panelTabOrder.push(await activeGeneratedElement(page));
  }
  await page.keyboard.press("Shift+Tab");
  const reverseWrap = await activeGeneratedElement(page);
  const panelTheme = await evaluateGeneratedPanel(
    panel,
    (dialog) => {
      const marker = dialog.querySelector(".oc-meta");
      if (!(marker instanceof globalThis.HTMLElement)) {
        throw new Error("DX generated starter panel marker is missing.");
      }
      return {
        panelAccentToken: globalThis
          .getComputedStyle(dialog)
          .getPropertyValue("--oc-accent")
          .trim(),
        panelMarkerBackground: globalThis.getComputedStyle(marker, "::before")
          .backgroundColor,
      };
    },
    deadline,
  );
  const beforeCapture = await evaluateGeneratedPanel(
    panel,
    (dialog) => ({
      dialogOpen: dialog.open,
      modal: dialog.matches(":modal"),
    }),
    deadline,
  );
  const screenshotBytes = await page.screenshot({
    fullPage: true,
    path: screenshotPath,
    ...browserTimeout(deadline),
  });
  const afterCapture = await evaluateGeneratedPanel(
    panel,
    (dialog) => ({
      dialogOpen: dialog.open,
      modal: dialog.matches(":modal"),
    }),
    deadline,
  );

  await page.keyboard.press("Escape");
  await waitForClosedPanel(page, deadline);
  const escaped = await generatedClosedDialogState(page);
  const beforeRejectAll = await observeGeneratedStarterState(
    page,
    demoRequests,
    deadline,
  );

  await rejectAll.click(browserTimeout(deadline));
  const rejectedRecord = await waitForDurableConsentRecord(
    page,
    { decision: "denied", method: "reject-all" },
    deadline,
  );
  await waitForBlockedDemoResourceAndLauncher(page, deadline);
  const afterRejectAll = await observeGeneratedStarterState(
    page,
    demoRequests,
    deadline,
  );

  await page.reload({
    waitUntil: "domcontentloaded",
    ...browserTimeout(deadline),
  });
  await waitForClosedPanel(page, deadline);
  const rejectedReloadRecord = await waitForDurableConsentRecord(
    page,
    { decision: "denied", method: "reject-all" },
    deadline,
  );
  if (rejectedReloadRecord !== rejectedRecord) {
    throw new Error("DX reload replaced the persisted reject-all record.");
  }
  await waitForBlockedDemoResourceAndLauncher(page, deadline);
  const afterRejectedReload = await observeGeneratedStarterState(
    page,
    demoRequests,
    deadline,
  );

  const launcher = page.locator('[data-oc-action="open"]');
  await launcher.evaluate(
    (opener) => {
      globalThis.__openCookieDxOpener = opener;
      opener.click();
    },
    undefined,
    browserTimeout(deadline),
  );
  await panel.waitFor({ state: "visible", ...browserTimeout(deadline) });
  const reopened = await generatedDialogState(page);
  await page.keyboard.press("Escape");
  await waitForClosedPanel(page, deadline);
  const restored = await generatedClosedDialogState(page);

  await page.evaluate((storageKey) => {
    globalThis.localStorage.removeItem(storageKey);
  }, CONSENT_STORAGE_KEY);
  await page.reload({
    waitUntil: "domcontentloaded",
    ...browserTimeout(deadline),
  });
  await page
    .locator(".oc-bar")
    .waitFor({ state: "visible", ...browserTimeout(deadline) });
  await waitForClosedPanel(page, deadline);

  return {
    evidence: {
      documentPath,
      keyboard: {
        barEscape,
        barTabOrder,
        escaped,
        opened,
        panelTabOrder,
        reopened,
        restored,
        reverseWrap,
      },
      rejection: {
        afterRejectAll,
        afterRejectedReload,
        beforeRejectAll,
      },
      screenshot: {
        dialogOpenAfterCapture: afterCapture.dialogOpen,
        dialogOpenBeforeCapture: beforeCapture.dialogOpen,
        modalAfterCapture: afterCapture.modal,
        modalBeforeCapture: beforeCapture.modal,
        path: `screenshots/${caseId}-generated-root.png`,
        sha256: sha256Bytes(screenshotBytes),
      },
      theme: { ...theme, ...panelTheme },
    },
    rejectedRecord,
    rejectedReloadRecord,
  };
}

async function waitForRichRuntime(page, deadline) {
  await page.waitForFunction(
    () =>
      globalThis.__openCookieRichReady === true ||
      typeof globalThis.__openCookieRichError === "string",
    undefined,
    browserTimeout(deadline),
  );
  const error = await page.evaluate(() => globalThis.__openCookieRichError);
  if (typeof error === "string") {
    throw new Error(`DX rich packed runtime failed to start: ${error}`);
  }
}

async function openRichPreferences(page, deadline) {
  await page
    .locator('[data-oc-action="settings"], [data-oc-action="open"]')
    .click(browserTimeout(deadline));
  await page
    .locator("dialog.oc-panel")
    .waitFor({ state: "visible", ...browserTimeout(deadline) });
}

async function waitForRichUiSelection(
  page,
  { categoryState, nestedCategoryState, selectedPurposeIds },
  deadline,
) {
  const handle = await page.waitForFunction(
    ({
      categoryId,
      expectedCategoryState,
      expectedNestedCategoryState,
      expectedPurposeIds,
      nestedCategoryId,
    }) => {
      const category = globalThis.document.querySelector(
        `input[name="opencookie-category"][value="${categoryId}"]`,
      );
      const nestedCategory = globalThis.document.querySelector(
        `input[name="opencookie-category"][value="${nestedCategoryId}"]`,
      );
      if (
        !(category instanceof globalThis.HTMLInputElement) ||
        !(nestedCategory instanceof globalThis.HTMLInputElement)
      ) {
        return false;
      }
      const actualCategoryState = category.indeterminate
        ? "mixed"
        : category.checked
          ? "checked"
          : "unchecked";
      const actualNestedCategoryState = nestedCategory.indeterminate
        ? "mixed"
        : nestedCategory.checked
          ? "checked"
          : "unchecked";
      const actualPurposeIds = Array.from(
        globalThis.document.querySelectorAll(
          'input[name="opencookie-purpose"]',
        ),
      )
        .filter(
          (input) =>
            input instanceof globalThis.HTMLInputElement && input.checked,
        )
        .map((input) => input.value)
        .sort();
      return actualCategoryState === expectedCategoryState &&
        actualNestedCategoryState === expectedNestedCategoryState &&
        JSON.stringify(actualPurposeIds) === JSON.stringify(expectedPurposeIds)
        ? {
            categoryState: actualCategoryState,
            nestedCategoryState: actualNestedCategoryState,
            selectedPurposeIds: actualPurposeIds,
          }
        : false;
    },
    {
      categoryId: PACKED_CATEGORY_ID,
      expectedCategoryState: categoryState,
      expectedNestedCategoryState: nestedCategoryState,
      expectedPurposeIds: selectedPurposeIds,
      nestedCategoryId: RICH_NESTED_CATEGORY_ID,
    },
    browserTimeout(deadline),
  );
  try {
    const value = await handle.jsonValue();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("DX rich category selection was not observable.");
    }
    return value;
  } finally {
    await handle.dispose();
  }
}

export function terminalRichConsentRecordProbe({
  expectedGrantedPurposeIds,
  expectedPurposeIds,
  raw: suppliedRaw,
  storageKey,
}) {
  const raw =
    typeof suppliedRaw === "string"
      ? suppliedRaw
      : globalThis.localStorage.getItem(storageKey);
  if (raw === null) return false;
  try {
    const envelope = JSON.parse(raw);
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      Object.hasOwn(envelope, "pendingGrant")
    ) {
      return false;
    }
    const record = envelope.record;
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      record.method !== "granular" ||
      record.decisions === null ||
      typeof record.decisions !== "object" ||
      Array.isArray(record.decisions)
    ) {
      return false;
    }
    const purposeIds = Object.keys(record.decisions).sort();
    if (JSON.stringify(purposeIds) !== JSON.stringify(expectedPurposeIds)) {
      return false;
    }
    if (
      purposeIds.some(
        (purposeId) =>
          record.decisions[purposeId] !== "granted" &&
          record.decisions[purposeId] !== "denied",
      )
    ) {
      return false;
    }
    const persistedGrantedPurposeIds = purposeIds.filter(
      (purposeId) => record.decisions[purposeId] === "granted",
    );
    return JSON.stringify(persistedGrantedPurposeIds) ===
      JSON.stringify(expectedGrantedPurposeIds)
      ? {
          persistedGrantedPurposeIds,
          persistedMethod: record.method,
          persistedPendingGrantPresent: Object.hasOwn(envelope, "pendingGrant"),
          raw,
        }
      : false;
  } catch {
    return false;
  }
}

async function waitForRichConsentRecord(page, grantedPurposeIds, deadline) {
  const handle = await page.waitForFunction(
    terminalRichConsentRecordProbe,
    {
      expectedGrantedPurposeIds: grantedPurposeIds,
      expectedPurposeIds: RICH_PURPOSE_IDS,
      storageKey: RICH_STORAGE_KEY,
    },
    browserTimeout(deadline),
  );
  try {
    const observed = await handle.jsonValue();
    if (
      observed === null ||
      typeof observed !== "object" ||
      Array.isArray(observed) ||
      typeof observed.raw !== "string" ||
      observed.raw.length === 0 ||
      observed.persistedPendingGrantPresent !== false
    ) {
      throw new Error("DX rich granular record was not durably persisted.");
    }
    return observed;
  } finally {
    await handle.dispose();
  }
}

async function waitForRichResourceState(
  page,
  { active, executions },
  deadline,
) {
  const handle = await page.waitForFunction(
    ({ expectedActive, expectedExecutions, resourceId }) => {
      const actualActive =
        globalThis.document.querySelector(
          `script[data-oc-active-resource="${resourceId}"]`,
        ) !== null;
      const value = globalThis.__openCookieRichDemoRuns;
      const actualExecutions = typeof value === "number" ? value : 0;
      return actualActive === expectedActive &&
        actualExecutions === expectedExecutions
        ? { resourceActive: actualActive, resourceExecutions: actualExecutions }
        : false;
    },
    {
      expectedActive: active,
      expectedExecutions: executions,
      resourceId: RICH_RESOURCE_ID,
    },
    browserTimeout(deadline),
  );
  try {
    const value = await handle.jsonValue();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("DX rich resource state was not observable.");
    }
    return value;
  } finally {
    await handle.dispose();
  }
}

async function observeRichUncommittedSelection(
  page,
  richResourceRequests,
  { categoryState, nestedCategoryState, selectedPurposeIds },
  deadline,
) {
  const ui = await waitForRichUiSelection(
    page,
    { categoryState, nestedCategoryState, selectedPurposeIds },
    deadline,
  );
  const handle = await page.waitForFunction(
    ({ resourceId, resourcePath, storageKey }) => {
      const sources = Array.from(
        globalThis.document.querySelectorAll(
          `script[data-oc-resource="${resourceId}"]`,
        ),
      );
      const inertResourceSourceCount = sources.filter(
        (source) =>
          source.type === "text/plain" && source.dataset.src === resourcePath,
      ).length;
      const activeResourceCount = globalThis.document.querySelectorAll(
        `script[data-oc-active-resource="${resourceId}"]`,
      ).length;
      const value = globalThis.__openCookieRichDemoRuns;
      const resourceExecutions = typeof value === "number" ? value : 0;
      const persistedRecordPresent =
        globalThis.localStorage.getItem(storageKey) !== null;
      return !persistedRecordPresent &&
        sources.length === 1 &&
        inertResourceSourceCount === 1 &&
        activeResourceCount === 0 &&
        resourceExecutions === 0
        ? {
            activeResourceCount,
            inertResourceSourceCount,
            persistedRecordPresent,
            resourceActive: activeResourceCount > 0,
            resourceExecutions,
            resourceSourceCount: sources.length,
          }
        : false;
    },
    {
      resourceId: RICH_RESOURCE_ID,
      resourcePath: RICH_RESOURCE_PATH,
      storageKey: RICH_STORAGE_KEY,
    },
    browserTimeout(deadline),
  );
  try {
    const resource = await handle.jsonValue();
    if (
      resource === null ||
      typeof resource !== "object" ||
      Array.isArray(resource)
    ) {
      throw new Error("DX rich uncommitted selection was not observable.");
    }
    if (richResourceRequests.length !== 0) {
      throw new Error(
        `DX rich uncommitted selection requested its optional resource ${String(richResourceRequests.length)} times.`,
      );
    }
    return {
      ...ui,
      ...resource,
      resourceRequests: richResourceRequests.length,
    };
  } finally {
    await handle.dispose();
  }
}

async function observeRichCommittedSelection(
  page,
  richResourceRequests,
  {
    categoryState,
    nestedCategoryState,
    persistedGrantedPurposeIds,
    resourceActive,
    resourceExecutions,
    resourceRequests,
    selectedPurposeIds,
  },
  deadline,
) {
  const ui = await waitForRichUiSelection(
    page,
    { categoryState, nestedCategoryState, selectedPurposeIds },
    deadline,
  );
  const persisted = await waitForRichConsentRecord(
    page,
    persistedGrantedPurposeIds,
    deadline,
  );
  const resource = await waitForRichResourceState(
    page,
    { active: resourceActive, executions: resourceExecutions },
    deadline,
  );
  if (richResourceRequests.length !== resourceRequests) {
    throw new Error(
      `DX rich resource expected ${String(resourceRequests)} causal requests but observed ${String(richResourceRequests.length)}.`,
    );
  }
  return {
    observation: {
      ...ui,
      persistedGrantedPurposeIds: persisted.persistedGrantedPurposeIds,
      persistedMethod: persisted.persistedMethod,
      persistedPendingGrantPresent: persisted.persistedPendingGrantPresent,
      ...resource,
      resourceRequests: richResourceRequests.length,
    },
    raw: persisted.raw,
  };
}

async function proveRichCategoryLifecycle(
  page,
  url,
  { caseId, moduleRequests, resourceRequests, screenshotPath },
  deadline,
) {
  const richUrl = new URL(RICH_EVIDENCE_DOCUMENT_PATH, url).href;
  await page.goto(richUrl, {
    waitUntil: "domcontentloaded",
    ...browserTimeout(deadline),
  });
  await waitForRichRuntime(page, deadline);
  await page
    .locator(".oc-bar")
    .waitFor({ state: "visible", ...browserTimeout(deadline) });
  await openRichPreferences(page, deadline);
  const beforeCategorySelection = await observeRichUncommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      selectedPurposeIds: [],
    },
    deadline,
  );

  const category = page.getByRole("checkbox", {
    name: PACKED_CATEGORY_ID,
    exact: true,
  });
  await category.check(browserTimeout(deadline));
  const afterCategorySelection = await observeRichUncommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "checked",
      nestedCategoryState: "checked",
      selectedPurposeIds: ["ads", "analytics", "recommendations"],
    },
    deadline,
  );
  await page.locator('[data-oc-action="save"]').click(browserTimeout(deadline));
  await waitForClosedPanel(page, deadline);
  await openRichPreferences(page, deadline);
  const afterCategorySave = await observeRichCommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: ["ads", "analytics", "recommendations"],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 1,
      selectedPurposeIds: ["ads", "analytics", "recommendations"],
    },
    deadline,
  );

  await page.reload({
    waitUntil: "domcontentloaded",
    ...browserTimeout(deadline),
  });
  await waitForRichRuntime(page, deadline);
  await openRichPreferences(page, deadline);
  const afterGrantReload = await observeRichCommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: ["ads", "analytics", "recommendations"],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["ads", "analytics", "recommendations"],
    },
    deadline,
  );

  const ads = page.locator('input[name="opencookie-purpose"][value="ads"]');
  await ads.uncheck(browserTimeout(deadline));
  const partialSelection = await observeRichCommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "mixed",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["ads", "analytics", "recommendations"],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics", "recommendations"],
    },
    deadline,
  );
  if (partialSelection.observation.categoryState !== "mixed") {
    throw new Error(
      "DX category did not become indeterminate after a partial purpose selection.",
    );
  }
  const categoryScreenshotBytes = await page.screenshot({
    fullPage: true,
    path: screenshotPath,
    ...browserTimeout(deadline),
  });

  const profile = page.locator(
    'input[name="opencookie-purpose"][value="profile"]',
  );
  await profile.check(browserTimeout(deadline));
  const beforeCategoryDeselection = await observeRichCommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: ["ads", "analytics", "recommendations"],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["ads", "analytics", "profile", "recommendations"],
    },
    deadline,
  );
  await category.uncheck(browserTimeout(deadline));
  const afterCategoryDeselection = await observeRichCommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["ads", "analytics", "recommendations"],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    },
    deadline,
  );
  if (
    afterCategoryDeselection.observation.selectedPurposeIds.includes("profile")
  ) {
    throw new Error(
      "DX unsupported dependent was not pruned after category deselection.",
    );
  }
  for (const [phase, observedRaw] of [
    ["partial selection", partialSelection.raw],
    ["completed selection", beforeCategoryDeselection.raw],
    ["category deselection", afterCategoryDeselection.raw],
  ]) {
    if (observedRaw !== afterGrantReload.raw) {
      throw new Error(
        `DX ${phase} changed the persisted grant before Save was activated.`,
      );
    }
  }
  // Turning off the rich resource, a script this page ran, reloads the tab
  // once the choice is stored (Pass B's M-C); the reloaded page never runs it.
  const reloadedAfterDeselection = page.waitForEvent(
    "load",
    browserTimeout(deadline),
  );
  await page.locator('[data-oc-action="save"]').click(browserTimeout(deadline));
  await reloadedAfterDeselection;
  await waitForRichRuntime(page, deadline);
  await openRichPreferences(page, deadline);
  const afterDeselectionSave = await observeRichCommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["analytics"],
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    },
    deadline,
  );

  await page.reload({
    waitUntil: "domcontentloaded",
    ...browserTimeout(deadline),
  });
  await waitForRichRuntime(page, deadline);
  await openRichPreferences(page, deadline);
  const afterDeniedReload = await observeRichCommittedSelection(
    page,
    resourceRequests,
    {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["analytics"],
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    },
    deadline,
  );

  const observedModuleRequests = [...new Set(moduleRequests)].sort();
  if (
    JSON.stringify(observedModuleRequests) !==
    JSON.stringify(RICH_MODULE_REQUEST_PATHS)
  ) {
    throw new Error(
      `DX rich route did not load the exact packed public modules: ${JSON.stringify(observedModuleRequests)}.`,
    );
  }
  return {
    afterCategoryDeselection: afterCategoryDeselection.observation,
    afterCategorySave: afterCategorySave.observation,
    afterCategorySelection,
    afterDeniedReload: afterDeniedReload.observation,
    afterDeselectionSave: afterDeselectionSave.observation,
    afterGrantReload: afterGrantReload.observation,
    artifactTransport: "packed-programmatic-esm",
    beforeCategorySelection,
    beforeCategoryDeselection: beforeCategoryDeselection.observation,
    categoryId: PACKED_CATEGORY_ID,
    directPurposeIds: ["recommendations"],
    downstreamPurposeId: "profile",
    expandedPurposeIds: ["ads"],
    moduleRequestPaths: observedModuleRequests,
    nestedCategoryId: RICH_NESTED_CATEGORY_ID,
    partialSelection: partialSelection.observation,
    persistence: {
      afterCategoryDeselectionSha256: sha256Text(afterCategoryDeselection.raw),
      afterCategorySaveSha256: sha256Text(afterCategorySave.raw),
      afterDeselectionSaveSha256: sha256Text(afterDeselectionSave.raw),
      afterDeniedReloadSha256: sha256Text(afterDeniedReload.raw),
      afterGrantReloadSha256: sha256Text(afterGrantReload.raw),
      beforeCategoryDeselectionSha256: sha256Text(
        beforeCategoryDeselection.raw,
      ),
      partialSelectionSha256: sha256Text(partialSelection.raw),
    },
    prerequisitePurposeId: "analytics",
    screenshot: {
      path: `screenshots/${caseId}-category-indeterminate.png`,
      sha256: sha256Bytes(categoryScreenshotBytes),
    },
  };
}

export async function proveBrowserLifecycle(
  browser,
  url,
  deadline,
  { caseId, generatedScreenshotPath, screenshotPath },
) {
  remainingBrowserTimeout(deadline);
  const context = await browser.newContext({
    colorScheme: "light",
    serviceWorkers: "block",
  });
  const applicationUrl = new URL(url);
  const crossOriginRequests = [];
  const demoRequests = [];
  const richModuleRequests = [];
  const richResourceRequests = [];
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (
      (requestUrl.protocol === "http:" || requestUrl.protocol === "https:") &&
      requestUrl.origin !== applicationUrl.origin
    ) {
      crossOriginRequests.push(requestUrl.href);
      await route.abort("blockedbyclient");
      return;
    }
    if (requestUrl.pathname === DEMO_RESOURCE_PATH) {
      demoRequests.push(requestUrl.href);
    }
    if (RICH_MODULE_REQUEST_PATHS.includes(requestUrl.pathname)) {
      richModuleRequests.push(requestUrl.pathname);
    }
    if (requestUrl.pathname === RICH_RESOURCE_PATH) {
      richResourceRequests.push(requestUrl.href);
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", async (webSocket) => {
    const requestUrl = new URL(webSocket.url());
    if (!isSameSchemefulWebSocketOrigin(requestUrl, applicationUrl)) {
      crossOriginRequests.push(requestUrl.href);
      await webSocket.close({ code: 1008, reason: "Origin-only proof" });
      return;
    }
    webSocket.connectToServer();
  });
  try {
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      ...browserTimeout(deadline),
    });
    const bar = page.locator(".oc-bar");
    const panel = page.locator("dialog.oc-panel");
    await bar.waitFor({ state: "visible", ...browserTimeout(deadline) });
    await waitForClosedPanel(page, deadline);
    const executionCount = () =>
      page.evaluate(() => {
        const value = globalThis.__openCookieDemoRuns;
        return typeof value === "number" ? value : 0;
      });
    const beforeConsentExecutions = await executionCount();
    assertDemoRequestCount(demoRequests, 0, "before consent");
    if (beforeConsentExecutions !== 0) {
      throw new Error(
        "DX optional resource ran or was requested before consent.",
      );
    }
    const generatedStarterProof = await proveGeneratedStarterSurface(
      page,
      demoRequests,
      { caseId, screenshotPath: generatedScreenshotPath },
      deadline,
    );
    assertDemoRequestCount(demoRequests, 0, "after reject-all preflight");
    const demoRequestCounts = [0];
    await page
      .getByRole("button", { name: "Accept all", exact: true })
      .click(browserTimeout(deadline));
    await bar.waitFor({ state: "hidden", ...browserTimeout(deadline) });
    await waitForClosedPanel(page, deadline);
    const acceptedRecord = await waitForDurableConsentRecord(
      page,
      { decision: "granted", method: "accept-all" },
      deadline,
    );
    await waitForStartedDemoResource(page, deadline);
    assertDemoRequestCount(demoRequests, 1, "after consent grant");
    demoRequestCounts.push(1);
    const afterGrantExecutions = await executionCount();
    await page.reload({
      waitUntil: "domcontentloaded",
      ...browserTimeout(deadline),
    });
    await waitForClosedPanel(page, deadline);
    const restoredAcceptedRecord = await waitForDurableConsentRecord(
      page,
      { decision: "granted", method: "accept-all" },
      deadline,
    );
    if (restoredAcceptedRecord !== acceptedRecord) {
      throw new Error("DX reload replaced the persisted accept-all record.");
    }
    await waitForStartedDemoResource(page, deadline);
    assertDemoRequestCount(demoRequests, 2, "after persisted grant reload");
    demoRequestCounts.push(2);

    await page
      .getByRole("button", { name: "Privacy choices", exact: true })
      .click(browserTimeout(deadline));
    await panel.waitFor({ state: "visible", ...browserTimeout(deadline) });
    const category = page.getByRole("checkbox", {
      name: PACKED_CATEGORY_ID,
      exact: true,
    });
    if (!(await category.isChecked(browserTimeout(deadline)))) {
      throw new Error("DX restored category selection was not checked.");
    }
    await category.uncheck(browserTimeout(deadline));
    await page
      .getByRole("button", { name: "Save choices", exact: true })
      .click(browserTimeout(deadline));
    await waitForClosedPanel(page, deadline);
    const deniedRecord = await waitForDurableConsentRecord(
      page,
      { decision: "denied", method: "granular" },
      deadline,
    );
    const denialState = await waitForBlockedDemoResourceAndLauncher(
      page,
      deadline,
    );
    assertDemoRequestCount(demoRequests, 2, "after purpose denial");
    await page.reload({
      waitUntil: "domcontentloaded",
      ...browserTimeout(deadline),
    });
    await waitForClosedPanel(page, deadline);
    const restoredDeniedRecord = await waitForDurableConsentRecord(
      page,
      { decision: "denied", method: "granular" },
      deadline,
    );
    if (restoredDeniedRecord !== deniedRecord) {
      throw new Error("DX reload replaced the persisted denial record.");
    }
    await waitForBlockedDemoResourceAndLauncher(page, deadline);
    if ((await executionCount()) !== 0) {
      throw new Error("DX optional resource ran after purpose denial.");
    }
    assertDemoRequestCount(demoRequests, 2, "after denied-purpose reload");
    demoRequestCounts.push(2);

    await page
      .getByRole("button", { name: "Privacy choices", exact: true })
      .click(browserTimeout(deadline));
    await panel.waitFor({ state: "visible", ...browserTimeout(deadline) });
    if (await category.isChecked(browserTimeout(deadline))) {
      throw new Error("DX denied category selection remained checked.");
    }
    await category.check(browserTimeout(deadline));
    await page
      .getByRole("button", { name: "Save choices", exact: true })
      .click(browserTimeout(deadline));
    await waitForClosedPanel(page, deadline);
    await waitForDurableConsentRecord(
      page,
      { decision: "granted", method: "granular" },
      deadline,
    );
    await waitForStartedDemoResource(page, deadline);
    assertDemoRequestCount(demoRequests, 3, "after purpose regrant");
    demoRequestCounts.push(3);
    await page
      .getByRole("button", { name: "Privacy choices", exact: true })
      .click(browserTimeout(deadline));
    await panel.waitFor({ state: "visible", ...browserTimeout(deadline) });
    const withdraw = page.getByRole("button", {
      name: "Withdraw consent",
      exact: true,
    });
    // The demo script ran on this page and cannot be unloaded, so a stored
    // withdrawal reloads the tab (Pass B's M-C). Waiting for that reload also
    // makes a missing one fail here.
    const reloadedAfterWithdrawal = page.waitForEvent(
      "load",
      browserTimeout(deadline),
    );
    await withdraw.click(browserTimeout(deadline));
    await reloadedAfterWithdrawal;
    await waitForClosedPanel(page, deadline);
    const withdrawnRecord = await waitForDurableConsentRecord(
      page,
      { method: "withdrawal" },
      deadline,
    );
    const withdrawalState = await waitForBlockedDemoResourceAndLauncher(
      page,
      deadline,
    );
    assertDemoRequestCount(demoRequests, 3, "after consent withdrawal");
    await page.reload({
      waitUntil: "domcontentloaded",
      ...browserTimeout(deadline),
    });
    await waitForClosedPanel(page, deadline);
    const restoredWithdrawnRecord = await waitForDurableConsentRecord(
      page,
      { method: "withdrawal" },
      deadline,
    );
    if (restoredWithdrawnRecord !== withdrawnRecord) {
      throw new Error("DX reload did not retain the withdrawn consent record.");
    }
    await waitForBlockedDemoResourceAndLauncher(page, deadline);
    assertDemoRequestCount(demoRequests, 3, "after withdrawn-state reload");
    demoRequestCounts.push(3);
    if (
      demoRequestCounts.some(
        (count, index) => count !== EXPECTED_DEMO_REQUEST_COUNTS[index],
      )
    ) {
      throw new Error("DX demo request lifecycle did not match the contract.");
    }
    const afterWithdrawalReloadExecutions = await executionCount();
    const categorySelection = await proveRichCategoryLifecycle(
      page,
      url,
      {
        caseId,
        moduleRequests: richModuleRequests,
        resourceRequests: richResourceRequests,
        screenshotPath,
      },
      deadline,
    );

    return {
      afterGrantExecutions,
      afterWithdrawalReloadExecutions,
      bannerRendered: true,
      beforeConsentExecutions,
      categorySelection,
      consentPersisted: true,
      crossOriginRequests: Object.freeze([...new Set(crossOriginRequests)]),
      demoRequestCounts: Object.freeze(demoRequestCounts),
      denialLauncherRendered: denialState.launcherRendered,
      denialPersisted: true,
      denialResourceBlocked: denialState.resourceBlocked,
      generatedStarter: {
        ...generatedStarterProof.evidence,
        persistence: {
          acceptedReloadSha256: sha256Text(restoredAcceptedRecord),
          acceptedSha256: sha256Text(acceptedRecord),
          rejectedReloadSha256: sha256Text(
            generatedStarterProof.rejectedReloadRecord,
          ),
          rejectedSha256: sha256Text(generatedStarterProof.rejectedRecord),
        },
      },
      withdrawalLauncherRendered: withdrawalState.launcherRendered,
      withdrawalPersisted: true,
      withdrawalPromptedAfterReload: false,
      withdrawalResourceBlocked: withdrawalState.resourceBlocked,
      withdrawalRetainedAfterReload: true,
    };
  } finally {
    await context.close();
  }
}

async function treeSnapshot(root) {
  const entries = [];
  async function visit(directory, relativeDirectory) {
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      if (TREE_IGNORES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      const metadata = await lstat(absolute);
      if (entry.isDirectory()) {
        entries.push(`d:${relative}:${String(metadata.mode & 0o777)}`);
        await visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        entries.push(`l:${relative}:${await readlink(absolute)}`);
      } else if (entry.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex");
        entries.push(
          `f:${relative}:${String(metadata.mode & 0o777)}:${digest}`,
        );
      }
    }
  }
  await visit(root, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function findExecutable(name) {
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }
  throw new Error(`Required executable is missing from PATH: ${name}`);
}

async function writePackageManagerTrap(directory, marker) {
  await mkdir(directory, { recursive: true });
  if (process.platform === "win32") {
    const script = `@echo off\r\n>"${marker}" echo invoked\r\nexit /b 97\r\n`;
    await Promise.all(
      ["npm.cmd", "pnpm.cmd"].map((name) =>
        writeFile(path.join(directory, name), script),
      ),
    );
    return;
  }
  const script = `#!/bin/sh\nprintf invoked > "${marker}"\nexit 97\n`;
  for (const name of ["npm", "pnpm"]) {
    const target = path.join(directory, name);
    await writeFile(target, script);
    await chmod(target, 0o755);
  }
}

async function plainScaffold(projectRoot) {
  await writeFile(
    path.join(projectRoot, "index.html"),
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>OpenCookie DX</title>\n  </head>\n  <body>\n    <main><h1>OpenCookie DX consumer</h1></main>\n  </body>\n</html>\n',
  );
}

async function plainBuild(projectRoot) {
  const html = await readFile(path.join(projectRoot, "index.html"), "utf8");
  if (!/^<!doctype html>/iu.test(html) || !html.includes("<main>")) {
    throw new Error("Plain DX build validation failed.");
  }
}

function richEvidenceStaticRoot(definition, projectRoot) {
  if (definition.id === "plain-cdn") return projectRoot;
  if (definition.id === "sveltekit") return path.join(projectRoot, "static");
  if (
    [
      "astro",
      "next-app",
      "next-pages",
      "next15-app",
      "nuxt",
      "react-vite",
      "vue-vite",
    ].includes(definition.id)
  ) {
    return path.join(projectRoot, "public");
  }
  throw new Error(`DX rich evidence has no static root for ${definition.id}.`);
}

const RICH_EVIDENCE_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenCookie rich packed evidence</title>
    <script type="importmap">
      {
        "imports": {
          "@opencookie-dev/core": "/opencookie-rich-evidence/packages/core.js",
          "@opencookie-dev/core/domain": "/opencookie-rich-evidence/packages/core-domain.js",
          "@opencookie-dev/core/infrastructure": "/opencookie-rich-evidence/packages/core-infrastructure.js",
          "@opencookie-dev/vanilla": "/opencookie-rich-evidence/packages/vanilla.js"
        }
      }
    </script>
  </head>
  <body>
    <main><h1>OpenCookie rich packed evidence</h1></main>
    <script type="text/plain" data-src="/opencookie-rich-evidence/resource.js" data-oc-resource="opencookie-rich-demo-script" data-oc-category="recommendations"></script>
    <script type="module" src="/opencookie-rich-evidence/harness.js"></script>
  </body>
</html>
`;

const RICH_EVIDENCE_HARNESS = `import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

const referenceIds = {
  dataCategoryIds: ["browser-observation"],
  operationIds: ["runtime-verification"],
  providerIds: ["test-harness"],
  recipientIds: ["test-harness"],
  retentionIds: ["test-session"],
};
const purpose = (id, label, dependsOn = []) => ({
  ...referenceIds,
  dependsOn,
  disclosure: \`Exercise the packed \${label} runtime path.\`,
  id,
  label,
});

const runtime = bootstrapOpenCookie({
  catalogueRevision: "dx-rich-catalogue-1",
  policyDefinition: {
    categories: [
      {
        categoryIds: ["advertising"],
        id: "optional",
        purposeIds: ["recommendations"],
      },
      { id: "advertising", purposeIds: ["ads"] },
    ],
    dataCategories: [{ id: "browser-observation" }],
    operations: [{ id: "runtime-verification" }],
    presentationRootCategoryIds: ["optional"],
    providers: [{ id: "test-harness" }],
    purposes: [
      purpose("ads", "Ads", ["analytics"]),
      purpose("analytics", "Analytics"),
      purpose("profile", "Profile", ["ads"]),
      purpose("recommendations", "Recommendations", ["analytics"]),
    ],
    recipients: [{ id: "test-harness" }],
    retentions: [{ id: "test-session" }],
  },
  policyVersion: "dx-rich-policy-1",
  storageKey: "opencookie.rich.consent",
});

globalThis.__openCookieRichRuntime = runtime;
globalThis.__openCookieRichReady = false;
runtime.ready.then(
  () => {
    globalThis.__openCookieRichReady = true;
  },
  (error) => {
    globalThis.__openCookieRichError = String(error);
  },
);
`;

const RICH_EVIDENCE_RESOURCE =
  "globalThis.__openCookieRichDemoRuns = (globalThis.__openCookieRichDemoRuns ?? 0) + 1;\n";

export async function materializeRichBrowserEvidence({
  browserModules,
  definition,
  projectRoot,
}) {
  const expectedModuleKeys = ["core", "domain", "infrastructure", "vanilla"];
  if (
    browserModules === null ||
    typeof browserModules !== "object" ||
    Array.isArray(browserModules) ||
    Object.keys(browserModules).sort().join("\0") !==
      [...expectedModuleKeys].sort().join("\0") ||
    expectedModuleKeys.some(
      (key) =>
        typeof browserModules[key] !== "string" ||
        browserModules[key].length === 0,
    )
  ) {
    throw new Error("DX rich evidence requires the exact packed ESM modules.");
  }
  const evidenceRoot = path.join(
    richEvidenceStaticRoot(definition, projectRoot),
    RICH_EVIDENCE_PATH.slice(1),
  );
  const packagesRoot = path.join(evidenceRoot, "packages");
  await mkdir(packagesRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(evidenceRoot, "index.html"), RICH_EVIDENCE_INDEX),
    writeFile(path.join(evidenceRoot, "harness.js"), RICH_EVIDENCE_HARNESS),
    writeFile(path.join(evidenceRoot, "resource.js"), RICH_EVIDENCE_RESOURCE),
    writeFile(path.join(packagesRoot, "core.js"), browserModules.core),
    writeFile(path.join(packagesRoot, "core-domain.js"), browserModules.domain),
    writeFile(
      path.join(packagesRoot, "core-infrastructure.js"),
      browserModules.infrastructure,
    ),
    writeFile(path.join(packagesRoot, "vanilla.js"), browserModules.vanilla),
  ]);
}

async function configureAllowedBuilds(projectRoot, packageNames) {
  if (packageNames.length === 0) return;
  const workspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
  try {
    await lstat(workspacePath);
    throw new Error(
      "DX scaffold unexpectedly owns pnpm-workspace.yaml; refusing to overwrite it.",
    );
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  const unique = [...new Set(packageNames)].sort();
  await writeFile(
    workspacePath,
    [
      "allowBuilds:",
      ...unique.map((packageName) => `  ${JSON.stringify(packageName)}: true`),
      "",
    ].join("\n"),
  );
}

function parsePnpmPackOutput(output, tarballDirectory) {
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error("pnpm pack did not return JSON.", { cause: error });
  }
  const filename = value?.filename;
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error("pnpm pack did not return one tarball filename.");
  }
  const resolved = path.resolve(filename);
  const root = path.resolve(tarballDirectory);
  if (path.dirname(resolved) !== root) {
    throw new Error("pnpm pack returned a tarball outside the DX directory.");
  }
  return resolved;
}

async function sha256File(filePath) {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function removeAndVerifyAbsent(paths) {
  const uniquePaths = [...new Set(paths.map((entry) => path.resolve(entry)))];
  await Promise.all(
    uniquePaths.map((entry) => rm(entry, { force: true, recursive: true })),
  );
  for (const entry of uniquePaths) {
    try {
      await lstat(entry);
      throw new Error(`Sensitive Pass C preparation path survived: ${entry}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function packPublicPackages(
  repositoryRoot,
  temporaryDirectory,
  abortSignal,
) {
  const packages = sortPackagesForPublication(
    await discoverPublicPackages(repositoryRoot),
  );
  const tarballDirectory = path.join(temporaryDirectory, "tarballs");
  await mkdir(tarballDirectory, { recursive: true });
  const tarballs = new Map();
  for (const packageRecord of packages) {
    const output = await runCommand(
      "pnpm",
      [
        "--filter",
        packageRecord.manifest.name,
        "pack",
        "--pack-destination",
        tarballDirectory,
        "--json",
      ],
      {
        abortSignal,
        cwd: repositoryRoot,
        label: `pack ${packageRecord.manifest.name}`,
      },
    );
    const tarball = parsePnpmPackOutput(output, tarballDirectory);
    const metadata = await stat(tarball);
    if (!metadata.isFile())
      throw new Error(`Packed tarball is not a file: ${tarball}`);
    tarballs.set(packageRecord.manifest.name, tarball);
  }
  return { packages, tarballDirectory, tarballs };
}

async function startVerdaccio(repositoryRoot, temporaryDirectory, abortSignal) {
  throwIfAborted(abortSignal, "start Pass C Verdaccio");
  const baseConfiguration = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "config/verdaccio.package-verification.json"),
      "utf8",
    ),
  );
  const port = await reserveLoopbackPort();
  const registryDirectory = path.join(temporaryDirectory, "verdaccio");
  await mkdir(registryDirectory, { recursive: true });
  const configuration = {
    ...baseConfiguration,
    listen: `127.0.0.1:${String(port)}`,
  };
  validateVerdaccioConfiguration(configuration);
  const configurationPath = path.join(registryDirectory, "config.json");
  await writeFile(
    configurationPath,
    `${JSON.stringify(configuration, null, 2)}\n`,
  );
  const verdaccioCli = path.join(
    repositoryRoot,
    "node_modules/verdaccio/bin/verdaccio",
  );
  await access(verdaccioCli);
  const controller = startChild(
    process.execPath,
    [verdaccioCli, "--config", configurationPath],
    { cwd: registryDirectory, env: process.env },
  );
  const url = assertLoopbackRegistryUrl(`http://127.0.0.1:${String(port)}/`);
  try {
    await waitForUrl(
      new URL("-/ping", url),
      controller,
      Date.now() + 15_000,
      abortSignal,
    );
  } catch (error) {
    await controller.stop();
    throw error;
  }
  return { stop: () => controller.stop(), url };
}

async function writeConsumerCommandGuard(target, executable, command) {
  const script = [
    "#!/usr/bin/env node",
    'const { spawn } = require("node:child_process");',
    "const args = process.argv.slice(2);",
    `const isRegistryPublicationInvocation = ${isRegistryPublicationInvocation.toString()};`,
    `const normalizeConsumerRegistryEnvironment = ${normalizeConsumerRegistryEnvironment.toString()};`,
    `if (isRegistryPublicationInvocation(${JSON.stringify(command)}, args)) {`,
    '  process.stderr.write("Pass C consumer environment: external publishing is disabled; registry removal is disabled.\\n");',
    "  process.exit(96);",
    "}",
    `const child = spawn(${JSON.stringify(executable)}, args, {`,
    `  env: normalizeConsumerRegistryEnvironment(process.env, ${JSON.stringify(PUBLIC_NPM_REGISTRY_URL)}),`,
    '  stdio: "inherit"',
    "});",
    'child.once("error", (error) => {',
    "  process.stderr.write(`${error.message}\\n`);",
    "  process.exit(97);",
    "});",
    'child.once("exit", (code, signal) => {',
    "  if (signal !== null) {",
    "    process.kill(process.pid, signal);",
    "    return;",
    "  }",
    "  process.exitCode = code ?? 1;",
    "});",
    "",
  ].join("\n");
  await writeFile(target, script);
  await chmod(target, 0o755);
}

async function createConsumerCommandGuards(directory) {
  await mkdir(directory, { recursive: true });
  for (const command of ["npm", "npx", "pnpm"]) {
    await writeConsumerCommandGuard(
      path.join(directory, command),
      await findExecutable(command),
      command,
    );
  }
}

function isolatedInheritedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:npm|pnpm)_config_/iu.test(key) &&
        !/^(?:node_auth_token|npm_token|yarn_npm_auth_token)$/iu.test(key) &&
        !/^(?:pnpm_store_dir|pnpm_home|xdg_data_home)$/iu.test(key),
    ),
  );
}

function pathWithoutRepositories(value, repositoryRoots) {
  const forbiddenRoots = repositoryRoots.map((root) => path.resolve(root));
  return (value ?? "")
    .split(path.delimiter)
    .filter((entry) => {
      if (entry.length === 0) return false;
      const resolved = path.resolve(entry);
      return forbiddenRoots.every(
        (forbiddenRoot) =>
          resolved !== forbiddenRoot &&
          !resolved.startsWith(`${forbiddenRoot}${path.sep}`),
      );
    })
    .join(path.delimiter);
}

function consumerNpmConfiguration(registryUrl) {
  return [
    `registry=${PUBLIC_NPM_REGISTRY_URL}`,
    `@opencookie-dev:registry=${assertLoopbackRegistryUrl(registryUrl)}`,
    "audit=false",
    "fund=false",
    "provenance=false",
    "update-notifier=false",
    "",
  ].join("\n");
}

export async function npmEnvironments(
  temporaryDirectory,
  registryUrl,
  repositoryRoots,
) {
  const safeRegistryUrl = assertLoopbackRegistryUrl(registryUrl);
  const parsedRegistryUrl = new URL(safeRegistryUrl);
  const localPublishToken = randomBytes(24).toString("base64url");
  const publisherDirectory = path.join(temporaryDirectory, "publisher-npm");
  const publisherCache = path.join(publisherDirectory, "cache");
  const publisherUserConfiguration = path.join(
    publisherDirectory,
    "user.npmrc",
  );
  const publisherGlobalConfiguration = path.join(
    publisherDirectory,
    "global.npmrc",
  );
  const consumerDirectory = path.join(temporaryDirectory, "consumer-npm");
  const consumerCache = path.join(consumerDirectory, "cache");
  const consumerScratch = path.join(consumerDirectory, "scratch");
  const consumerUserConfiguration = path.join(consumerDirectory, "user.npmrc");
  const consumerGlobalConfiguration = path.join(
    consumerDirectory,
    "global.npmrc",
  );
  const commandGuardDirectory = path.join(consumerDirectory, "guard-bin");
  const consumerStore = packedConsumerStoreDirectory(
    homedir(),
    process.platform,
  );
  await Promise.all([
    mkdir(publisherCache, { recursive: true }),
    mkdir(consumerCache, { recursive: true }),
    mkdir(consumerScratch, { recursive: true }),
  ]);
  await createConsumerCommandGuards(commandGuardDirectory);
  await writeFile(
    publisherUserConfiguration,
    [
      `registry=${safeRegistryUrl}`,
      `@opencookie-dev:registry=${safeRegistryUrl}`,
      `//${parsedRegistryUrl.host}${parsedRegistryUrl.pathname}:_authToken=${localPublishToken}`,
      "audit=false",
      "fund=false",
      "provenance=false",
      "update-notifier=false",
      "",
    ].join("\n"),
  );
  await writeFile(publisherGlobalConfiguration, "");
  await writeFile(
    consumerUserConfiguration,
    consumerNpmConfiguration(safeRegistryUrl),
  );
  await writeFile(consumerGlobalConfiguration, "");

  const inheritedEnvironment = isolatedInheritedEnvironment();
  const commonEnvironment = {
    CI: "1",
    NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  const publisherEnvironment = {
    ...inheritedEnvironment,
    ...commonEnvironment,
    NPM_CONFIG_CACHE: publisherCache,
    NPM_CONFIG_GLOBALCONFIG: publisherGlobalConfiguration,
    NPM_CONFIG_REGISTRY: safeRegistryUrl,
    NPM_CONFIG_USERCONFIG: publisherUserConfiguration,
  };
  const consumerEnvironment = {
    ...commonEnvironment,
    NPM_CONFIG_CACHE: consumerCache,
    NPM_CONFIG_GLOBALCONFIG: consumerGlobalConfiguration,
    NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY_URL,
    NPM_CONFIG_USERCONFIG: consumerUserConfiguration,
    PATH: `${commandGuardDirectory}${path.delimiter}${pathWithoutRepositories(
      inheritedEnvironment.PATH,
      repositoryRoots,
    )}`,
    PNPM_CONFIG_STORE_DIR: consumerStore,
    pnpm_config_pm_on_fail: "ignore",
  };
  return {
    consumer: {
      environment: consumerEnvironment,
      paths: {
        cacheDirectory: consumerCache,
        commandGuardDirectory,
        globalConfiguration: consumerGlobalConfiguration,
        scratchRoot: consumerScratch,
        userConfiguration: consumerUserConfiguration,
      },
      runtimeEnvironment: neutralizeAgentEnvironment({
        ...inheritedEnvironment,
        ...consumerEnvironment,
      }),
    },
    publisherDirectory,
    publisherEnvironment,
  };
}

async function publishTarballs(
  packages,
  tarballs,
  registryUrl,
  temporaryDirectory,
  env,
  abortSignal,
) {
  for (const packageRecord of packages) {
    await runCommand(
      "npm",
      [
        "publish",
        tarballs.get(packageRecord.manifest.name),
        "--registry",
        registryUrl,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--provenance=false",
        "--access",
        "public",
      ],
      {
        abortSignal,
        cwd: temporaryDirectory,
        env,
        label: `publish ${packageRecord.manifest.name} to loopback registry`,
      },
    );
  }
}

function assertTarballMember(member) {
  if (typeof member !== "string" || member.length === 0) {
    throw new Error("A tarball member path is required.");
  }
  const parts = member.split("/");
  if (
    path.isAbsolute(member) ||
    member.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      `Tarball member path must stay inside the archive: ${member}`,
    );
  }
}

/**
 * Read one tarball member as exact bytes, whatever its size.
 *
 * The member is extracted with `tar -xf` and read back as a Buffer. Callers
 * that need text decode that buffer once. Command output keeps its own log cap.
 *
 * @param {string} tarball
 * @param {string} member Archive path, such as `package/dist/auto.iife.js`.
 * @param {{ abortSignal?: AbortSignal, cwd?: string, label?: string }} [options]
 * @returns {Promise<Buffer>}
 */
export async function readTarballMember(
  tarball,
  member,
  { abortSignal, cwd, label } = {},
) {
  assertTarballMember(member);
  if (typeof tarball !== "string" || tarball.length === 0) {
    throw new Error("A tarball path is required.");
  }
  const extractDirectory = await mkdtemp(
    path.join(tmpdir(), "opencookie-dx-tarball-member-"),
  );
  try {
    const archive = path.resolve(cwd ?? process.cwd(), tarball);
    await runCommand(
      "tar",
      ["-xf", archive, "-C", extractDirectory, "--", member],
      {
        abortSignal,
        cwd,
        label: label ?? `read tarball member ${member}`,
      },
    );
    const root = path.resolve(extractDirectory);
    const extracted = path.resolve(root, member);
    if (extracted !== root && !extracted.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `Tarball member escaped the extract directory: ${member}`,
      );
    }
    try {
      return await readFile(extracted);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Tarball member is missing: ${member}`, {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    await rm(extractDirectory, { force: true, recursive: true });
  }
}

async function extractVanillaScript(tarballs, consumerDirectory, abortSignal) {
  const tarball = tarballs.get("@opencookie-dev/vanilla");
  if (tarball === undefined) throw new Error("Vanilla tarball is missing.");
  const bytes = await readTarballMember(tarball, "package/dist/auto.iife.js", {
    abortSignal,
    cwd: consumerDirectory,
    label: "extract packed vanilla IIFE",
  });
  const source = bytes.toString("utf8");
  const manifest = JSON.parse(
    await runCommand("tar", ["-xOf", tarball, "package/package.json"], {
      abortSignal,
      cwd: consumerDirectory,
      label: "read packed vanilla manifest",
    }),
  );
  const vanillaDirectory = path.join(consumerDirectory, "vanilla");
  const vanillaPath = path.join(vanillaDirectory, "auto.iife.js");
  await mkdir(vanillaDirectory, { recursive: true });
  await writeFile(vanillaPath, bytes);
  return {
    cdnPath: vanillaCdnPath(manifest.version),
    path: vanillaPath,
    sha256: sha256Bytes(bytes),
    source,
  };
}

async function extractPackedBrowserModules(
  tarballs,
  consumerDirectory,
  abortSignal,
) {
  const coreTarball = tarballs.get("@opencookie-dev/core");
  const vanillaTarball = tarballs.get("@opencookie-dev/vanilla");
  if (coreTarball === undefined || vanillaTarball === undefined) {
    throw new Error("Packed rich DX ESM tarballs are missing.");
  }
  const extract = async (tarball, archivePath, label) => {
    const bytes = await readTarballMember(tarball, `package/${archivePath}`, {
      abortSignal,
      cwd: consumerDirectory,
      label,
    });
    return bytes.toString("utf8");
  };
  const [core, domain, infrastructure, vanilla] = await Promise.all([
    extract(coreTarball, "dist/index.js", "extract packed core browser ESM"),
    extract(
      coreTarball,
      "dist/domain.js",
      "extract packed core domain browser ESM",
    ),
    extract(
      coreTarball,
      "dist/infrastructure.js",
      "extract packed core infrastructure browser ESM",
    ),
    extract(
      vanillaTarball,
      "dist/index.js",
      "extract packed vanilla browser ESM",
    ),
  ]);
  return Object.freeze({ core, domain, infrastructure, vanilla });
}

export function packedInitializerArguments(definition, registryUrl) {
  return [
    "--yes",
    `--registry=${registryUrl}`,
    "opencookie@0.4.1",
    "init",
    "--yes",
    ...(definition.id === "plain-cdn" ? ["--self-host"] : []),
  ];
}

function createCasePorts({
  artifactDirectory,
  browser,
  browserModules,
  definition,
  env,
  npxPath,
  projectRoot,
  registryUrl,
  temporaryDirectory,
  vanillaSha256,
  vanillaScript,
}) {
  const deadline = Date.now() + definition.timeoutMs;
  const caseEnvironment = createConsumerProcessEnvironment(
    env,
    definition.packageManager,
  );
  return {
    async browserProof() {
      const port = await reserveLoopbackPort();
      const url = `http://127.0.0.1:${String(port)}/`;
      const controller =
        definition.id === "plain-cdn"
          ? await startPackedPlainServer({
              expectedSha256: vanillaSha256,
              port,
              projectRoot,
              vanillaScript,
            })
          : startFrameworkServer(
              definition,
              projectRoot,
              caseEnvironment,
              port,
            );
      try {
        await waitForUrl(
          url,
          "child" in controller ? controller : undefined,
          deadline,
        );
        return await proveBrowserLifecycle(browser, url, deadline, {
          caseId: definition.id,
          generatedScreenshotPath: path.join(
            artifactDirectory,
            "screenshots",
            `${definition.id}-generated-root.png`,
          ),
          screenshotPath: path.join(
            artifactDirectory,
            "screenshots",
            `${definition.id}-category-indeterminate.png`,
          ),
        });
      } finally {
        await controller.stop();
      }
    },
    async build() {
      if (definition.build.command === "internal") {
        await plainBuild(projectRoot);
        return;
      }
      await runCommand(definition.build.command, definition.build.args, {
        cwd: projectRoot,
        deadline,
        env: caseEnvironment,
        label: `${definition.id} build`,
      });
    },
    async initialize({ blockInstaller }) {
      const marker = path.join(
        temporaryDirectory,
        `${definition.id}-installer-invoked`,
      );
      let commandEnvironment = caseEnvironment;
      if (blockInstaller) {
        const trapDirectory = path.join(
          temporaryDirectory,
          `${definition.id}-package-manager-trap`,
        );
        await writePackageManagerTrap(trapDirectory, marker);
        commandEnvironment = {
          ...caseEnvironment,
          PATH: `${trapDirectory}${path.delimiter}${caseEnvironment.PATH ?? ""}`,
        };
      }
      const output = await runCommand(
        npxPath,
        packedInitializerArguments(definition, registryUrl),
        {
          cwd: projectRoot,
          deadline,
          env: commandEnvironment,
          label: `${definition.id} packed npx init`,
        },
      );
      const initialized = `OpenCookie initialized for ${definition.expectedFrameworkLabel}.`;
      const unchanged = "OpenCookie is already initialized. No files changed.";
      const installerInvoked = await access(marker).then(
        () => true,
        () => false,
      );
      let status = "unknown";
      if (output.includes(initialized)) status = "initialized";
      else if (output.includes(unchanged)) status = "unchanged";
      if (!blockInstaller && status === "initialized") {
        await materializeRichBrowserEvidence({
          browserModules,
          definition,
          projectRoot,
        });
      }
      return { installerInvoked, status };
    },
    async install() {
      if (definition.packageManager === "none") return;
      const invocation =
        definition.packageManager === "npm"
          ? {
              args: ["install", "--no-audit", "--no-fund"],
              command: "npm",
            }
          : {
              args: ["install", "--no-frozen-lockfile"],
              command: "pnpm",
            };
      await runCommand(invocation.command, invocation.args, {
        cwd: projectRoot,
        deadline,
        env: caseEnvironment,
        label: `${definition.id} dependency install`,
      });
    },
    now: Date.now,
    async scaffold() {
      if (definition.scaffold.command === "internal") {
        await plainScaffold(projectRoot);
        return;
      }
      await runCommand(definition.scaffold.command, definition.scaffold.args, {
        cwd: projectRoot,
        deadline,
        env: caseEnvironment,
        label: `${definition.id} fresh scaffold`,
      });
      await configureAllowedBuilds(projectRoot, definition.allowBuilds);
    },
    snapshot: () => treeSnapshot(projectRoot),
  };
}

function parseJsonCommandOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} did not return JSON.`, { cause: error });
  }
}

async function assertConsumerPublishingIsBlocked(context, abortSignal) {
  for (const args of [
    ["publish"],
    ["publish", "--registry", PUBLIC_NPM_REGISTRY_URL],
  ]) {
    try {
      await runCommand("npm", args, {
        abortSignal,
        cwd: context.consumer.paths.scratchRoot,
        env: context.consumer.runtimeEnvironment,
        label: "Pass C external-publish guard",
      });
    } catch (error) {
      if (/external publishing is disabled/iu.test(String(error?.message))) {
        continue;
      }
      throw new Error("Pass C consumer publish guard did not fail safely.", {
        cause: error,
      });
    }
    throw new Error("Pass C consumer environment allowed an external publish.");
  }
}

export async function verifyPackedConsumerEnvironment(
  context,
  { abortSignal = context.abortSignal } = {},
) {
  throwIfAborted(abortSignal, "verify packed Pass C environment");
  const registryUrl = assertLoopbackRegistryUrl(context.registryUrl);
  if (!Array.isArray(context.packages) || context.packages.length !== 9) {
    throw new Error("Pass C requires exactly nine packed public packages.");
  }
  const packageNames = new Set();
  for (const packageRecord of context.packages) {
    if (
      typeof packageRecord.name !== "string" ||
      typeof packageRecord.version !== "string" ||
      !/^[a-f0-9]{64}$/u.test(packageRecord.tarballSha256)
    ) {
      throw new Error("Pass C packed package metadata is incomplete.");
    }
    if (packageNames.has(packageRecord.name)) {
      throw new Error(
        `Pass C packed package is duplicated: ${packageRecord.name}`,
      );
    }
    packageNames.add(packageRecord.name);
  }

  await waitForUrl(
    new URL("-/ping", registryUrl),
    undefined,
    Date.now() + 5_000,
    abortSignal,
  );
  const { consumer } = context;
  if (
    consumer.environment.NPM_CONFIG_REGISTRY !== PUBLIC_NPM_REGISTRY_URL ||
    consumer.runtimeEnvironment.NPM_CONFIG_REGISTRY !==
      PUBLIC_NPM_REGISTRY_URL ||
    consumer.environment.pnpm_config_pm_on_fail !== "ignore" ||
    consumer.runtimeEnvironment.pnpm_config_pm_on_fail !== "ignore" ||
    !consumer.environment.PATH.startsWith(
      `${consumer.paths.commandGuardDirectory}${path.delimiter}`,
    )
  ) {
    throw new Error("Pass C consumer commands are not registry-confined.");
  }
  const [userConfiguration, globalConfiguration] = await Promise.all([
    readFile(consumer.paths.userConfiguration, "utf8"),
    readFile(consumer.paths.globalConfiguration, "utf8"),
  ]);
  if (
    /(?:_auth|token|password|secret)/iu.test(userConfiguration) ||
    globalConfiguration !== "" ||
    userConfiguration !== consumerNpmConfiguration(registryUrl)
  ) {
    throw new Error("Pass C consumer npm configuration is not token-free.");
  }
  await assertConsumerPublishingIsBlocked(context, abortSignal);

  for (const packageRecord of context.packages) {
    const output = await runCommand(
      "npm",
      [
        "view",
        `${packageRecord.name}@${packageRecord.version}`,
        "version",
        "--json",
        "--registry",
        registryUrl,
      ],
      {
        abortSignal,
        cwd: consumer.paths.scratchRoot,
        env: consumer.runtimeEnvironment,
        label: `resolve exact Pass C package ${packageRecord.name}`,
      },
    );
    if (
      parseJsonCommandOutput(
        output,
        `resolve exact Pass C package ${packageRecord.name}`,
      ) !== packageRecord.version
    ) {
      throw new Error(
        `Pass C registry did not resolve ${packageRecord.name}@${packageRecord.version}.`,
      );
    }
  }

  const downloadedRoot = path.join(
    consumer.paths.scratchRoot,
    "registry-package-proof",
  );
  const downloadedTarballs = new Map();
  for (const [index, packageRecord] of context.packages.entries()) {
    const downloadedDirectory = path.join(
      downloadedRoot,
      String(index).padStart(2, "0"),
    );
    await mkdir(downloadedDirectory, { recursive: true });
    const packedOutput = await runCommand(
      "npm",
      [
        "pack",
        `${packageRecord.name}@${packageRecord.version}`,
        "--json",
        "--silent",
        "--pack-destination",
        downloadedDirectory,
        "--ignore-scripts",
        "--registry",
        registryUrl,
      ],
      {
        abortSignal,
        cwd: consumer.paths.scratchRoot,
        env: consumer.runtimeEnvironment,
        label: `download exact Pass C package ${packageRecord.name}`,
      },
    );
    const downloadedTarball = await parsePackResult(
      packedOutput,
      downloadedDirectory,
    );
    if ((await sha256File(downloadedTarball)) !== packageRecord.tarballSha256) {
      throw new Error(
        `Pass C registry tarball hash changed: ${packageRecord.name}`,
      );
    }
    downloadedTarballs.set(packageRecord.name, downloadedTarball);
  }
  const vanillaRecord = context.packages.find(
    ({ name }) => name === "@opencookie-dev/vanilla",
  );
  if (vanillaRecord === undefined) {
    throw new Error("Pass C packed vanilla package is missing.");
  }
  const downloadedTarball = downloadedTarballs.get(vanillaRecord.name);
  if (downloadedTarball === undefined) {
    throw new Error(
      "Pass C registry-fetched vanilla package proof is missing.",
    );
  }
  const downloadedVanilla = await readTarballMember(
    downloadedTarball,
    "package/dist/auto.iife.js",
    {
      abortSignal,
      cwd: consumer.paths.scratchRoot,
      label: "extract registry-fetched Pass C vanilla IIFE",
    },
  );
  if (
    sha256Bytes(downloadedVanilla) !== context.vanilla.sha256 ||
    (await sha256File(context.vanilla.path)) !== context.vanilla.sha256
  ) {
    throw new Error(
      "Pass C packed vanilla IIFE hash does not match the registry.",
    );
  }

  return {
    consumerRegistryRoutingVerified: true,
    externalPublishingBlocked: true,
    packageCount: context.packages.length,
    registryPing: true,
    vanillaIifeVerified: true,
  };
}

export async function withPackedConsumerEnvironment({
  abortSignal,
  candidate,
  repositoryRoot,
  task,
}) {
  if (typeof task !== "function") {
    throw new TypeError(
      "Packed consumer environment requires a task callback.",
    );
  }
  const root = path.resolve(repositoryRoot);
  const temporaryDirectory = await createCanonicalPackedTemporaryDirectory();
  try {
    const candidateCheckout =
      candidate === undefined
        ? undefined
        : await materializeCandidateCheckout({
            abortSignal,
            candidate,
            repositoryRoot: root,
            runtimeRoot: temporaryDirectory,
          });
    const buildRoot = candidateCheckout?.checkoutRoot ?? root;
    if (candidateCheckout !== undefined) {
      await runCommand("pnpm", PASS_C_CANDIDATE_INSTALL_ARGS, {
        abortSignal,
        cwd: buildRoot,
        label: "install immutable Pass C candidate",
      });
    }
    await runCommand("pnpm", ["build"], {
      abortSignal,
      cwd: buildRoot,
      label: "build exact package artifacts for DX",
    });
    const packed = await packPublicPackages(
      buildRoot,
      temporaryDirectory,
      abortSignal,
    );
    return await withDisposableRegistry(
      () => startVerdaccio(buildRoot, temporaryDirectory, abortSignal),
      async ({ url: registryUrl }) => {
        throwIfAborted(abortSignal, "prepare packed Pass C environment");
        const environments = await npmEnvironments(
          temporaryDirectory,
          registryUrl,
          [root, buildRoot],
        );
        throwIfAborted(abortSignal, "prepare packed Pass C environment");
        await publishTarballs(
          packed.packages,
          packed.tarballs,
          registryUrl,
          temporaryDirectory,
          environments.publisherEnvironment,
          abortSignal,
        );
        const consumerDirectory = path.dirname(
          environments.consumer.paths.scratchRoot,
        );
        const [browserModules, vanilla] = await Promise.all([
          extractPackedBrowserModules(
            packed.tarballs,
            consumerDirectory,
            abortSignal,
          ),
          extractVanillaScript(packed.tarballs, consumerDirectory, abortSignal),
        ]);
        const packages = await Promise.all(
          packed.packages.map(async ({ manifest }) => {
            const tarballPath = packed.tarballs.get(manifest.name);
            if (tarballPath === undefined) {
              throw new Error(`Packed tarball is missing: ${manifest.name}`);
            }
            return {
              name: manifest.name,
              tarballSha256: await sha256File(tarballPath),
              version: manifest.version,
            };
          }),
        );
        throwIfAborted(abortSignal, "prepare packed Pass C environment");
        if (candidateCheckout !== undefined) {
          const [head, status, remotes] = await Promise.all([
            runCommand("git", ["rev-parse", "HEAD"], {
              abortSignal,
              cwd: buildRoot,
              label: "reverify packed Pass C candidate HEAD",
            }),
            runCommand(
              "git",
              ["status", "--porcelain=v1", "--untracked-files=all"],
              {
                abortSignal,
                cwd: buildRoot,
                label: "reverify packed Pass C candidate status",
              },
            ),
            runCommand("git", ["remote"], {
              abortSignal,
              cwd: buildRoot,
              label: "reverify packed Pass C candidate remotes",
            }),
          ]);
          if (
            head.trim() !== candidate ||
            status.trim() !== "" ||
            remotes.trim() !== ""
          ) {
            throw new Error(
              "Packed Pass C candidate changed during package preparation.",
            );
          }
        }
        await removeAndVerifyAbsent([
          packed.tarballDirectory,
          environments.publisherDirectory,
          ...(candidateCheckout === undefined
            ? []
            : [candidateCheckout.checkoutRoot]),
        ]);
        throwIfAborted(abortSignal, "isolate packed Pass C consumer");
        return task({
          abortSignal,
          browserModules,
          candidate,
          consumer: environments.consumer,
          packages,
          registryUrl,
          vanilla,
        });
      },
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export async function runPackedDx({
  artifactDirectory,
  definitions,
  logger,
  repositoryRoot,
}) {
  return withPackedConsumerEnvironment({
    repositoryRoot,
    task: async (packed) => {
      const npxPath = await findExecutable("npx");
      const browser = await chromium.launch();
      try {
        const results = [];
        for (const definition of definitions) {
          const projectRoot = path.join(
            packed.consumer.paths.scratchRoot,
            "consumers",
            definition.id,
          );
          await mkdir(projectRoot, { recursive: true });
          const ports = createCasePorts({
            artifactDirectory,
            browser,
            browserModules: packed.browserModules,
            definition,
            env: packed.consumer.runtimeEnvironment,
            npxPath,
            projectRoot,
            registryUrl: packed.registryUrl,
            temporaryDirectory: packed.consumer.paths.scratchRoot,
            vanillaSha256: packed.vanilla.sha256,
            vanillaScript: packed.vanilla.source,
          });
          const result = await verifyDxLifecycle(definition, ports);
          results.push(result);
          logger.log(
            `DX PASS ${definition.id}: ${String(result.elapsedMs)} ms, banner rendered, consent persisted, idempotent.`,
          );
        }
        return results;
      } finally {
        await browser.close();
      }
    },
  });
}
