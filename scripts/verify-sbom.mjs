#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkShippedLicences } from "./generate-sbom-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function latest() {
  const base = join(root, ".release");
  if (!existsSync(base)) return undefined;
  return readdirSync(base, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("candidate-"),
    )
    .map((entry) => join(base, entry.name, "sbom.spdx.json"))
    .filter((path) => existsSync(path))
    .sort()
    .at(-1);
}

const path = process.argv[2] ?? latest();
if (path === undefined) {
  console.error("No SBOM was found under .release.");
  process.exitCode = 1;
} else {
  const body = readFileSync(path, "utf8");
  const document = JSON.parse(body);
  const issues = checkShippedLicences(document.packages ?? []);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`[sbom] ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(
      `${String(document.packages.length)} packages ship, every one under a permissive licence or an uninstalled platform binary.`,
    );
    console.log(
      `SBOM digest: ${createHash("sha256").update(body).digest("hex")}`,
    );
  }
}
