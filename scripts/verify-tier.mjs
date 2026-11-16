#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { selectTierSteps } from "./verify-tier-lib.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function parseArgs(argv) {
  const only = [];
  const skip = [];
  let list = false;
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--only" || arg === "--skip") {
      const id = argv[index + 1];
      if (id === undefined || id.startsWith("--")) {
        throw new Error(`${arg} requires a step id.`);
      }
      (arg === "--only" ? only : skip).push(id);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown argument ${arg}.`);
    positional.push(arg);
  }

  if (positional.length !== 1) {
    throw new Error(
      "Usage: node scripts/verify-tier.mjs <fast|change|release> [--only id]... [--skip id]... [--list]",
    );
  }

  return { list, only, skip, tier: positional[0] };
}

function formatDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${String(minutes)}m${seconds}s`;
}

function commandLine(verificationStep) {
  return [verificationStep.command, ...verificationStep.args].join(" ");
}

function runStep(verificationStep) {
  return new Promise((resolve) => {
    const child = spawn(verificationStep.command, verificationStep.args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.once("error", () => finish(1));
    child.once("exit", (code, signal) => {
      finish(signal === null ? (code ?? 1) : 1);
    });
  });
}

async function main() {
  const { list, only, skip, tier } = parseArgs(process.argv.slice(2));
  const selection = selectTierSteps(tier, { only, skip });

  if (list) {
    for (const verificationStep of selection.steps) {
      console.log(`${verificationStep.id} ${commandLine(verificationStep)}`);
    }
    return;
  }

  const started = Date.now();
  const total = selection.steps.length;
  for (const [index, verificationStep] of selection.steps.entries()) {
    console.log(
      `VERIFY ${tier} ${index + 1}/${String(total)}: ${verificationStep.id}`,
    );
    const stepStarted = Date.now();
    const code = await runStep(verificationStep);
    console.log(
      `... exit ${String(code)} in ${formatDuration(Date.now() - stepStarted)}`,
    );
    if (code !== 0) {
      process.exitCode = 1;
      return;
    }
  }

  const duration = formatDuration(Date.now() - started);
  if (selection.skipped.length > 0) {
    console.log(
      `VERIFY ${tier} PARTIAL: ${String(total)} steps passed in ${duration}; skipped: ${selection.skipped.join(", ")}`,
    );
    return;
  }
  console.log(`VERIFY ${tier} PASS: ${String(total)} steps in ${duration}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
