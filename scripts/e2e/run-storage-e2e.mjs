import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const verifierPath = fileURLToPath(
  new URL("./verify-storage-results.mjs", import.meta.url),
);

const BUILD_TARGETS = Object.freeze([
  "@opencookie-dev/core",
  "@opencookie-dev/vanilla",
  "@opencookie-dev/react",
  "@opencookie-fixtures/plain-cdn",
  "@opencookie-fixtures/react-vite",
]);

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

function optionValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument?.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
      continue;
    }
    if (argument !== name) continue;
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

function requireFixedAccounting(args) {
  const repeats = optionValues(args, "--repeat-each");
  if (repeats.some((value) => value !== "1")) {
    throw new Error("The storage suite requires repeatEach=1.");
  }
  const retries = optionValues(args, "--retries");
  if (retries.some((value) => value !== "0")) {
    throw new Error("The storage suite requires retries=0.");
  }
  if (optionValues(args, "--config").length > 0) {
    throw new Error("The storage suite owns its Playwright config.");
  }
  if (optionValues(args, "--project").length > 0) {
    throw new Error("The storage suite must run all three storage projects.");
  }
  if (args.length > 0) {
    throw new Error(
      "The canonical storage suite accepts no Playwright arguments.",
    );
  }
}

/** Builds and runs the standalone storage suite, then verifies its report. */
export async function runStorageE2E({ args = [], run = runProcess } = {}) {
  const playwrightArgs = args[0] === "--" ? args.slice(1) : [...args];
  requireFixedAccounting(playwrightArgs);
  for (const target of BUILD_TARGETS) {
    const exitCode = await run("pnpm", ["--filter", target, "build"]);
    if (exitCode !== 0) return exitCode;
  }
  const browserExitCode = await run("pnpm", [
    "exec",
    "playwright",
    "test",
    "--config=playwright.storage.config.ts",
    ...playwrightArgs,
  ]);
  if (browserExitCode !== 0) return browserExitCode;
  return run(process.execPath, [verifierPath]);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await runStorageE2E({ args: process.argv.slice(2) });
}
