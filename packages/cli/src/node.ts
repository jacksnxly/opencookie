import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import type { FileSystemPort } from "./contracts.js";
import { PathOutsideProjectError } from "./project-paths.js";
import type { CliPorts, CommandPort, VanillaBrowserAsset } from "./init.js";

/** Node-specific dependencies used by the CLI ports. @public */
export interface NodeCliPortsOptions {
  /** Absolute package entry file path or `file:` URL. */
  readonly vanillaPackageEntrypoint?: string;
}

function vanillaPackageEntrypointUrl(entrypoint: string): URL {
  if (isAbsolute(entrypoint)) return pathToFileURL(entrypoint);
  const url = new URL(entrypoint);
  if (url.protocol !== "file:") {
    throw new Error(
      "The installed vanilla package entrypoint must be an absolute path or file URL.",
    );
  }
  return url;
}

async function loadInstalledVanillaBrowserAsset(
  entrypoint: string,
): Promise<VanillaBrowserAsset> {
  const bytes = await readFile(
    new URL("./auto.iife.js", vanillaPackageEntrypointUrl(entrypoint)),
  );
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new Error("The installed vanilla browser asset is not valid UTF-8.");
  }
  return Object.freeze({
    content,
    integrity: `sha384-${createHash("sha384").update(bytes).digest("base64")}`,
  });
}

function projectPath(projectRoot: string, path: string): string {
  const absolute = resolve(projectRoot, path);
  const fromRoot = relative(projectRoot, absolute);
  if (isOutsideProject(fromRoot)) {
    throw new PathOutsideProjectError(path);
  }
  return absolute;
}

