#!/usr/bin/env node

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

import {
  assertCanonicalCoreBuildArtifacts,
  assertDocumentedCoreConsumerGraphSizes,
  assertLiveSizeRatchet,
  describeBudgetGrowth,
  measureConfiguredArtifactSizes,
  SIZE_BUDGET_AXES,
  verifyCoreConsumerGraphs,
  verifyProgrammaticRouteGraphs,
} from "./verify-core-consumer-sizes-lib.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cacheRoot = path.join(repositoryRoot, ".cache");
const corePackageRoot = path.join(repositoryRoot, "packages/core");

await mkdir(cacheRoot, { recursive: true });
const temporaryDirectory = await mkdtemp(
  path.join(cacheRoot, "core-consumer-graphs-"),
);

try {
  const coreDistributionDirectory = path.join(temporaryDirectory, "core");
  await build({
    cwd: corePackageRoot,
    dts: false,
    logLevel: "silent",
    outDir: coreDistributionDirectory,
    sourcemap: false,
  });
  const coreAliases = {
    "@opencookie-dev/core/application": path.join(
      coreDistributionDirectory,
      "application.js",
    ),
    "@opencookie-dev/core/auto": path.join(
      coreDistributionDirectory,
      "auto.js",
    ),
    "@opencookie-dev/core/domain": path.join(
      coreDistributionDirectory,
      "domain.js",
    ),
    "@opencookie-dev/core/infrastructure": path.join(
      coreDistributionDirectory,
      "infrastructure.js",
    ),
    "@opencookie-dev/core/reconciliation": path.join(
      coreDistributionDirectory,
      "reconciliation.js",
    ),
    "@opencookie-dev/core": path.join(coreDistributionDirectory, "index.js"),
  };
  const coreBuildArtifacts = Object.fromEntries(
    await Promise.all(
      Object.values(coreAliases).map(async (entryPath) => [
        path.basename(entryPath),
        await readFile(entryPath, "utf8"),
      ]),
    ),
  );
  assertCanonicalCoreBuildArtifacts(coreBuildArtifacts);

  // One minified browser ESM bundle of an entry, with every OpenCookie
  // package inlined from its fresh build.
  const bundleEntry = async (graph, entryPath, alias) => {
    const safeName = graph.name.replaceAll(/[^a-z0-9]+/gu, "-");
    const outputDirectory = path.join(temporaryDirectory, safeName, "dist");
    await build({
      alias,
      clean: true,
      config: false,
      cwd: repositoryRoot,
      deps: { alwaysBundle: [/^@opencookie-dev\//u] },
      dts: false,
      entry: { graph: entryPath },
      fixedExtension: false,
      format: "esm",
      hash: false,
      logLevel: "silent",
      minify: true,
      outDir: outputDirectory,
      platform: "browser",
      sourcemap: false,
      target: "es2022",
    });
    const fileNames = await readdir(outputDirectory);
    const javaScriptFile = fileNames.find((fileName) =>
      fileName.endsWith(".js"),
    );
    return {
      code:
        javaScriptFile === undefined
          ? ""
          : await readFile(path.join(outputDirectory, javaScriptFile), "utf8"),
      fileNames,
    };
  };

  const results = await verifyCoreConsumerGraphs({
    bundle: async ({ graph, source }) => {
      const safeName = graph.name.replaceAll(/[^a-z0-9]+/gu, "-");
      const graphDirectory = path.join(temporaryDirectory, safeName);
      const entryPath = path.join(graphDirectory, "entry.mjs");
      await mkdir(graphDirectory, { recursive: true });
      await writeFile(entryPath, source);
      return bundleEntry(graph, entryPath, coreAliases);
    },
  });

  // Vanilla's own build, which `pnpm size` makes first, bundled with the
  // fresh core build above.
  const routeResults = await verifyProgrammaticRouteGraphs({
    bundle: ({ graph }) =>
      bundleEntry(graph, path.join(repositoryRoot, graph.entry), {
        ...coreAliases,
        "@opencookie-dev/vanilla": path.join(
          repositoryRoot,
          "packages/adapters/vanilla/dist/index.js",
        ),
      }),
  });

  const pinnedNodeMajor = Number.parseInt(
    (await readFile(path.join(repositoryRoot, ".node-version"), "utf8")).trim(),
    10,
  );
  const graphComparison = assertDocumentedCoreConsumerGraphSizes({
    documentation: await readFile(
      path.join(corePackageRoot, "README.md"),
      "utf8",
    ),
    pinnedNodeMajor,
    results,
    runningNodeMajor: Number.parseInt(process.versions.node, 10),
  });
  if (graphComparison?.compared === false) {
    console.warn(graphComparison.reason);
  }

  const sizeEntries = JSON.parse(
    await readFile(path.join(repositoryRoot, ".size-limit.json"), "utf8"),
  );
  const configuredPaths = [...new Set(sizeEntries.map((entry) => entry.path))];
  const artifactBytes = new Map(
    await Promise.all(
      configuredPaths.map(async (relativePath) => [
        relativePath,
        await readFile(path.join(repositoryRoot, relativePath)),
      ]),
    ),
  );
  const artifactResults = measureConfiguredArtifactSizes({
    artifactBytes,
    entries: sizeEntries,
  });
  const pinnedNodeVersion = (
    await readFile(path.join(repositoryRoot, ".node-version"), "utf8")
  ).trim();
  const routeAxes = routeResults.flatMap((result) => [
    {
      limitBytes: result.limitBytes,
      measuredBytes: result.gzipBytes,
      name: result.name,
    },
    {
      limitBytes: result.rawLimitBytes,
      measuredBytes: result.rawBytes,
      name: `${result.name} raw`,
    },
  ]);
  const measuredAxes = [...artifactResults, ...routeAxes];
  const ratchet = assertLiveSizeRatchet({
    artifactResults: measuredAxes,
    graphResults: results,
    pinnedNodeVersion,
    runningNodeVersion: process.versions.node,
  });
  if (!ratchet.excessSlackCompared) {
    console.warn(
      `Live one-percent headroom was not compared because Node ${process.versions.node} does not exactly match canonical Node ${pinnedNodeVersion}. Hard caps remain enforced.`,
    );
  }

  for (const result of results) {
    console.log(
      `${result.name}: ${String(result.rawBytes)} raw bytes, ${String(result.gzipBytes)} gzip bytes, ${String(result.limitBytes)} byte cap.`,
    );
  }
  for (const result of routeResults) {
    console.log(
      `${result.name}: ${String(result.rawBytes)} raw bytes of a ${String(result.rawLimitBytes)} byte cap, ${String(result.gzipBytes)} gzip bytes of a ${String(result.limitBytes)} byte cap.`,
    );
  }
  for (const name of SIZE_BUDGET_AXES) {
    const axis = measuredAxes.find((item) => item.name === name);
    if (
      axis === undefined ||
      !Number.isSafeInteger(axis.measuredBytes) ||
      !Number.isSafeInteger(axis.limitBytes)
    ) {
      throw new Error(`Budget report is missing ${name}.`);
    }
    console.log(
      describeBudgetGrowth({
        limitBytes: axis.limitBytes,
        measuredBytes: axis.measuredBytes,
        name,
      }),
    );
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
