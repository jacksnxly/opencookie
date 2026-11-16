import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export const SCRIPT_TEST_EXCLUSIONS = Object.freeze([
  "scripts/e2e/native-safari-storage-harness.test.mjs",
]);

export async function listScriptTests() {
  const entries = await readdir(path.join(repositoryRoot, "scripts"), {
    recursive: true,
  });
  const excluded = new Set(SCRIPT_TEST_EXCLUSIONS);
  return entries
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".test.mjs"))
    .map((entry) => `scripts/${entry}`)
    .filter((file) => !excluded.has(file))
    .sort();
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const files = await listScriptTests();
  const child = spawn(
    process.execPath,
    ["--test", "--test-concurrency=1", ...files],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  child.once("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.once("exit", (code, signal) => {
    process.exit(signal === null ? (code ?? 1) : 1);
  });
}
