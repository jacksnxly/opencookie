import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { E2E_TIERS } from "./project-matrix.mjs";

const verifierPath = fileURLToPath(
  new URL("./verify-results.mjs", import.meta.url),
);
const cookieRootPathTestPath = fileURLToPath(
  new URL("./cookie-root-path.test.mjs", import.meta.url),
);
const contractTitleBindingsTestPath = fileURLToPath(
  new URL("./contract-title-bindings.test.mjs", import.meta.url),
);

const DEFAULT_TIER = "change";

function runProcess(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

/**
 * Takes the runner's own flags out of the command line: `--tier=<tier>` (or
 * `--tier <tier>`, default change) and `--skip-build`. Everything else goes to
 * Playwright.
 */
function runnerOptions(args) {
  const playwrightArgs = [];
  const tiers = [];
  let skipBuild = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skip-build") {
      skipBuild = true;
    } else if (argument.startsWith("--tier=")) {
      tiers.push(argument.slice("--tier=".length));
    } else if (argument === "--tier") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new TypeError("--tier requires a value.");
      }
      tiers.push(value);
      index += 1;
    } else {
      playwrightArgs.push(argument);
    }
  }
  if (tiers.length > 1) {
    throw new TypeError(`--tier was given ${String(tiers.length)} times.`);
  }
  const tier = tiers[0] ?? DEFAULT_TIER;
  if (!E2E_TIERS.includes(tier)) {
    throw new TypeError(
      `Unknown E2E tier ${JSON.stringify(tier)}; expected one of: ${E2E_TIERS.join(", ")}.`,
    );
  }
  return { playwrightArgs, skipBuild, tier };
}

function expectedRepeats(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument?.startsWith("--repeat-each=")) {
      return Number.parseInt(argument.slice("--repeat-each=".length), 10);
    }
    if (argument === "--repeat-each") {
      return Number.parseInt(args[index + 1] ?? "", 10);
    }
  }
  return 1;
}

function projectPatterns(args) {
  const patterns = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument?.startsWith("--project=")) {
      patterns.push(argument.slice("--project=".length));
      continue;
    }
    if (argument === "--project") {
      const value = args[index + 1];
      if (value !== undefined) patterns.push(value);
      index += 1;
    }
  }
  return patterns;
}

/**
 * Runs one tier of the real browser matrix and verifies that its report is
 * complete. `--skip-build` trusts a build the caller has just made.
 */
export async function runE2E({
  args = [],
  env = process.env,
  run = runProcess,
} = {}) {
  const { playwrightArgs, skipBuild, tier } = runnerOptions(
    args[0] === "--" ? args.slice(1) : args,
  );
  const repeats = expectedRepeats(playwrightArgs);
  const selectedProjectPatterns = projectPatterns(playwrightArgs);
  if (!Number.isSafeInteger(repeats) || repeats < 1) {
    throw new TypeError("Playwright repeat count must be a positive integer.");
  }
  if (!skipBuild) {
    const productionBuildExitCode = await run("pnpm", ["build"]);
    if (productionBuildExitCode !== 0) return productionBuildExitCode;
  }
  const browserPreflightExitCode = await run(process.execPath, [
    "--test",
    contractTitleBindingsTestPath,
    cookieRootPathTestPath,
  ]);
  if (browserPreflightExitCode !== 0) return browserPreflightExitCode;
  const browserExitCode = await run(
    "pnpm",
    ["exec", "playwright", "test", ...playwrightArgs],
    { env: { ...env, OPENCOOKIE_E2E_TIER: tier } },
  );
  if (browserExitCode !== 0) return browserExitCode;
  return run(process.execPath, [
    verifierPath,
    "--tier",
    tier,
    ...selectedProjectPatterns.flatMap((pattern) => [
      "--project-pattern",
      pattern,
    ]),
    "--expected-repeats",
    String(repeats),
  ]);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await runE2E({ args: process.argv.slice(2) });
}
