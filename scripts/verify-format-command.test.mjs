import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getFileInfo } from "prettier";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ignorePath = path.join(repositoryRoot, ".prettierignore");

test("the formatting gate uses an explicit generated-output policy", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );

  assert.equal(
    manifest.scripts["format:check"],
    'prettier "**/*.{js,mjs,cjs,ts,json,yaml,yml}" --check --ignore-path .prettierignore',
  );
});

test("the formatting policy excludes generated trees but keeps source checked", async () => {
  for (const relativePath of [
    "apps/docs/.astro/types.d.ts",
    "fixtures/next-app/.next/server/page.js",
    "fixtures/nuxt/.nuxt/nuxt.d.ts",
    "fixtures/nuxt/.output/server/index.mjs",
    "fixtures/sveltekit/.svelte-kit/generated/root.js",
    "fixtures/sveltekit/build/index.js",
    "pnpm-lock.yaml",
  ]) {
    const info = await getFileInfo(path.join(repositoryRoot, relativePath), {
      ignorePath,
    });
    assert.equal(info.ignored, true, `${relativePath} must be ignored`);
  }

  const sourceInfo = await getFileInfo(
    path.join(repositoryRoot, "packages/core/src/index.ts"),
    { ignorePath },
  );
  assert.equal(sourceInfo.ignored, false);
});

test("the formatting policy ignores the mutation cache the change tier keeps", async () => {
  // The mutation step writes this file and CI restores it before `format`
  // runs. `--ignore-path` replaces Prettier's default `.gitignore` lookup, so
  // `.prettierignore` has to name it. Stryker's documented default applies
  // unless the config names another file.
  const stryker = JSON.parse(
    await readFile(path.join(repositoryRoot, "stryker.config.json"), "utf8"),
  );
  const incrementalFile =
    stryker.incrementalFile ?? "reports/stryker-incremental.json";

  const info = await getFileInfo(path.join(repositoryRoot, incrementalFile), {
    ignorePath,
  });
  assert.equal(info.ignored, true, `${incrementalFile} must be ignored`);
});
