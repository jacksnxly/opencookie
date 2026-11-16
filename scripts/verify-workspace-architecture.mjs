#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import cruiseConfig from "../.dependency-cruiser.mjs";
import { validateArchitectureModel } from "./verify-workspace-architecture-lib.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function repositoryPath(path) {
  return relative(rootDir, path).replaceAll("\\", "/");
}

function pathStats(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function hasPackageManifest(directory, symlinks) {
  const manifestPath = join(directory, "package.json");
  const stats = pathStats(manifestPath);
  if (stats?.isSymbolicLink() === true) {
    symlinks.add(repositoryPath(manifestPath));
    return false;
  }
  return stats?.isFile() === true;
}

function packageDirectories() {
  const packagesRoot = join(rootDir, "packages");
  const directories = [];
  const symlinks = new Set();

  const rootStats = pathStats(packagesRoot);
  if (rootStats?.isSymbolicLink() === true) {
    symlinks.add(repositoryPath(packagesRoot));
    return { directories, symlinks: [...symlinks] };
  }
  if (rootStats?.isDirectory() !== true) {
    return { directories, symlinks: [...symlinks] };
  }

  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    const direct = join(packagesRoot, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks.add(repositoryPath(direct));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (hasPackageManifest(direct, symlinks)) {
      directories.push(direct);
      continue;
    }
    if (repositoryPath(direct) !== "packages/adapters") continue;
    for (const nested of readdirSync(direct, { withFileTypes: true })) {
      const candidate = join(direct, nested.name);
      if (nested.isSymbolicLink()) {
        symlinks.add(repositoryPath(candidate));
        continue;
      }
      if (nested.isDirectory() && hasPackageManifest(candidate, symlinks)) {
        directories.push(candidate);
      }
    }
  }

  return { directories: directories.sort(), symlinks: [...symlinks].sort() };
}

function workspacePackagePatterns() {
  const source = readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf8");
  const patterns = [];
  const errors = [];
  let inPackages = false;
  let foundPackages = false;

  for (const line of source.split(/\r?\n/u)) {
    if (!inPackages) {
      if (/^packages:\s*(?:#.*)?$/u.test(line)) {
        inPackages = true;
        foundPackages = true;
      }
      continue;
    }
    if (/^\S/u.test(line)) break;
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const match = line.match(/^\s+-\s+(.+?)\s*$/u);
    if (match === null) {
      errors.push(`unsupported packages entry ${JSON.stringify(line.trim())}`);
      continue;
    }
    let pattern = match[1];
    if (
      (pattern.startsWith('"') && pattern.endsWith('"')) ||
      (pattern.startsWith("'") && pattern.endsWith("'"))
    ) {
      pattern = pattern.slice(1, -1);
    }
    patterns.push(pattern);
  }

  if (!foundPackages) errors.push("pnpm-workspace.yaml has no packages list");
  if (patterns.length === 0) {
    errors.push("pnpm-workspace.yaml has no workspace package patterns");
  }
  return { errors, patterns };
}

function expandWorkspacePackageInventory() {
  const { errors, patterns } = workspacePackagePatterns();
  const directories = new Set();
  const symlinks = new Set();

  for (const originalPattern of patterns) {
    const pattern = originalPattern.replace(/^\.\//u, "");
    const segments = pattern.split("/");
    if (
      pattern.startsWith("/") ||
      /^[a-z]:[/\\]/iu.test(pattern) ||
      pattern.startsWith("!") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === ".." ||
          (segment !== "*" && !/^[a-z0-9@._-]+$/iu.test(segment)),
      )
    ) {
      errors.push(
        `unsupported workspace pattern ${JSON.stringify(originalPattern)}`,
      );
      continue;
    }

    let candidates = [rootDir];
    for (const segment of segments) {
      const next = [];
      for (const base of candidates) {
        if (segment === "*") {
          const baseStats = pathStats(base);
          if (baseStats?.isDirectory() !== true) continue;
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            const candidate = join(base, entry.name);
            if (entry.isSymbolicLink()) {
              symlinks.add(repositoryPath(candidate));
            } else if (entry.isDirectory()) {
              next.push(candidate);
            }
          }
        } else {
          const candidate = join(base, segment);
          const stats = pathStats(candidate);
          if (stats?.isSymbolicLink() === true) {
            symlinks.add(repositoryPath(candidate));
          } else if (stats?.isDirectory() === true) {
            next.push(candidate);
          }
        }
      }
      candidates = next;
    }

    for (const candidate of candidates) {
      if (hasPackageManifest(candidate, symlinks)) {
        directories.add(repositoryPath(candidate));
      }
    }
  }

  return {
    directories: [...directories].sort(),
    errors: [...new Set(errors)].sort(),
    symlinks: [...symlinks].sort(),
  };
}

function sourceEntries(sourcePath) {
  const stats = lstatSync(sourcePath);
  if (stats.isSymbolicLink()) {
    return [{ path: repositoryPath(sourcePath), isSymbolicLink: true }];
  }
  if (stats.isDirectory()) {
    return readdirSync(sourcePath)
      .sort()
      .flatMap((entry) => sourceEntries(join(sourcePath, entry)));
  }
  if (!/[.](?:[cm]?[jt]sx?)$/u.test(sourcePath)) return [];
  return [
    {
      path: repositoryPath(sourcePath),
      source: readFileSync(sourcePath, "utf8"),
      isSymbolicLink: false,
    },
  ];
}

const discoveredPackages = packageDirectories();
const workspaceInventory = expandWorkspacePackageInventory();
const packageDirectoryList = discoveredPackages.directories;
const packages = packageDirectoryList.map((directory) => {
  const etcDirectory = join(directory, "etc");
  const apiReportNames = existsSync(etcDirectory)
    ? readdirSync(etcDirectory)
        .filter((name) => name.endsWith(".api.md"))
        .sort()
    : [];
  const apiExtractorConfigNames = readdirSync(directory)
    .filter((name) => /^api-extractor(?:\.[a-z0-9-]+)?\.json$/u.test(name))
    .sort();

  return {
    apiExtractorConfigNames,
    apiReportNames,
    directory: repositoryPath(directory),
    manifest: readJson(join(directory, "package.json")),
    hasApiExtractorConfig: apiExtractorConfigNames.length > 0,
    hasApiReport: apiReportNames.length > 0,
    hasTsconfig: existsSync(join(directory, "tsconfig.json")),
  };
});

const browserProductionSources = packageDirectoryList
  .filter((directory) => {
    const packagePath = repositoryPath(directory);
    return (
      packagePath === "packages/core" ||
      packagePath.startsWith("packages/adapters/")
    );
  })
  .flatMap((directory) => sourceEntries(join(directory, "src")))
  .sort((left, right) => left.path.localeCompare(right.path));

const result = validateArchitectureModel({
  browserProductionSources,
  packages,
  cruiseConfig,
  sizeConfig: readJson(join(rootDir, ".size-limit.json")),
  workspaceInventoryErrors: workspaceInventory.errors,
  workspacePackageDirectories: workspaceInventory.directories.filter(
    (directory) => directory.startsWith("packages/"),
  ),
  workspacePackageSymlinks: [
    ...new Set([
      ...discoveredPackages.symlinks,
      ...workspaceInventory.symlinks,
    ]),
  ].sort(),
});

console.log(
  `Architecture manifest verification passed: ${result.packageCount} packages, ${result.ruleCount} enforced rules, ${result.apiReportCount} API reports, ${result.sizeBudgetCount} size budgets. Browser source counts: ${Object.entries(
    result.browserSourceCounts,
  )
    .map(([name, count]) => `${name}=${count}`)
    .join(", ")}.`,
);
