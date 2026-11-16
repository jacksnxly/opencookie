import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(fixtureDirectory, "..");
const repositoryDirectory = resolve(packageDirectory, "../../..");
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "opencookie-nuxt-consumer-"),
);
const packDirectory = join(temporaryDirectory, "packs");
const consumerDirectory = join(temporaryDirectory, "consumer");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, arguments_, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${arguments_.join(" ")} failed with ${signal ?? `exit ${String(code)}`}.`,
        ),
      );
    });
  });
}

async function packedTarball(packageName) {
  // pnpm names a scoped tarball scope-name-version.tgz, without the "@".
  const prefix = `${packageName.slice(1).replace("/", "-")}-`;
  const match = (await readdir(packDirectory)).find(
    (entry) => entry.startsWith(prefix) && entry.endsWith(".tgz"),
  );
  if (match === undefined) {
    throw new Error(`No packed tarball found for ${packageName}.`);
  }
  return join(packDirectory, match);
}

try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(consumerDirectory, { recursive: true });

  for (const packageName of [
    "@opencookie-dev/core",
    "@opencookie-dev/vue",
    "@opencookie-dev/nuxt",
  ]) {
    await run(pnpm, ["--filter", packageName, "build"], repositoryDirectory);
  }

  for (const relativePackageDirectory of [
    "packages/core",
    "packages/adapters/vue",
    "packages/adapters/nuxt",
  ]) {
    await run(
      pnpm,
      [
        "--dir",
        join(repositoryDirectory, relativePackageDirectory),
        "pack",
        "--pack-destination",
        packDirectory,
      ],
      repositoryDirectory,
    );
  }

  const sourceManifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  const coreTarball = await packedTarball("@opencookie-dev/core");
  const vueTarball = await packedTarball("@opencookie-dev/vue");
  const nuxtTarball = await packedTarball("@opencookie-dev/nuxt");
  const consumerManifest = {
    name: "opencookie-nuxt-packed-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      "@opencookie-dev/core": `file:${coreTarball}`,
      "@opencookie-dev/nuxt": `file:${nuxtTarball}`,
      "@opencookie-dev/vue": `file:${vueTarball}`,
      nuxt: sourceManifest.devDependencies.nuxt,
      vue: sourceManifest.devDependencies.vue,
    },
    devDependencies: {
      typescript: sourceManifest.devDependencies.typescript,
      "vue-tsc": sourceManifest.devDependencies["vue-tsc"],
    },
  };

  await writeFile(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(consumerManifest, null, 2)}\n`,
  );
  await writeFile(
    join(consumerDirectory, "pnpm-workspace.yaml"),
    [
      "packages:",
      '  - "."',
      "overrides:",
      `  "@opencookie-dev/core": ${JSON.stringify(`file:${coreTarball}`)}`,
      `  "@opencookie-dev/vue": ${JSON.stringify(`file:${vueTarball}`)}`,
      "",
    ].join("\n"),
  );
  for (const fixtureFile of [
    "app.vue",
    "nuxt.config.ts",
    "opencookie-store.ts",
    "tsconfig.json",
    "verify-build.mjs",
  ]) {
    await copyFile(
      join(fixtureDirectory, fixtureFile),
      join(consumerDirectory, fixtureFile),
    );
  }

  await run(
    pnpm,
    ["install", "--ignore-scripts", "--strict-peer-dependencies=false"],
    consumerDirectory,
  );
  await run(pnpm, ["exec", "nuxt", "generate"], consumerDirectory);
  await run(pnpm, ["exec", "nuxt", "typecheck"], consumerDirectory);
  await run(process.execPath, ["verify-build.mjs"], consumerDirectory);

  console.log(
    "Packed Nuxt consumer verification passed: install, root export, SSR, and injection types.",
  );
  await rm(temporaryDirectory, { recursive: true, force: true });
} catch (error) {
  console.error(`Failed packed consumer retained at ${temporaryDirectory}`);
  throw error;
}
