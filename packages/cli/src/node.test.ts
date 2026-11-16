import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CliConflictError,
  createNodeFileSystem,
  initializeProject,
} from "./index.js";

const temporaryRoots: string[] = [];

async function symlinkFixture(): Promise<{
  readonly outside: string;
  readonly project: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opencookie-cli-node-"));
  temporaryRoots.push(root);
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(project);
  await mkdir(outside);
  await symlink(outside, join(project, "src"), "dir");
  return { outside, project };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("createNodeFileSystem", () => {
  it("refuses reads through a directory symlink outside the project", async () => {
    const { outside, project } = await symlinkFixture();
    await writeFile(join(outside, "secret.txt"), "outside\n");
    const fileSystem = createNodeFileSystem(project);
    await expect(fileSystem.readFile("src/secret.txt")).rejects.toThrow(
      /outside the project/i,
    );
  });

  it("refuses writes through a directory symlink outside the project", async () => {
    const { outside, project } = await symlinkFixture();
    const fileSystem = createNodeFileSystem(project);
    await expect(
      fileSystem.writeFile("src/new.txt", "escape\n"),
    ).rejects.toThrow(/outside the project/i);
    await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toThrow();
  });

  it("rejects a dangling generated-file symlink before commands or writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencookie-cli-node-"));
    temporaryRoots.push(root);
    const project = join(root, "project");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        dependencies: { react: "latest", vite: "latest" },
        packageManager: "pnpm@11.22.0",
      }),
    );
    await writeFile(join(project, "pnpm-lock.yaml"), "");
    await writeFile(
      join(project, "src/main.tsx"),
      `import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
`,
    );
    await symlink(
      join(project, "missing-config.ts"),
      join(project, "opencookie.config.ts"),
      "file",
    );
    const entriesBefore = await readdir(project);
    const commands: string[] = [];

    await expect(
      initializeProject(
        {
          command: {
            run: (command) => {
              commands.push(command);
              return Promise.resolve();
            },
          },
          confirm: vi.fn(() => Promise.resolve(true)),
          fileSystem: createNodeFileSystem(project),
          writeLine: vi.fn(),
        },
        { projectRoot: project, yes: true },
      ),
    ).rejects.toThrow(CliConflictError);

    expect(commands).toEqual([]);
    expect(await readdir(project)).toEqual(entriesBefore);
  });

  it("rejects a dangling generated-directory symlink before commands or writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencookie-cli-node-"));
    temporaryRoots.push(root);
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        dependencies: { nuxt: "4.5.2" },
        packageManager: "pnpm@11.22.0",
      }),
    );
    await writeFile(join(project, "pnpm-lock.yaml"), "");
    await writeFile(
      join(project, "nuxt.config.ts"),
      "export default defineNuxtConfig({});\n",
    );
    await symlink(
      join(project, "missing-public"),
      join(project, "public"),
      "dir",
    );
    const entriesBefore = await readdir(project);
    const commands: string[] = [];

    await expect(
      initializeProject(
        {
          command: {
            run: (command) => {
              commands.push(command);
              return Promise.resolve();
            },
          },
          confirm: vi.fn(() => Promise.resolve(true)),
          fileSystem: createNodeFileSystem(project),
          writeLine: vi.fn(),
        },
        { projectRoot: project, yes: true },
      ),
    ).rejects.toThrow(CliConflictError);

    expect(commands).toEqual([]);
    expect(await readdir(project)).toEqual(entriesBefore);
  });

  it("rejects a generated-directory path whose ancestor is a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencookie-cli-node-"));
    temporaryRoots.push(root);
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        dependencies: { nuxt: "4.5.2" },
        packageManager: "pnpm@11.22.0",
      }),
    );
    await writeFile(join(project, "pnpm-lock.yaml"), "");
    await writeFile(
      join(project, "nuxt.config.ts"),
      "export default defineNuxtConfig({});\n",
    );
    await writeFile(join(project, "public"), "not a directory\n");
    const entriesBefore = await readdir(project);
    const commands: string[] = [];

    await expect(
      initializeProject(
        {
          command: {
            run: (command) => {
              commands.push(command);
              return Promise.resolve();
            },
          },
          confirm: vi.fn(() => Promise.resolve(true)),
          fileSystem: createNodeFileSystem(project),
          writeLine: vi.fn(),
        },
        { projectRoot: project, yes: true },
      ),
    ).rejects.toThrow(CliConflictError);

    expect(commands).toEqual([]);
    expect(await readdir(project)).toEqual(entriesBefore);
    expect(await readFile(join(project, "public"), "utf8")).toBe(
      "not a directory\n",
    );
  });
});

