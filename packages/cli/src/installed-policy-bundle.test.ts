import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createNodeFileSystem,
  runDoctor,
  runPolicyCommand,
  type Diagnostic,
} from "./index.js";

// The whole custom-integration route, end to end: install the live policy as
// JSON, bundle a generic page that bootstraps OpenCookie from it the way a
// site's own build would (minified, for the browser, every OpenCookie package
// inlined), and ask doctor what the shipped file carries. The control imports
// only the policy from the same JSON, so the digests are dropped and doctor
// must not call it current.

const fixtures = fileURLToPath(
  new URL("../test/fixtures/installed-policy-bundle/", import.meta.url),
);
const vanillaSource = fileURLToPath(
  new URL("../../adapters/vanilla/src/index.ts", import.meta.url),
);

// The fixture directory holds the generic policy this test publishes, and the
// JSON install writes for it, which the entries import. The test bundles the
// JSON its own install writes, never the committed one.
const INSTALLED = "src/opencookie-policy.json";

let root = "";
let project = "";

function ports(lines: string[]) {
  return {
    fileSystem: createNodeFileSystem(project),
    writeLine: (line: string) => lines.push(line),
  };
}

/**
 * The part of tsdown's `build()` this test calls, the bundler the size gate
 * already uses. It is loaded by a specifier the compiler does not resolve,
 * because tsdown's declarations name optional packages this workspace does not
 * install, and this project checks library declarations too.
 */
type Build = (config: Readonly<Record<string, unknown>>) => Promise<unknown>;
const TSDOWN: string = "tsdown";

/** Bundles one fixture entry as a site would ship it, and returns its path. */
async function bundle(entry: string): Promise<string> {
  const { build } = (await import(TSDOWN)) as { readonly build: Build };
  const name = entry.replace(/\.ts$/u, "");
  await copyFile(join(fixtures, entry), join(project, "src", entry));
  const outDir = join(project, "dist", name);
  await build({
    alias: { "@opencookie-dev/vanilla": vanillaSource },
    clean: true,
    config: false,
    cwd: project,
    deps: { alwaysBundle: [/^@opencookie-dev\//u] },
    dts: false,
    entry: { app: join(project, "src", entry) },
    fixedExtension: false,
    format: "esm",
    hash: false,
    logLevel: "silent",
    minify: true,
    outDir,
    platform: "browser",
    sourcemap: false,
    target: "es2022",
  });
  const file = (await readdir(outDir)).find((fileName) =>
    /\.m?js$/u.test(fileName),
  );
  if (file === undefined) throw new Error(`${entry} produced no bundle.`);
  return `dist/${name}/${file}`;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opencookie-bundle-"));
  project = join(root, "site");
  await mkdir(join(project, "src"), { recursive: true });
  await copyFile(join(fixtures, "policy.json"), join(project, "policy.json"));
  const lines: string[] = [];
  const published = await runPolicyCommand(ports(lines), [
    "publish",
    "--id",
    "pub-1",
    "--policy",
    "policy.json",
  ]);
  const installed = await runPolicyCommand(ports(lines), [
    "install",
    "--out",
    INSTALLED,
  ]);
  if (!published.ok || !installed.ok) {
    throw new Error(
      `The fixture project failed to set up: ${lines.join("\n")}`,
    );
  }
}, 60_000);

afterAll(async () => {
  if (root !== "") await rm(root, { force: true, recursive: true });
});

const bundleCodes = (diagnostics: readonly Diagnostic[]) =>
  diagnostics
    .map(({ code }) => code)
    .filter(
      (code) => code.startsWith("bundle-") || code === "policy-not-installed",
    );

describe("a minified bundle of a custom integration", () => {
  // The committed copy is what the entries import in the repository. Install
  // must write exactly it for this policy, recorded digests included, so the
  // copy cannot drift from what a site would really bundle.
  it("installs the JSON the fixture entries import", async () => {
    const installed: unknown = JSON.parse(
      await readFile(join(project, INSTALLED), "utf8"),
    );
    const committed: unknown = JSON.parse(
      await readFile(join(fixtures, "opencookie-policy.json"), "utf8"),
    );

    expect(installed).toStrictEqual(committed);
  });

  it("carries the live identity when it bootstraps from the installed JSON", async () => {
    const shipped = await bundle("installed-policy-entry.ts");
    const code = await readFile(join(project, shipped), "utf8");
    const installed = JSON.parse(
      await readFile(join(project, INSTALLED), "utf8"),
    ) as { catalogueDigest: string; decisionSurfaceDigest: string };
    const lines: string[] = [];

    const result = await runDoctor(ports(lines), { bundles: [shipped] });

    // Minified: the fixture's comments are gone and the code is not indented.
    expect(code).not.toContain("A generic custom integration");
    expect(code).not.toMatch(/\n {2}\S/u);
    expect(code).toContain(installed.catalogueDigest);
    expect(code).toContain(installed.decisionSurfaceDigest);
    expect(bundleCodes(result.diagnostics)).toEqual([]);
    expect(lines.join("\n")).toContain(
      `${shipped} carries the identity of the live publication pub-1 (policy version 1.0.0).`,
    );
  }, 60_000);

  it("is unverified when the bundle imports only the policy", async () => {
    const shipped = await bundle("policy-only-entry.ts");
    const code = await readFile(join(project, shipped), "utf8");
    const lines: string[] = [];

    const result = await runDoctor(ports(lines), { bundles: [shipped] });

    // The policy made it in; only the recorded identity did not.
    expect(code).toContain("Counts visits so we can see which pages are read.");
    expect(code).not.toMatch(/sha256-v1:[0-9a-f]{64}/u);
    expect(result.ok).toBe(false);
    // The JSON install itself is current; only the bundle is unverified.
    expect(bundleCodes(result.diagnostics)).toEqual([
      "bundle-policy-unverified",
    ]);
  }, 60_000);
});
