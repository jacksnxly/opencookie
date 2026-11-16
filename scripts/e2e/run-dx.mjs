import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDxSelection } from "./dx-catalogue.mjs";
import { runPackedDx } from "./dx-runtime.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const forwarded = args[0] === "--" ? args.slice(1) : args;
  const definitions = parseDxSelection(forwarded);
  const artifactDirectory = path.join(repositoryRoot, "artifacts/dx");
  await mkdir(path.join(artifactDirectory, "screenshots"), {
    recursive: true,
  });
  const results = await runPackedDx({
    artifactDirectory,
    definitions,
    logger: console,
    repositoryRoot,
  });
  await writeFile(
    path.join(artifactDirectory, "results.json"),
    `${JSON.stringify({ results }, null, 2)}\n`,
  );
  console.log(
    `G6 packed DX PASS: ${String(results.length)} fresh consumers within 60000 ms each.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
