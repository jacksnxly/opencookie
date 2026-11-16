import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectDisplayedSampleIssues,
  extractDisplayedSample,
} from "./verify-docs-samples-lib.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const docsRoot = path.join(repoRoot, "apps/docs");
const binExtension = process.platform === "win32" ? ".cmd" : "";
const rootNodeModules = path.join(repoRoot, "node_modules");

async function materializeDisplayedSamples() {
  const samplesRoot = path.join(docsRoot, "samples");
  const issues = await collectDisplayedSampleIssues(samplesRoot);
  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }
  const consumerRoot = await mkdtemp(
    path.join(tmpdir(), "opencookie-docs-consumers-"),
  );
  const entries = await readdir(samplesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sample.ts")) continue;
    const sample = extractDisplayedSample(
      await readFile(path.join(samplesRoot, entry.name), "utf8"),
      entry.name,
    );
    const output = path.join(consumerRoot, sample.consumerPath);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, sample.source);
  }
  await writeFile(
    path.join(consumerRoot, "opencookie.config.ts"),
    [
      'import type { OpenCookie } from "@opencookie-dev/core";',
      "export declare function createOpenCookieStore(): OpenCookie;",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(consumerRoot, "opencookie.policy.ts"),
    [
      'import type { PolicySnapshot } from "@opencookie-dev/core";',
      "export declare function createPolicySnapshotForVersion(",
      "  policyVersion: string,",
      "): PolicySnapshot;",
      "",
    ].join("\n"),
  );
  await symlink(
    path.join(docsRoot, "node_modules"),
    path.join(consumerRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(
    path.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          esModuleInterop: true,
          jsx: "react-jsx",
          lib: ["ES2023", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          noUncheckedIndexedAccess: true,
          paths: {
            "@opencookie-dev/astro": [
              path.join(repoRoot, "packages/adapters/astro/src/index.ts"),
            ],
            "@opencookie-dev/core": [
              path.join(repoRoot, "packages/core/src/index.ts"),
            ],
            "@opencookie-dev/core/application": [
              path.join(repoRoot, "packages/core/src/application.ts"),
            ],
            "@opencookie-dev/core/auto": [
              path.join(repoRoot, "packages/core/src/auto.ts"),
            ],
            "@opencookie-dev/core/domain": [
              path.join(repoRoot, "packages/core/src/domain.ts"),
            ],
            "@opencookie-dev/core/infrastructure": [
              path.join(repoRoot, "packages/core/src/infrastructure.ts"),
            ],
            "@opencookie-dev/core/reconciliation": [
              path.join(repoRoot, "packages/core/src/reconciliation.ts"),
            ],
            "@opencookie-dev/next": [
              path.join(repoRoot, "packages/adapters/next/src/index.ts"),
            ],
            "@opencookie-dev/nuxt": [
              path.join(repoRoot, "packages/adapters/nuxt/src/index.ts"),
            ],
            "@opencookie-dev/react": [
              path.join(repoRoot, "packages/adapters/react/src/index.ts"),
            ],
            "@opencookie-dev/svelte": [
              path.join(repoRoot, "packages/adapters/svelte/src/index.ts"),
            ],
            "@opencookie-dev/vanilla": [
              path.join(repoRoot, "packages/adapters/vanilla/src/index.ts"),
            ],
            "@opencookie-dev/vue": [
              path.join(repoRoot, "packages/adapters/vue/src/index.ts"),
            ],
            opencookie: [path.join(repoRoot, "packages/cli/src/index.ts")],
          },
          skipLibCheck: true,
          strict: true,
          target: "ES2023",
          types: ["node"],
        },
        exclude: ["node_modules"],
        include: ["**/*.ts", "**/*.tsx"],
      },
      null,
      2,
    )}\n`,
  );
  return consumerRoot;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}.`));
    });
  });
}

const tsc = path.join(docsRoot, "node_modules/.bin", `tsc${binExtension}`);
const tsx = path.join(docsRoot, "node_modules/.bin", `tsx${binExtension}`);

let temporaryDependencyLink = false;
let displayedSamplesRoot;
try {
  await lstat(rootNodeModules);
} catch (error) {
  if (!(error && typeof error === "object" && error.code === "ENOENT")) {
    throw error;
  }
  await symlink(
    path.join(docsRoot, "node_modules"),
    rootNodeModules,
    process.platform === "win32" ? "junction" : "dir",
  );
  temporaryDependencyLink = true;
}

try {
  await run(tsc, ["--project", path.join(docsRoot, "tsconfig.samples.json")]);
  console.log("Typechecked every complete documentation sample.");
  displayedSamplesRoot = await materializeDisplayedSamples();
  await run(tsc, [
    "--project",
    path.join(displayedSamplesRoot, "tsconfig.json"),
  ]);
  console.log("Typechecked every consumer-visible documentation module.");
  await run(tsx, [
    "--tsconfig",
    path.join(docsRoot, "tsconfig.samples.json"),
    path.join(repoRoot, "scripts/verify-docs-sample-runner.mjs"),
    path.join(docsRoot, "samples"),
  ]);
} finally {
  if (displayedSamplesRoot) {
    await rm(displayedSamplesRoot, { force: true, recursive: true });
  }
  if (temporaryDependencyLink) await unlink(rootNodeModules);
}
