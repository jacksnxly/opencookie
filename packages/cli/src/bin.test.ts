import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// The builds are a prerequisite, not the behaviour under test. They cost a
// few seconds of CPU, but on a busy machine they waited past the test's own
// 30 s before anything it checks had run. They get their own bound, and the
// 30 s stays on packing, linking and running the commands. They run once for
// the whole file, so no test here rebuilds dist under another.
beforeAll(async () => {
  await execFileAsync(
    "pnpm",
    ["--filter", "@opencookie-dev/vanilla", "build"],
    {
      cwd: repositoryRoot,
    },
  );
  await execFileAsync("pnpm", ["--filter", "opencookie", "build"], {
    cwd: repositoryRoot,
  });
}, 180_000);

it("runs when npm invokes the packed bin through a symlink", async () => {
  const source = await readFile(new URL("./bin.ts", import.meta.url), "utf8");
  expect(source).not.toContain("pathToFileURL(process.argv[1])");
  expect(source).toContain("runCli(process.argv.slice(2), process.cwd())");
});

it("ships a publishable manifest for npx consumers", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    private?: boolean;
    publishConfig?: { access?: string };
    version?: string;
  };
  expect(manifest.private).not.toBe(true);
  expect(manifest.version).toBe("0.4.2");
  expect(manifest.publishConfig?.access).toBe("public");
  expect(manifest.dependencies?.["@opencookie-dev/vanilla"]).toBe(
    "workspace:^",
  );
  expect(manifest.dependencies?.["@opencookie-dev/core"]).toBe("workspace:^");
});

describe("the packed initializer", () => {
  it("executes the packed initializer through a package-manager-style bin symlink", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "opencookie-cli-bin-"));
    try {
      const vanillaEntrypoint = join(
        repositoryRoot,
        "packages/adapters/vanilla/dist/index.js",
      );
      const { stdout: commonJsSmoke } = await execFileAsync(
        process.execPath,
        [
          "-e",
          'const api = require(process.argv[1]); const defaults = api.createNodeCliPorts(process.cwd()); if (defaults.loadVanillaBrowserAsset !== undefined) throw new Error("Unexpected default asset loader"); const ports = api.createNodeCliPorts(process.cwd(), { vanillaPackageEntrypoint: process.argv[2] }); ports.loadVanillaBrowserAsset().then((asset) => process.stdout.write(asset.integrity));',
          join(packageRoot, "dist/index.cjs"),
          vanillaEntrypoint,
        ],
        { cwd: repositoryRoot },
      );
      expect(commonJsSmoke).toMatch(/^sha384-[A-Za-z\d+/]{64}$/u);
      const { stdout: packOutput } = await execFileAsync(
        "npm",
        ["pack", packageRoot, "--json", "--pack-destination", temporaryRoot],
        { cwd: repositoryRoot },
      );
      const packed = JSON.parse(packOutput) as readonly [{ filename: string }];
      const tarball = join(temporaryRoot, packed[0].filename);
      await execFileAsync("tar", ["-xzf", tarball, "-C", temporaryRoot]);

      const extractedPackage = join(temporaryRoot, "package");
      await mkdir(join(extractedPackage, "node_modules"));
      for (const dependency of ["oxc-parser", "parse5", "semver"]) {
        await symlink(
          await realpath(join(packageRoot, "node_modules", dependency)),
          join(extractedPackage, "node_modules", dependency),
          "junction",
        );
      }
      await mkdir(join(extractedPackage, "node_modules/@opencookie-dev"));
      await symlink(
        await realpath(join(repositoryRoot, "packages/adapters/vanilla")),
        join(extractedPackage, "node_modules/@opencookie-dev/vanilla"),
        "junction",
      );
      await symlink(
        await realpath(join(repositoryRoot, "packages/core")),
        join(extractedPackage, "node_modules/@opencookie-dev/core"),
        "junction",
      );
      const site = join(temporaryRoot, "site");
      const bin = join(site, "node_modules/.bin/opencookie");
      await mkdir(dirname(bin), { recursive: true });
      await symlink(join(extractedPackage, "dist/bin.js"), bin, "file");
      await writeFile(
        join(site, "index.html"),
        "<!doctype html><html><body></body></html>\n",
      );

      await execFileAsync(
        process.execPath,
        [bin, "init", "--yes", "--self-host"],
        { cwd: site },
      );

      const generatedBundle = await readFile(
        join(site, "vendor/opencookie/auto.iife.js"),
      );
      const expectedBundle = await readFile(
        join(repositoryRoot, "packages/adapters/vanilla/dist/auto.iife.js"),
      );
      expect(generatedBundle).toEqual(expectedBundle);
      const integrity = `sha384-${createHash("sha384")
        .update(generatedBundle)
        .digest("base64")}`;
      const html = await readFile(join(site, "index.html"), "utf8");
      expect(html).toContain('src="/vendor/opencookie/auto.iife.js"');
      expect(html).toContain(`integrity="${integrity}"`);
      expect(html).toContain('data-src="/opencookie-demo.js"');
      expect(html).not.toContain("cdn.jsdelivr.net");
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);
});