function isOutsideProject(relativePath: string): boolean {
  return (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** The computer and process a lock file names as its holder. */
interface LockHolder {
  readonly host: string;
  readonly pid: number;
}

function lockHolder(content: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(content) as { host?: unknown; pid?: unknown };
    return typeof parsed.host === "string" &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0
      ? { host: parsed.host, pid: parsed.pid }
      : undefined;
  } catch {
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to another user.
    return !hasErrorCode(error, "ESRCH");
  }
}

/** A lock's content, or undefined once it is gone. */
async function lockContent(target: string): Promise<string | undefined> {
  for (let reads = 0; ; reads += 1) {
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch (error: unknown) {
      if (isMissingPath(error)) return undefined;
      throw error;
    }
    // A lock is created empty and its holder written at once, so wait out
    // that moment before deciding it names no process.
    if (content !== "" || reads > 0) return content;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

/**
 * Takes a lock file and records which process holds it.
 *
 * A command stopped by Ctrl-C or a crash never removes its lock. A lock whose
 * process on this computer has stopped is removed and taken. One whose process
 * still runs, or that names none, is left alone, and the error says which and
 * what to do.
 */
async function takeLock(target: string, path: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let lock: FileHandle | undefined;
    try {
      lock = await open(target, "wx");
    } catch (error: unknown) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    if (lock !== undefined) {
      try {
        await lock.writeFile(
          JSON.stringify({ host: hostname(), pid: process.pid }),
          "utf8",
        );
        return lock;
      } catch (error: unknown) {
        await lock.close();
        await unlink(target).catch(() => undefined);
        throw error;
      }
    }
    const content = await lockContent(target);
    if (content === undefined) continue;
    const holder = lockHolder(content);
    if (holder === undefined || holder.host !== hostname()) {
      throw new Error(
        `${path} is held by another OpenCookie command${holder === undefined ? "" : ` on ${holder.host}`}. If no OpenCookie command is running, delete ${path} and try again.`,
      );
    }
    if (isRunning(holder.pid)) {
      throw new Error(
        `${path} is held by OpenCookie process ${String(holder.pid)}, which is still running. Wait for it to finish, then try again.`,
      );
    }
    // Removed only while it still names the stopped process, so a lock another
    // command has taken meanwhile is left alone.
    if ((await lockContent(target)) === content) {
      await unlink(target).catch(() => undefined);
    }
  }
  throw new Error(
    `${path} is held by another OpenCookie command. Wait for it to finish, then try again.`,
  );
}

async function releaseLock(target: string, lock: FileHandle): Promise<void> {
  await lock.close();
  await unlink(target).catch(() => undefined);
}

function isConfined(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return !isOutsideProject(fromRoot);
}

async function confinedProjectPath(
  projectRoot: string,
  path: string,
): Promise<string> {
  const target = projectPath(projectRoot, path);
  const realRoot = await realpath(projectRoot);
  const findExistingAncestor = async (candidate: string): Promise<string> => {
    try {
      return await realpath(candidate);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      try {
        await lstat(candidate);
      } catch (lstatError: unknown) {
        if (!isMissingPath(lstatError)) throw lstatError;
        const parent = dirname(candidate);
        if (parent === candidate) throw error;
        return findExistingAncestor(parent);
      }
      throw new Error(
        `Refusing to access an unresolved symbolic link in the project: ${path}`,
        { cause: error },
      );
    }
  };
  const realAncestor = await findExistingAncestor(target);
  if (!isConfined(realRoot, realAncestor)) {
    throw new PathOutsideProjectError(path);
  }
  return target;
}

/** Creates a project-confined Node.js filesystem adapter. @public */
export function createNodeFileSystem(projectRoot: string): FileSystemPort {
  return {
    async exists(path): Promise<boolean> {
      const target = await confinedProjectPath(projectRoot, path);
      try {
        await lstat(target);
        return true;
      } catch (error: unknown) {
        if (isMissingPath(error)) return false;
        throw error;
      }
    },
    async mkdir(path): Promise<void> {
      const target = await confinedProjectPath(projectRoot, path);
      await mkdir(target, { recursive: true });
    },
    async readFile(path): Promise<string> {
      const target = await confinedProjectPath(projectRoot, path);
      return readFile(target, "utf8");
    },
    async replaceFile(path, expectedContent, content): Promise<void> {
      const target = await confinedProjectPath(projectRoot, path);
      const lockPath = `${target}.opencookie-lock`;
      const temporaryPath = `${target}.opencookie-${String(process.pid)}-${randomUUID()}.tmp`;
      const lock = await takeLock(lockPath, `${path}.opencookie-lock`);
      try {
        const current = await readFile(target, "utf8");
        if (current !== expectedContent) {
          throw new Error(
            `Refusing to replace ${path} because it changed after preflight.`,
          );
        }
        const mode = (await stat(target)).mode;
        // Create the temporary file with the target's permissions directly.
        // Writing it with default permissions and tightening afterwards would
        // leave the new content briefly readable by others.
        await writeFile(temporaryPath, content, {
          encoding: "utf8",
          flag: "wx",
          mode: mode & 0o777,
        });
        await chmod(temporaryPath, mode);
        await rename(temporaryPath, target);
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
        await releaseLock(lockPath, lock);
      }
    },
    async withLock<Result>(
      path: string,
      operation: () => Promise<Result>,
    ): Promise<Result> {
      const lockPath = await confinedProjectPath(projectRoot, path);
      const lock = await takeLock(lockPath, path);
      try {
        return await operation();
      } finally {
        await releaseLock(lockPath, lock);
      }
    },
    async writeFile(path, content, options): Promise<void> {
      const target = await confinedProjectPath(projectRoot, path);
      return writeFile(target, content, {
        encoding: "utf8",
        flag: "wx",
        ...(options?.mode === undefined ? {} : { mode: options.mode }),
      });
    },
  };
}

/** Executes commands directly, without shell interpolation. @public */
export const nodeCommandPort: CommandPort = {
  run(command, args, cwd): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        shell: false,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolvePromise();
          return;
        }
        reject(
          new Error(
            signal === null
              ? `${command} exited with code ${String(code)}.`
              : `${command} was terminated by ${signal}.`,
          ),
        );
      });
    });
  },
};

/** Creates the real CLI ports for one project root. @public */
export function createNodeCliPorts(
  projectRoot: string,
  options: NodeCliPortsOptions = {},
): CliPorts {
  const { vanillaPackageEntrypoint } = options;
  return {
    command: nodeCommandPort,
    async confirm(message): Promise<boolean> {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await prompt.question(`${message} [y/N] `);
        return (
          answer.trim().toLowerCase() === "y" ||
          answer.trim().toLowerCase() === "yes"
        );
      } finally {
        prompt.close();
      }
    },
    fileSystem: createNodeFileSystem(projectRoot),
    ...(vanillaPackageEntrypoint === undefined
      ? {}
      : {
          loadVanillaBrowserAsset: () =>
            loadInstalledVanillaBrowserAsset(vanillaPackageEntrypoint),
        }),
    writeLine: (line): void => {
      process.stdout.write(`${line}\n`);
    },
  };
}
