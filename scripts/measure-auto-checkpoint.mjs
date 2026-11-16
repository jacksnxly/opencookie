#!/usr/bin/env node
/**
 * Historical manual gzip checkpoint for the dedicated /auto core product.
 *
 * Bundles the auto-only composition graph (the auto factory plus the
 * storage, GPC, Google, enforcement, and kernel modules it statically
 * needs) straight from TypeScript source into a minified IIFE and reports
 * raw and gzip -9 bytes next to the generic root source graph. The
 * original pre-lifecycle checkpoint was at most 19,000 gzip bytes. The
 * current size budgets supersede every limit reported by this experiment. This script
 * is not a release gate and must not be used to reinterpret the current
 * canonical accounting.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, gzipSync } from "node:zlib";

const AUTO_CHECKPOINT_GZIP_LIMIT = 19_000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = resolve(root, "packages/core/src");

const coreRequire = createRequire(resolve(root, "packages/core/package.json"));
const tsdownRequire = createRequire(coreRequire.resolve("tsdown/package.json"));
const rolldownEntry = tsdownRequire.resolve("rolldown");
const { rolldown } = await import(pathToFileURL(rolldownEntry).href);

function entryUrl(relativePath) {
  return pathToFileURL(resolve(srcRoot, relativePath)).href;
}

async function measure(label, virtualSource) {
  const bundle = await rolldown({
    input: "checkpoint:entry",
    platform: "neutral",
    plugins: [
      {
        name: "checkpoint-virtual-entry",
        load(id) {
          return id === "checkpoint:entry" ? virtualSource : undefined;
        },
        resolveId(id) {
          return id === "checkpoint:entry" ? id : undefined;
        },
      },
    ],
  });
  const { output } = await bundle.generate({
    format: "iife",
    minify: true,
    name: "OpenCookieCheckpoint",
  });
  await bundle.close();
  const code = output[0].code;
  const raw = Buffer.byteLength(code, "utf8");
  const gzip = gzipSync(Buffer.from(code, "utf8"), {
    level: constants.Z_BEST_COMPRESSION,
  }).byteLength;
  console.log(
    `${label}: raw ${String(raw)} bytes, gzip-9 ${String(gzip)} bytes`,
  );
  return { gzip, raw };
}

const auto = await measure(
  "auto-only source graph (minified IIFE)",
  [
    `import { createAutoOpenCookieFactory } from ${JSON.stringify(entryUrl("auto.ts"))};`,
    "globalThis.__openCookieAutoCheckpoint = createAutoOpenCookieFactory;",
  ].join("\n"),
);

await measure(
  "generic root source graph (minified IIFE)",
  `export * from ${JSON.stringify(entryUrl("index.ts"))};`,
);

if (auto.gzip > AUTO_CHECKPOINT_GZIP_LIMIT) {
  console.error(
    `Checkpoint RED: the auto graph is ${String(
      auto.gzip - AUTO_CHECKPOINT_GZIP_LIMIT,
    )} gzip bytes above the ${String(AUTO_CHECKPOINT_GZIP_LIMIT)} byte target.`,
  );
  process.exit(1);
}
console.log(
  `Checkpoint GREEN: the auto graph is within the ${String(
    AUTO_CHECKPOINT_GZIP_LIMIT,
  )} gzip byte target.`,
);
