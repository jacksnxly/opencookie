#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  selectCandidateDirectory,
  checkCandidateManifest,
  manifestDigest,
} from "./verify-candidate-manifest-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function digestOf(path) {
  return createHash("sha256")
    .update(readFileSync(join(root, path)))
    .digest("hex");
}

/** The one candidate this repository is offering. */
function activeManifestPath() {
  const base = join(root, ".release");
  if (!existsSync(base)) {
    console.error(
      "[candidate] No candidate directory was found under .release.",
    );
    return undefined;
  }
  const names = readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const chosen = selectCandidateDirectory(names);
  if (!chosen.ok) {
    console.error(`[candidate] ${chosen.message}`);
    return undefined;
  }
  const path = join(base, chosen.name, "candidate-manifest.json");
  if (!existsSync(path)) {
    console.error(
      `[candidate] ${chosen.name} holds no candidate-manifest.json.`,
    );
    return undefined;
  }
  return path;
}

const path = process.argv[2] ?? activeManifestPath();
if (path === undefined) {
  process.exitCode = 1;
} else {
  const body = readFileSync(path, "utf8");
  const manifest = JSON.parse(body);
  const repository = {
    commitExists: (commit) => {
      try {
        execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
          cwd: root,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    fileDigest: digestOf,
    fileExists: (relative) => existsSync(join(root, relative)),
    treeOf: (commit) => git("rev-parse", `${commit}^{tree}`),
  };

  const issues = checkCandidateManifest(manifest, repository);
  const unchecked = Object.keys(manifest.artifacts?.packages ?? {}).filter(
    () => true,
  );
  if (issues.length > 0) {
    for (const issue of issues) console.error(`[candidate] ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Candidate ${manifest.candidate.commit} still matches this repository.`,
    );
    console.log(`Manifest digest: ${manifestDigest(body)}`);
    console.log(
      `Package tarballs recorded but not rebuilt here: ${String(unchecked.length)}. Re-pack to check them.`,
    );
    if (manifest.candidate.frozen !== true) {
      console.log(
        "This candidate is not frozen: a public release tag and published artifact digests need a maintainer to publish them.",
      );
    }
  }
}
