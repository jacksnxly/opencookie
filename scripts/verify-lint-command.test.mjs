import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the root lint command keeps package configs inside compatible ESLint runtimes", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const lintCommand = manifest.scripts.lint;

  assert.match(lintCommand, /eslint --config eslint\.config\.mjs \./u);
  assert.match(
    lintCommand,
    /pnpm --filter @opencookie-fixtures\/next-app lint/u,
  );
  assert.match(
    lintCommand,
    /pnpm --filter @opencookie-fixtures\/next-pages lint/u,
  );
});

test("the root config ignores generated framework output", async () => {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: path.join(root, "eslint.config.mjs"),
  });

  for (const generatedPath of [
    "fixtures/next-app/.next/server/app.js",
    "fixtures/sveltekit/.svelte-kit/generated/server/internal.js",
    "fixtures/sveltekit/build/server/index.js",
  ]) {
    assert.equal(
      await eslint.isPathIgnored(path.join(root, generatedPath)),
      true,
      `${generatedPath} must stay outside the root lint scope`,
    );
  }
});
