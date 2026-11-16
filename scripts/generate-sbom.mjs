#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runtimeClosureOf,
  shippedPackages,
  spdxDocument,
} from "./generate-sbom-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pnpm(...args) {
  return execFileSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Every third-party package that ships in a published artifact's runtime. */
function runtimeClosure(name) {
  return runtimeClosureOf(
    JSON.parse(
      pnpm("list", "--prod", "--depth", "Infinity", "--json", "--filter", name),
    ),
    // A platform binary not installed on this machine has no manifest here,
    // and it declares no peers either.
    (path) =>
      path === undefined || !existsSync(join(path, "package.json"))
        ? undefined
        : JSON.parse(readFileSync(join(path, "package.json"), "utf8")),
  );
}

function licenceIndex() {
  const groups = JSON.parse(pnpm("licenses", "list", "--json", "--prod"));
  const index = new Map();
  for (const [licence, entries] of Object.entries(groups)) {
    for (const entry of entries) {
      for (const version of entry.versions ?? []) {
        index.set(`${entry.name}@${version}`, licence);
      }
    }
  }
  return index;
}

const packs = process.argv[2];
const output = process.argv[3] ?? join(root, "sbom.spdx.json");
const licences = licenceIndex();
const shipped = shippedPackages(root, (path) =>
  JSON.parse(readFileSync(path, "utf8")),
);

const thirdParty = new Map();
for (const entry of shipped) {
  for (const [key, value] of runtimeClosure(entry.name)) {
    thirdParty.set(key, value);
  }
}

const checksums = new Map();
if (packs !== undefined) {
  for (const entry of shipped) {
    const file = join(
      packs,
      `${entry.name.replace("@", "").replace("/", "-")}-${entry.version}.tgz`,
    );
    if (existsSync(file)) {
      checksums.set(
        entry.name,
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      );
    }
  }
}

const body = `${JSON.stringify(
  spdxDocument({
    checksums,
    // The commit's own time, so the same commit always yields the same bytes.
    created: new Date(
      execFileSync("git", ["log", "-1", "--format=%cI", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    )
      .toISOString()
      .replace(/\.\d{3}Z$/u, "Z"),
    licences,
    shipped,
    thirdParty,
  }),
  undefined,
  2,
)}\n`;
writeFileSync(output, body);
// The repository formats every committed JSON file, so the generator formats
// its own output: regenerating must not leave the tree dirty.
execFileSync("npx", ["prettier", "--write", output], {
  cwd: root,
  stdio: "ignore",
});
const formatted = readFileSync(output, "utf8");
console.log(
  `SBOM written: ${String(shipped.length)} published packages, ${String(thirdParty.size)} third-party runtime packages.`,
);
console.log(`Digest: ${createHash("sha256").update(formatted).digest("hex")}`);