// Consent evidence is personal data. It must be created readable by the owner
// only, and must stay that way when later rewritten.
describe.skipIf(process.platform === "win32")(
  "createNodeFileSystem file modes",
  () => {
    async function project(): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "opencookie-cli-mode-"));
      temporaryRoots.push(root);
      return root;
    }

    it("creates a file with an owner-only mode when asked", async () => {
      const root = await project();
      const fileSystem = createNodeFileSystem(root);

      await fileSystem.writeFile("private.json", "{}", { mode: 0o600 });

      expect((await stat(join(root, "private.json"))).mode & 0o777).toBe(0o600);
    });

    it("keeps an owner-only file owner-only when it is replaced", async () => {
      const root = await project();
      const fileSystem = createNodeFileSystem(root);
      await fileSystem.writeFile("private.json", "{}", { mode: 0o600 });

      await fileSystem.replaceFile("private.json", "{}", '{"a":1}');

      expect((await stat(join(root, "private.json"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(root, "private.json"), "utf8")).toBe(
        '{"a":1}',
      );
    });
  },
);

// A command stopped by Ctrl-C or a crash never reaches the code that removes
// its lock. Such a lock must not block every later command for good, and a
// lock a running command holds must never be taken from it.
describe("a lock a stopped command left behind", () => {
  async function projectRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "opencookie-cli-lock-"));
    temporaryRoots.push(root);
    return root;
  }

  async function exitedProcessId(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => child.once("exit", resolve));
    if (child.pid === undefined) throw new Error("The child had no pid.");
    return child.pid;
  }

  it("records which process holds a lock", async () => {
    const root = await projectRoot();
    const fileSystem = createNodeFileSystem(root);

    const recorded = await fileSystem.withLock(
      "work.lock",
      async () =>
        JSON.parse(await readFile(join(root, "work.lock"), "utf8")) as unknown,
    );

    expect(recorded).toMatchObject({ host: hostname(), pid: process.pid });
  });

  it("is recovered when the process that held it has stopped", async () => {
    const root = await projectRoot();
    await writeFile(
      join(root, "work.lock"),
      JSON.stringify({ host: hostname(), pid: await exitedProcessId() }),
    );
    const fileSystem = createNodeFileSystem(root);

    await expect(
      fileSystem.withLock("work.lock", () => Promise.resolve("ran")),
    ).resolves.toBe("ran");
    await expect(stat(join(root, "work.lock"))).rejects.toThrow();
  });

  it("is kept, and its holder named, while that process still runs", async () => {
    const root = await projectRoot();
    const held = JSON.stringify({ host: hostname(), pid: process.pid });
    await writeFile(join(root, "work.lock"), held);
    const fileSystem = createNodeFileSystem(root);
    const operation = vi.fn(() => Promise.resolve());

    await expect(fileSystem.withLock("work.lock", operation)).rejects.toThrow(
      `work.lock is held by OpenCookie process ${String(process.pid)}`,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(join(root, "work.lock"), "utf8")).toBe(held);
  });

  it("says how to clear a lock that names no process, and keeps it", async () => {
    const root = await projectRoot();
    await writeFile(join(root, "work.lock"), "");
    const fileSystem = createNodeFileSystem(root);

    await expect(
      fileSystem.withLock("work.lock", () => Promise.resolve()),
    ).rejects.toThrow(
      /If no OpenCookie command is running, delete work\.lock/u,
    );
    expect(await readFile(join(root, "work.lock"), "utf8")).toBe("");
  });

  it("recovers a replacement lock whose process has stopped", async () => {
    const root = await projectRoot();
    await writeFile(join(root, "state.json"), "old");
    await writeFile(
      join(root, "state.json.opencookie-lock"),
      JSON.stringify({ host: hostname(), pid: await exitedProcessId() }),
    );
    const fileSystem = createNodeFileSystem(root);

    await fileSystem.replaceFile("state.json", "old", "new");

    expect(await readFile(join(root, "state.json"), "utf8")).toBe("new");
  });
});
