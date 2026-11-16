import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const TOKEN = "an-operator-token-for-the-serve-bin-test";

// The built CLI is copied out of dist before it is used. Another test file
// builds this same package, and the build clears dist first, so spawning
// straight from dist means racing a directory that is briefly not there. The
// copy stays inside the package so the bundle still resolves its dependencies.
const ownDirectory = fileURLToPath(
  new URL("../.serve-console-test/", import.meta.url),
);
const binary = `${ownDirectory}bin.js`;

beforeAll(async () => {
  const built = fileURLToPath(new URL("../dist/", import.meta.url));
  // This file does not build the package. Another test file already does, and
  // the build clears dist before it writes, so a second builder would pull the
  // directory out from under whatever the first one is reading. The whole
  // directory is copied, because a bin.js caught mid-build imported a chunk,
  // ./init.js, that copying bin.js alone left behind (FYI-2026-09-24b). A copy
  // is kept only once it loads, and a build is run only if none ever does.
  const copyWhenReady = async (): Promise<boolean> => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await rm(ownDirectory, { force: true, recursive: true });
        await cp(built, ownDirectory, { recursive: true });
        await execFileAsync(process.execPath, [binary, "--help"]);
        return true;
      } catch {
        if (Date.now() > deadline) return false;
        await new Promise((wait) => setTimeout(wait, 250));
      }
    }
  };
  if (await copyWhenReady()) return;
  await execFileAsync("pnpm", ["--filter", "opencookie", "build"], {
    cwd: repositoryRoot,
  });
  if (!(await copyWhenReady())) {
    throw new Error("The built CLI never loaded from its copy.");
  }
}, 180_000);

afterAll(async () => {
  await rm(ownDirectory, { force: true, recursive: true });
});

const running: {
  directory?: string | undefined;
  process?: ChildProcess | undefined;
} = {};

afterEach(async () => {
  running.process?.kill("SIGKILL");
  if (running.directory !== undefined) {
    await rm(running.directory, { force: true, recursive: true });
  }
  running.process = undefined;
  running.directory = undefined;
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => {
    probe.listen(0, "127.0.0.1", ready);
  });
  const address = probe.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((closed) => {
    probe.close(() => {
      closed();
    });
  });
  return port;
}

async function startConsole(): Promise<{
  origin: string;
  output: () => string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opencookie-serve-"));
  running.directory = root;
  // The console is started from one directory and pointed at another, so a
  // --cwd that stopped working would write somewhere visible in this test
  // rather than into whichever directory the suite happens to run from.
  const project = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  await mkdir(project);
  await mkdir(elsewhere);
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [binary, "serve", "--port", String(port), "--cwd", project],
    {
      cwd: elsewhere,
      env: { ...process.env, OPENCOOKIE_OPERATOR_TOKEN: TOKEN },
    },
  );
  running.process = child;
  let output = "";
  child.stdout.on(
    "data",
    (chunk: Buffer) => (output += chunk.toString("utf8")),
  );
  child.stderr.on(
    "data",
    (chunk: Buffer) => (output += chunk.toString("utf8")),
  );
  const deadline = Date.now() + 30_000;
  while (!output.includes("operator console")) {
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`The console did not start. Output:\n${output}`);
    }
    await new Promise((wait) => setTimeout(wait, 50));
  }
  return { origin: `http://127.0.0.1:${String(port)}`, output: () => output };
}

// This is the milestone in one test: the published command, a real process, a
// real socket and a site that exists on disk afterwards.
it("serves the operator console from the installed command", async () => {
  const { origin, output } = await startConsole();

  const signedIn = await fetch(`${origin}/login`, {
    body: new URLSearchParams({ token: TOKEN }),
    method: "POST",
    redirect: "manual",
  });
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const listing = await fetch(`${origin}/`, { headers: { cookie } });
  const body = await listing.text();
  const formToken = /name="formToken" value="([^"]+)"/u.exec(body)?.[1] ?? "";
  const created = await fetch(`${origin}/sites`, {
    body: new URLSearchParams({
      domain: "shop.example.com",
      formToken,
      name: "shop",
    }),
    headers: { cookie },
    method: "POST",
    redirect: "manual",
  });
  const registry = await readFile(
    join(running.directory ?? "", "project", "opencookie", "sites.json"),
    "utf8",
  );

  expect(signedIn.status).toBe(303);
  expect(listing.status).toBe(200);
  expect(created.status).toBe(303);
  expect(JSON.parse(registry)).toMatchObject({
    sites: [{ domains: ["shop.example.com"], name: "shop" }],
  });
  expect(output()).toContain("operator console");
}, 120_000);

// A token the operator supplied must not end up in terminal scrollback or in
// whatever captures this process's output.
it("never prints the token it was given", async () => {
  const { output } = await startConsole();

  // The greeting is written one line at a time, and the pipe can hand the
  // lines over in separate chunks. Its last line names the variable, so wait
  // for that line before checking that the token itself never appeared.
  await vi.waitFor(
    () => {
      expect(output()).toContain("OPENCOOKIE_OPERATOR_TOKEN");
    },
    { interval: 50, timeout: 30_000 },
  );
  expect(output()).not.toContain(TOKEN);
}, 120_000);

// Item 7 asks for an operator who reaches the surface, creates the first site
// and publishes a working policy. With the console the shell commands are the
// install and `serve`; this drives the rest the way a browser would.
it("takes an operator from sign-in to a published policy in the browser", async () => {
  const { origin } = await startConsole();
  const form = async (path: string, fields: Record<string, string>) =>
    fetch(`${origin}${path}`, {
      body: new URLSearchParams(fields),
      headers: { cookie },
      method: "POST",
      redirect: "manual",
    });

  const signedIn = await fetch(`${origin}/login`, {
    body: new URLSearchParams({ token: TOKEN }),
    method: "POST",
    redirect: "manual",
  });
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const sites = await fetch(`${origin}/`, { headers: { cookie } });
  const formToken =
    /name="formToken" value="([^"]+)"/u.exec(await sites.text())?.[1] ?? "";
  const created = await form("/sites", {
    domain: "shop.example.com",
    formToken,
    name: "shop",
  });
  const starter = await form("/sites/shop/policy/starter", { formToken });
  const published = await form("/sites/shop/policy/publish", {
    formToken,
    id: "2026-09-a",
    policy: "opencookie/policy.json",
  });
  const status = await fetch(`${origin}/sites/shop/policy`, {
    headers: { cookie },
  });
  const shown = await status.text();
  const stored = await readFile(
    join(
      running.directory ?? "",
      "project",
      "opencookie",
      "sites",
      "shop",
      "policy-publications.json",
    ),
    "utf8",
  );

  expect(created.status).toBe(303);
  expect(starter.status).toBe(303);
  expect(published.status).toBe(303);
  expect(shown).toContain("2026-09-a");
  expect(stored).toContain("2026-09-a");
}, 120_000);
