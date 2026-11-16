// Rebinds every pinned CDN snippet to the drop-in the repository builds now.
// Run it after the vanilla version or the drop-in's bytes change; then
// `node scripts/verify-cdn-sri.mjs` proves the pins against the packed file.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CDN_BUILD_COMMAND,
  sha384Integrity,
  validateCdnIntegrityMetadata,
} from "./verify-cdn-sri-lib.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const METADATA_PATH = "packages/adapters/vanilla/cdn-integrity.json";
// The canonical sources verify-cdn-sri checks, and the tests that pin the
// snippet init generates.
const PINNED_FILES = Object.freeze([
  "packages/adapters/vanilla/README.md",
  "apps/docs/samples/cdn-one-line.sample.ts",
  "apps/docs/samples/subdomain-cdn.sample.ts",
  "fixtures/plain-cdn/index.html",
  "packages/cli/src/init.ts",
  "packages/cli/src/init.test.ts",
  "packages/cli/src/wiring.test.ts",
]);

const built = spawnSync(CDN_BUILD_COMMAND.command, CDN_BUILD_COMMAND.args, {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (built.status !== 0) throw new Error("The drop-in build failed.");

const read = (relative) =>
  readFile(path.join(repositoryRoot, relative), "utf8");
const previous = validateCdnIntegrityMetadata(
  JSON.parse(await read(METADATA_PATH)),
);
const { version } = JSON.parse(
  await read("packages/adapters/vanilla/package.json"),
);
const integrity = sha384Integrity(
  await readFile(
    path.join(repositoryRoot, "packages/adapters/vanilla", previous.file),
  ),
);
const oldUrl = `${previous.package}@${previous.version}/${previous.file}`;
const newUrl = `${previous.package}@${version}/${previous.file}`;

for (const relative of PINNED_FILES) {
  const source = await read(relative);
  const rebound = source
    .replaceAll(oldUrl, newUrl)
    .replaceAll(previous.integrity, integrity);
  if (rebound !== source) {
    await writeFile(path.join(repositoryRoot, relative), rebound);
  }
}
const metadata = validateCdnIntegrityMetadata({
  ...previous,
  integrity,
  version,
});
await writeFile(
  path.join(repositoryRoot, METADATA_PATH),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
console.log(`Rebound ${oldUrl} ${previous.integrity}`);
console.log(`     to ${newUrl} ${integrity}`);