// doctor took no options at all. It now takes --bundle <file>, repeatable, to
// check a custom integration's bundle, and must still refuse anything else
// rather than ignore it.
describe("the doctor command", () => {
  const bin = join(packageRoot, "dist/bin.js");

  const opencookie = async (
    project: string,
    ...args: readonly string[]
  ): Promise<{ code: number; stderr: string; stdout: string }> => {
    try {
      const { stderr, stdout } = await execFileAsync(process.execPath, [
        bin,
        ...args,
        "--cwd",
        project,
      ]);
      return { code: 0, stderr, stdout };
    } catch (error) {
      const failed = error as {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      return {
        code: failed.code ?? -1,
        stderr: failed.stderr ?? "",
        stdout: failed.stdout ?? "",
      };
    }
  };

  /** A project with one publication installed as JSON, and a bundle of it. */
  const projectWithBundle = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "opencookie-doctor-bin-"));
    const project = join(root, "project");
    await mkdir(join(project, "dist"), { recursive: true });
    await writeFile(
      join(project, "policy.json"),
      JSON.stringify({
        catalogueRevision: "catalogue-1",
        policy: {
          dataCategories: [{ id: "usage-data" }],
          operations: [{ id: "processing" }],
          providers: [{ id: "site-operator" }],
          purposes: [
            {
              dataCategoryIds: ["usage-data"],
              disclosure: "Counts visits in total.",
              id: "analytics",
              operationIds: ["processing"],
              providerIds: ["site-operator"],
              recipientIds: ["site-operator"],
              retentionIds: ["thirteen-months"],
            },
          ],
          recipients: [{ id: "site-operator" }],
          retentions: [{ id: "thirteen-months" }],
        },
        policyVersion: "1.0.0",
      }),
    );
    const published = await opencookie(
      project,
      "policy",
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    );
    expect(published.code).toBe(0);
    const installed = await opencookie(
      project,
      "policy",
      "install",
      "--out",
      "src/opencookie-policy.json",
    );
    expect(installed.code).toBe(0);
    const document = await readFile(
      join(project, "src/opencookie-policy.json"),
      "utf8",
    );
    await writeFile(join(project, "dist/app.js"), `window.oc(${document});\n`);
    return project;
  };

  const cleanUp = (project: string) =>
    rm(dirname(project), { force: true, recursive: true });

  it.each([["--bundle", "dist/app.js"], ["--bundle=dist/app.js"]])(
    "accepts %s and checks the bundle it names",
    async (...bundle: string[]) => {
      const project = await projectWithBundle();
      try {
        const result = await opencookie(project, "doctor", ...bundle);

        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
          "dist/app.js carries the identity of the live publication pub-1",
        );
        expect(result.stdout).not.toContain("policy-not-installed");
      } finally {
        await cleanUp(project);
      }
    },
    30_000,
  );

  it("refuses a bundle outside the project", async () => {
    const project = await projectWithBundle();
    try {
      const result = await opencookie(
        project,
        "doctor",
        "--bundle",
        "../outside.js",
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "../outside.js is outside the project, and the CLI reads files only inside it.",
      );
    } finally {
      await cleanUp(project);
    }
  }, 30_000);

  it.each([
    [["--verbose"], "--verbose"],
    [["stray"], "stray"],
    [["--bundle", "dist/app.js", "--fix"], "--fix"],
    [["--bundle"], "--bundle requires a value."],
  ])(
    "still refuses doctor %j",
    async (args, named) => {
      const project = await projectWithBundle();
      try {
        const result = await opencookie(project, "doctor", ...args);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(named);
        expect(result.stdout).not.toContain("carries the identity");
      } finally {
        await cleanUp(project);
      }
    },
    30_000,
  );
});
