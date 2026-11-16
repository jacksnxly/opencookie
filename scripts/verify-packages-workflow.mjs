import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PackageVerificationError,
  assertLoopbackRegistryUrl,
  attwProfileForManifest,
  rewriteWorkspaceDependencies,
  sortPackagesForPublication,
  usingTemporaryDirectory,
  validatePackageModuleFormatContract,
  validateVerdaccioConfiguration,
  withDisposableRegistry,
} from "./verify-packages-lib.mjs";

const VERDACCIO_CONFIGURATION = path.join(
  "config",
  "verdaccio.package-verification.json",
);
const IGNORED_PACKAGE_DIRECTORIES = new Set([".git", "dist", "node_modules"]);
const IGNORED_STAGING_DIRECTORIES = new Set([".git", "node_modules"]);

export async function discoverPublicPackages(repositoryRoot) {
  const packagesRoot = path.join(repositoryRoot, "packages");
  const discoveredPackages = [];

  try {
    await visitPackageDirectory(packagesRoot, discoveredPackages);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  discoveredPackages.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );

  if (discoveredPackages.length === 0) {
    throw new PackageVerificationError(
      "No public packages found. Mark release packages as non-private before running pnpm verify:packages.",
    );
  }

  const names = new Set();
  for (const packageRecord of discoveredPackages) {
    if (names.has(packageRecord.manifest.name)) {
      throw new PackageVerificationError(
        `Duplicate public package name: ${packageRecord.manifest.name}.`,
      );
    }
    names.add(packageRecord.manifest.name);
  }

  return discoveredPackages;
}

export async function parsePackResult(output, tarballDirectory) {
  let packResults;
  try {
    packResults = JSON.parse(output);
  } catch (error) {
    throw new PackageVerificationError(
      "npm pack did not report a single exact tarball as JSON.",
      { cause: error },
    );
  }

  const filename = packResults?.[0]?.filename;
  if (
    !Array.isArray(packResults) ||
    packResults.length !== 1 ||
    typeof filename !== "string" ||
    path.basename(filename) !== filename ||
    !filename.endsWith(".tgz")
  ) {
    throw new PackageVerificationError(
      "npm pack must report a single exact tarball inside the verifier output directory.",
    );
  }

  const resolvedDirectory = path.resolve(tarballDirectory);
  const tarballPath = path.resolve(resolvedDirectory, filename);
  if (path.dirname(tarballPath) !== resolvedDirectory) {
    throw new PackageVerificationError(
      "npm pack must report a single exact tarball inside the verifier output directory.",
    );
  }

  let tarballStats;
  try {
    tarballStats = await lstat(tarballPath);
  } catch (error) {
    throw new PackageVerificationError(
      `npm pack reported a tarball that does not exist: ${filename}.`,
      { cause: error },
    );
  }
  if (!tarballStats.isFile()) {
    throw new PackageVerificationError(
      `npm pack output is not a regular tarball file: ${filename}.`,
    );
  }

  return tarballPath;
}

export async function runPackageVerification({
  logger = console,
  repositoryRoot,
  runCommand = executeCommand,
  startRegistry = startVerdaccio,
  temporaryDirectoryResources = defaultTemporaryDirectoryResources,
}) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const publicPackages = sortPackagesForPublication(
    await discoverPublicPackages(resolvedRepositoryRoot),
  );
  const verdaccioConfiguration = await readVerdaccioConfiguration(
    path.join(resolvedRepositoryRoot, VERDACCIO_CONFIGURATION),
  );

  await runCommand("pnpm", ["build"], { cwd: resolvedRepositoryRoot });

  return usingTemporaryDirectory(
    temporaryDirectoryResources,
    async (temporaryDirectory) => {
      const tarballDirectory = path.join(temporaryDirectory, "tarballs");
      const stagingDirectory = path.join(temporaryDirectory, "staging");
      await mkdir(tarballDirectory, { recursive: true });
      await mkdir(stagingDirectory, { recursive: true });

      const publishedVersions = new Map(
        publicPackages.map(({ manifest }) => [manifest.name, manifest.version]),
      );
      const tarballByPackageName = new Map();
      const usedTarballPaths = new Set();

      for (const [index, packageRecord] of publicPackages.entries()) {
        const stagedPackageDirectory = await stagePackage({
          destination: path.join(
            stagingDirectory,
            `${String(index).padStart(2, "0")}-${safePathSegment(
              packageRecord.manifest.name,
            )}`,
          ),
          packageRecord,
          publishedVersions,
        });
        const packResult = await runCommand(
          "npm",
          [
            "pack",
            ".",
            "--json",
            "--pack-destination",
            tarballDirectory,
            "--ignore-scripts",
          ],
          { captureOutput: true, cwd: stagedPackageDirectory },
        );
        const tarballPath = await parsePackResult(
          packResult.stdout,
          tarballDirectory,
        );
        if (usedTarballPaths.has(tarballPath)) {
          throw new PackageVerificationError(
            `npm pack reused an output tarball path: ${path.basename(tarballPath)}.`,
          );
        }
        usedTarballPaths.add(tarballPath);
        tarballByPackageName.set(packageRecord.manifest.name, tarballPath);
      }

      for (const packageRecord of publicPackages) {
        const tarballPath = tarballByPackageName.get(
          packageRecord.manifest.name,
        );
        await runCommand("pnpm", ["exec", "publint", tarballPath, "--strict"], {
          cwd: resolvedRepositoryRoot,
        });
        await runCommand(
          "pnpm",
          [
            "exec",
            "attw",
            tarballPath,
            "--profile",
            attwProfileForManifest(packageRecord.manifest),
          ],
          { cwd: resolvedRepositoryRoot },
        );
      }

      return withDisposableRegistry(
        () =>
          startRegistry({
            configuration: verdaccioConfiguration,
            repositoryRoot: resolvedRepositoryRoot,
            temporaryDirectory,
          }),
        async ({ url: registryUrl }) => {
          const npmConfiguration = await writeIsolatedNpmConfiguration(
            temporaryDirectory,
            registryUrl,
          );

          for (const packageRecord of publicPackages) {
            await runCommand(
              "npm",
              [
                "publish",
                tarballByPackageName.get(packageRecord.manifest.name),
                "--registry",
                registryUrl,
                "--userconfig",
                npmConfiguration.userConfigurationPath,
                "--globalconfig",
                npmConfiguration.globalConfigurationPath,
                "--cache",
                npmConfiguration.cacheDirectory,
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--provenance=false",
                "--access",
                "public",
              ],
              {
                cwd: temporaryDirectory,
                env: isolatedNpmEnvironment(
                  registryUrl,
                  npmConfiguration.globalConfigurationPath,
                  npmConfiguration.userConfigurationPath,
                ),
              },
            );
          }

          const consumers = await writeConsumerFixtures(
            temporaryDirectory,
            publicPackages,
          );
          for (const consumer of consumers) {
            await runCommand(
              "npm",
              [
                "install",
                "--registry",
                registryUrl,
                "--userconfig",
                npmConfiguration.userConfigurationPath,
                "--globalconfig",
                npmConfiguration.globalConfigurationPath,
                "--cache",
                npmConfiguration.cacheDirectory,
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--legacy-peer-deps",
                "--package-lock=false",
              ],
              {
                cwd: consumer.directory,
                env: isolatedNpmEnvironment(
                  registryUrl,
                  npmConfiguration.globalConfigurationPath,
                  npmConfiguration.userConfigurationPath,
                ),
              },
            );
            await linkExternalPeerDependencies({
              consumerDirectory: consumer.directory,
              packages: publicPackages,
              repositoryRoot: resolvedRepositoryRoot,
            });
            const consumerArguments =
              consumer.name === "types" || consumer.name === "types-cjs"
                ? [
                    path.join(
                      resolvedRepositoryRoot,
                      "node_modules",
                      "typescript",
                      "bin",
                      "tsc",
                    ),
                    "--project",
                    path.join(consumer.directory, "tsconfig.json"),
                  ]
                : [consumer.scriptPath];
            await runCommand(process.execPath, consumerArguments, {
              cwd: consumer.directory,
            });
          }

          const packageNames = publicPackages.map(
            ({ manifest }) => manifest.name,
          );
          logger.log(
            `Verified ${packageNames.length} package tarballs through ${consumers.length} disposable consumers.`,
          );
          return {
            packageNames,
            tarballs: packageNames.map((packageName) =>
              path.basename(tarballByPackageName.get(packageName)),
            ),
          };
        },
      );
    },
  );
}

async function visitPackageDirectory(directory, discoveredPackages) {
  const entries = await readdir(directory, { withFileTypes: true });
  const packageManifestEntry = entries.find(
    (entry) => entry.isFile() && entry.name === "package.json",
  );

  if (packageManifestEntry !== undefined) {
    const manifestPath = path.join(directory, packageManifestEntry.name);
    const manifest = await readJsonFile(manifestPath, "package manifest");
    if (
      Object.hasOwn(manifest, "private") &&
      typeof manifest.private !== "boolean"
    ) {
      throw new PackageVerificationError(
        `Package manifest private field must be boolean: ${manifestPath}.`,
      );
    }
    if (manifest.private !== true) {
      validatePublicManifest(manifest, manifestPath);
      discoveredPackages.push({ directory, manifest, manifestPath });
    }
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && !IGNORED_PACKAGE_DIRECTORIES.has(entry.name)) {
      await visitPackageDirectory(
        path.join(directory, entry.name),
        discoveredPackages,
      );
    }
  }
}

function validatePublicManifest(manifest, manifestPath) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0
  ) {
    throw new PackageVerificationError(
      `Public package manifest must define non-empty name and version fields: ${manifestPath}.`,
    );
  }
  validatePackageModuleFormatContract(manifest);
}

async function readVerdaccioConfiguration(configurationPath) {
  const configuration = await readJsonFile(
    configurationPath,
    "Verdaccio configuration",
  );
  validateVerdaccioConfiguration(configuration);
  return configuration;
}

async function readJsonFile(filePath, description) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new PackageVerificationError(
      `Unable to read ${description} at ${filePath}.`,
      { cause: error },
    );
  }
}

async function stagePackage({ destination, packageRecord, publishedVersions }) {
  await cp(packageRecord.directory, destination, {
    filter: (sourcePath) => {
      const relativePath = path.relative(packageRecord.directory, sourcePath);
      return !relativePath
        .split(path.sep)
        .some((segment) => IGNORED_STAGING_DIRECTORIES.has(segment));
    },
    recursive: true,
  });

  const manifest = rewriteWorkspaceDependencies(
    packageRecord.manifest,
    publishedVersions,
  );
  if (
    manifest.publishConfig !== null &&
    typeof manifest.publishConfig === "object" &&
    !Array.isArray(manifest.publishConfig)
  ) {
    delete manifest.publishConfig.registry;
  }
  await writeFile(
    path.join(destination, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return destination;
}

async function writeIsolatedNpmConfiguration(temporaryDirectory, registryUrl) {
  const safeRegistryUrl = assertLoopbackRegistryUrl(registryUrl);
  const parsedRegistryUrl = new URL(safeRegistryUrl);
  const localPublishToken = randomBytes(24).toString("base64url");
  const npmDirectory = path.join(temporaryDirectory, "npm");
  const cacheDirectory = path.join(npmDirectory, "cache");
  const globalConfigurationPath = path.join(npmDirectory, "global-npmrc");
  const userConfigurationPath = path.join(npmDirectory, "npmrc");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(globalConfigurationPath, "");
  await writeFile(
    userConfigurationPath,
    [
      `registry=${safeRegistryUrl}`,
      `@opencookie-dev:registry=${safeRegistryUrl}`,
      `//${parsedRegistryUrl.host}${parsedRegistryUrl.pathname}:_authToken=${localPublishToken}`,
      "audit=false",
      "fund=false",
      "ignore-scripts=true",
      "provenance=false",
      "update-notifier=false",
      "",
    ].join("\n"),
  );
  return {
    cacheDirectory,
    globalConfigurationPath,
    userConfigurationPath,
  };
}

function isolatedNpmEnvironment(
  registryUrl,
  globalConfigurationPath,
  userConfigurationPath,
) {
  const safeRegistryUrl = assertLoopbackRegistryUrl(registryUrl);
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^npm_config_/iu.test(key) &&
        !/^(?:node_auth_token|npm_token|yarn_npm_auth_token)$/iu.test(key),
    ),
  );
  return {
    ...inheritedEnvironment,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: globalConfigurationPath,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_REGISTRY: safeRegistryUrl,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: userConfigurationPath,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

async function writeConsumerFixtures(temporaryDirectory, packages) {
  const consumerRoot = path.join(temporaryDirectory, "consumers");
  const packageDependencies = Object.fromEntries(
    packages.map(({ manifest }) => [manifest.name, manifest.version]),
  );
  const importPackages = packages
    .filter(({ manifest }) => supportsExportCondition(manifest, "import"))
    .map(({ manifest }) => manifest.name);
  const requirePackages = packages
    .filter(({ manifest }) => supportsExportCondition(manifest, "require"))
    .map(({ manifest }) => manifest.name);
  const plainScriptPackages = packages
    .filter(
      ({ manifest }) =>
        typeof manifest.unpkg === "string" ||
        typeof manifest.jsdelivr === "string",
    )
    .map(({ manifest }) => ({
      globalName:
        manifest.name === "@opencookie-dev/vanilla" ? "OpenCookie" : undefined,
      name: manifest.name,
      script: manifest.unpkg ?? manifest.jsdelivr,
    }));

  if (importPackages.length === 0 || requirePackages.length === 0) {
    throw new PackageVerificationError(
      "Public packages must promise both ESM import and CommonJS require entry points.",
    );
  }
  if (
    plainScriptPackages.length === 0 ||
    plainScriptPackages.some(({ globalName }) => globalName === undefined)
  ) {
    throw new PackageVerificationError(
      "A plain-script package must declare an expected browser global; @opencookie-dev/vanilla uses OpenCookie.",
    );
  }

  const fixtures = [
    {
      name: "esm",
      packageManifest: {
        dependencies: packageDependencies,
        name: "opencookie-esm-consumer",
        private: true,
        type: "module",
        version: "0.0.0",
      },
      scriptFilename: "smoke.mjs",
      scriptSource: createEsmConsumer(importPackages),
    },
    {
      name: "cjs",
      packageManifest: {
        dependencies: packageDependencies,
        name: "opencookie-cjs-consumer",
        private: true,
        type: "commonjs",
        version: "0.0.0",
      },
      scriptFilename: "smoke.cjs",
      scriptSource: createCjsConsumer(requirePackages),
    },
    {
      name: "types",
      packageManifest: {
        dependencies: packageDependencies,
        name: "opencookie-types-consumer",
        private: true,
        type: "module",
        version: "0.0.0",
      },
      scriptFilename: "smoke.ts",
      scriptSource: createTypeConsumer(),
      tsconfig: {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
        },
        files: ["smoke.ts"],
      },
    },
    {
      name: "types-cjs",
      packageManifest: {
        dependencies: packageDependencies,
        name: "opencookie-types-cjs-consumer",
        private: true,
        type: "commonjs",
        version: "0.0.0",
      },
      scriptFilename: "smoke.cts",
      scriptSource: createCommonJsTypeConsumer(),
      tsconfig: {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: "ES2022",
        },
        files: ["smoke.cts"],
      },
    },
    {
      name: "plain-script",
      packageManifest: {
        dependencies: packageDependencies,
        name: "opencookie-plain-script-consumer",
        private: true,
        type: "commonjs",
        version: "0.0.0",
      },
      scriptFilename: "smoke.cjs",
      scriptSource: createPlainScriptConsumer(plainScriptPackages),
    },
  ];

  const writtenFixtures = [];
  for (const fixture of fixtures) {
    const directory = path.join(consumerRoot, fixture.name);
    const scriptPath = path.join(directory, fixture.scriptFilename);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      `${JSON.stringify(fixture.packageManifest, null, 2)}\n`,
    );
    await writeFile(scriptPath, fixture.scriptSource);
    if (fixture.tsconfig !== undefined) {
      await writeFile(
        path.join(directory, "tsconfig.json"),
        `${JSON.stringify(fixture.tsconfig, null, 2)}\n`,
      );
    }
    writtenFixtures.push({ directory, name: fixture.name, scriptPath });
  }
  return writtenFixtures;
}

function supportsExportCondition(manifest, condition) {
  const rootExport = manifest.exports?.["."] ?? manifest.exports;
  if (
    rootExport !== null &&
    typeof rootExport === "object" &&
    !Array.isArray(rootExport)
  ) {
    return Object.hasOwn(rootExport, condition);
  }
  if (condition === "import") {
    return typeof manifest.module === "string";
  }
  return (
    condition === "require" &&
    typeof manifest.main === "string" &&
    manifest.main.endsWith(".cjs")
  );
}

function createEsmConsumer(packageNames) {
  const coreChecks = packageNames.includes("@opencookie-dev/core")
    ? `
const core = await import("@opencookie-dev/core");
assert.equal(core.definePolicy({ categories: [], purposes: [] }).ok, true);
assert.equal(typeof core.createOpenCookie, "function");
assert.equal(core.createCookieDecisionStore, undefined);
assert.equal(core.executeGrantTransition, undefined);
assert.equal(core.isSupportedPolicyIdentity, undefined);
assert.equal(core.resolveGpcSignal, undefined);
const application = await import("@opencookie-dev/core/application");
assert.equal(typeof application.createTransitionQueue().enqueue, "function");
assert.equal(application.createOpenCookie, undefined);
assert.equal(application.createPolicyReconciler, undefined);
const require = createRequire(import.meta.url);
const cjsApplication = require("@opencookie-dev/core/application");
assert.equal(cjsApplication.createOpenCookie, undefined);
assert.equal(cjsApplication.createPolicyReconciler, undefined);
const reconciliation = await import("@opencookie-dev/core/reconciliation");
assert.equal(typeof reconciliation.createPolicyReconciler, "function");
assert.equal(typeof reconciliation.createPolicyReconciler().reconcile, "function");
assert.equal(reconciliation.reconcileConsentPolicy, undefined);
assert.equal(reconciliation.createPolicySnapshotVerifier, undefined);
const cjsReconciliation = require("@opencookie-dev/core/reconciliation");
assert.equal(typeof cjsReconciliation.createPolicyReconciler().reconcile, "function");
assert.equal(cjsReconciliation.reconcileConsentPolicy, undefined);
assert.equal(cjsReconciliation.createPolicySnapshotVerifier, undefined);
assert.equal(application.canonicalizePolicy, undefined);
assert.equal(application.createCookieDecisionStore, undefined);
const domain = await import("@opencookie-dev/core/domain");
assert.deepEqual(domain.diffDecisions(null, []), []);
assert.equal(domain.isSupportedPolicyIdentity, undefined);
assert.equal(domain.planReconsent, undefined);
assert.equal(domain.createCookieDecisionStore, undefined);
assert.equal(domain.createTransitionQueue, undefined);
const infrastructure = await import("@opencookie-dev/core/infrastructure");
assert.equal(infrastructure.canonicalizePolicy, undefined);
assert.equal(infrastructure.createTransitionQueue, undefined);
assert.equal(infrastructure.diffDecisions, undefined);
assert.deepEqual(infrastructure.projectGoogleConsentModeState({ resources: [] }, {}), {
  adPersonalization: "denied",
  adStorage: "denied",
  adUserData: "denied",
  analyticsStorage: "denied",
});
const auto = await import("@opencookie-dev/core/auto");
assert.deepEqual(Object.keys(auto).sort(), [
  "createAutoOpenCookieFactory",
  "establishAutoGoogleConsentDefaults",
]);
assert.equal(auto.createOpenCookie, undefined);
assert.equal(auto.projectConsentReceipt, undefined);
const autoFactory = auto.createAutoOpenCookieFactory({ consentDurationMs: 1000 });
assert.equal(autoFactory.purposeId, "analytics");
assert.equal(typeof autoFactory.create, "function");
assert.equal(core.createAutoOpenCookieFactory, undefined);
`
    : "";
  return `import assert from "node:assert/strict";
import { createRequire } from "node:module";

const packageNames = ${JSON.stringify(packageNames)};
for (const packageName of packageNames) {
  const importedPackage = await import(packageName);
  assert.ok(
    (typeof importedPackage === "object" && importedPackage !== null) ||
      typeof importedPackage === "function",
    \`ESM import returned no module for \${packageName}.\`,
  );
}
${coreChecks}
console.log(\`ESM consumer imported \${packageNames.length} packages.\`);
`;
}

function createCjsConsumer(packageNames) {
  const coreChecks = packageNames.includes("@opencookie-dev/core")
    ? `
const core = require("@opencookie-dev/core");
assert.equal(core.definePolicy({ categories: [], purposes: [] }).ok, true);
assert.equal(typeof core.createOpenCookie, "function");
assert.equal(core.createCookieDecisionStore, undefined);
assert.equal(core.executeGrantTransition, undefined);
assert.equal(core.isSupportedPolicyIdentity, undefined);
assert.equal(core.resolveGpcSignal, undefined);
const application = require("@opencookie-dev/core/application");
assert.equal(typeof application.createTransitionQueue().enqueue, "function");
assert.equal(application.createOpenCookie, undefined);
assert.equal(application.createPolicyReconciler, undefined);
assert.equal(application.canonicalizePolicy, undefined);
assert.equal(application.createCookieDecisionStore, undefined);
const reconciliation = require("@opencookie-dev/core/reconciliation");
assert.equal(typeof reconciliation.createPolicyReconciler, "function");
assert.equal(typeof reconciliation.createPolicyReconciler().reconcile, "function");
assert.equal(reconciliation.reconcileConsentPolicy, undefined);
assert.equal(reconciliation.createPolicySnapshotVerifier, undefined);
const domain = require("@opencookie-dev/core/domain");
assert.deepEqual(domain.diffDecisions(null, []), []);
assert.equal(domain.isSupportedPolicyIdentity, undefined);
assert.equal(domain.planReconsent, undefined);
assert.equal(domain.createCookieDecisionStore, undefined);
assert.equal(domain.createTransitionQueue, undefined);
const infrastructure = require("@opencookie-dev/core/infrastructure");
assert.equal(infrastructure.canonicalizePolicy, undefined);
assert.equal(infrastructure.createTransitionQueue, undefined);
assert.equal(infrastructure.diffDecisions, undefined);
assert.deepEqual(infrastructure.projectGoogleConsentModeState({ resources: [] }, {}), {
  adPersonalization: "denied",
  adStorage: "denied",
  adUserData: "denied",
  analyticsStorage: "denied",
});
const auto = require("@opencookie-dev/core/auto");
assert.deepEqual(Object.keys(auto).sort(), [
  "createAutoOpenCookieFactory",
  "establishAutoGoogleConsentDefaults",
]);
assert.equal(auto.createOpenCookie, undefined);
assert.equal(auto.projectConsentReceipt, undefined);
const autoFactory = auto.createAutoOpenCookieFactory({ consentDurationMs: 1000 });
assert.equal(autoFactory.purposeId, "analytics");
assert.equal(typeof autoFactory.create, "function");
assert.equal(core.createAutoOpenCookieFactory, undefined);
`
    : "";
  return `const assert = require("node:assert/strict");

const packageNames = ${JSON.stringify(packageNames)};
for (const packageName of packageNames) {
  const requiredPackage = require(packageName);
  assert.ok(
    (typeof requiredPackage === "object" && requiredPackage !== null) ||
      typeof requiredPackage === "function",
    \`CommonJS require returned no module for \${packageName}.\`,
  );
}
${coreChecks}
console.log(\`CommonJS consumer required \${packageNames.length} packages.\`);
`;
}

function createTypeConsumer() {
  return `import { createOpenCookie, definePolicy, type OpenCookieOptions } from "@opencookie-dev/core";
import { createTransitionQueue } from "@opencookie-dev/core/application";
import { diffDecisions } from "@opencookie-dev/core/domain";
import { projectGoogleConsentModeState } from "@opencookie-dev/core/infrastructure";
import { createPolicyReconciler, type ConsentPolicyReconciliationInput, type PolicyReconciler, type PolicyVersionChangedWithoutAffectedPurposeIssue, type PolicyVersionUnchangedWithAffectedPurposeIssue } from "@opencookie-dev/core/reconciliation";
import { createAutoOpenCookieFactory, type AutoOpenCookieDefinition } from "@opencookie-dev/core/auto";
// @ts-expect-error auto does not re-export the generic runtime factory
import { createOpenCookie as autoCreateOpenCookie } from "@opencookie-dev/core/auto";
// @ts-expect-error auto does not re-export consent-receipt projection
import { projectConsentReceipt as autoProjectConsentReceipt } from "@opencookie-dev/core/auto";
// @ts-expect-error root does not re-export infrastructure runtime values
import { createCookieDecisionStore as rootCreateCookieDecisionStore } from "@opencookie-dev/core";
// @ts-expect-error application does not re-export domain runtime values
import { canonicalizePolicy as applicationCanonicalizePolicy } from "@opencookie-dev/core/application";
// @ts-expect-error the headless client is root-only
import { createOpenCookie as applicationCreateOpenCookie } from "@opencookie-dev/core/application";
// @ts-expect-error reconciliation has its own public product boundary
import { createPolicyReconciler as applicationCreatePolicyReconciler } from "@opencookie-dev/core/application";
// @ts-expect-error domain does not re-export application runtime values
import { createTransitionQueue as domainCreateTransitionQueue } from "@opencookie-dev/core/domain";
// @ts-expect-error infrastructure does not re-export application runtime values
import { createTransitionQueue as infrastructureCreateTransitionQueue } from "@opencookie-dev/core/infrastructure";
// @ts-expect-error infrastructure does not re-export domain runtime values
import { diffDecisions as infrastructureDiffDecisions } from "@opencookie-dev/core/infrastructure";
// @ts-expect-error domain does not expose caller-authored reconsent change sets
import type { ConsentPolicyChangeSetInput } from "@opencookie-dev/core/domain";
// @ts-expect-error domain does not expose the low-level reconsent planner
import { planReconsent } from "@opencookie-dev/core/domain";
// @ts-expect-error reconciliation exposes only the bound reconciliation factory
import { reconcileConsentPolicy } from "@opencookie-dev/core/reconciliation";
// @ts-expect-error reconciliation has no transferable verifier capability
import { createPolicySnapshotVerifier } from "@opencookie-dev/core/reconciliation";
// @ts-expect-error package-private policy identity validators are not public
import { isSupportedPolicyIdentity as rootIdentityValidator } from "@opencookie-dev/core";
// @ts-expect-error package-private policy identity validators are not public
import { isSupportedPolicyIdentity as domainIdentityValidator } from "@opencookie-dev/core/domain";

const policy = definePolicy({ categories: [], purposes: [] });
const rootClientFactory = createOpenCookie;
const rootClientOptions: OpenCookieOptions | undefined = undefined;
const autoDefinition: AutoOpenCookieDefinition = { consentDurationMs: 1_000 };
const autoFactory = createAutoOpenCookieFactory(autoDefinition);
const autoClient = autoFactory.create({
  idGenerator: (kind) => kind,
  now: () => 1,
  persistence: { kind: "unavailable" },
});
const queue = createTransitionQueue<void>();
const reconciler: PolicyReconciler = createPolicyReconciler();
const reconciliation = reconciler.reconcile;
const changes = diffDecisions(null, []);
const consentMode = projectGoogleConsentModeState({ resources: [] }, {});
const reconciliationInput: ConsentPolicyReconciliationInput | undefined = undefined;
const policyVersionChangedIssue: PolicyVersionChangedWithoutAffectedPurposeIssue | undefined = undefined;
const policyVersionUnchangedIssue: PolicyVersionUnchangedWithAffectedPurposeIssue | undefined = undefined;
const unsafeChangeSet: ConsentPolicyChangeSetInput | undefined = undefined;

void policy;
void rootClientFactory;
void rootClientOptions;
void autoDefinition;
void autoFactory;
void autoClient;
void autoCreateOpenCookie;
void autoProjectConsentReceipt;
void applicationCreateOpenCookie;
void applicationCreatePolicyReconciler;
void queue;
void reconciler;
void reconciliation;
void changes;
void consentMode;
void reconciliationInput;
void policyVersionChangedIssue;
void policyVersionUnchangedIssue;
void unsafeChangeSet;
void planReconsent;
void rootIdentityValidator;
void domainIdentityValidator;
`;
}

function createCommonJsTypeConsumer() {
  return `import core = require("@opencookie-dev/core");
import application = require("@opencookie-dev/core/application");
import auto = require("@opencookie-dev/core/auto");
import domain = require("@opencookie-dev/core/domain");
import infrastructure = require("@opencookie-dev/core/infrastructure");
import reconciliation = require("@opencookie-dev/core/reconciliation");

const policy = core.definePolicy({ categories: [], purposes: [] });
const autoFactory = auto.createAutoOpenCookieFactory({ consentDurationMs: 1_000 });
const autoClient = autoFactory.create({
  idGenerator: (kind) => kind,
  now: () => 1,
  persistence: { kind: "unavailable" },
});
const queue = application.createTransitionQueue();
const rootClientFactory = core.createOpenCookie;
const rootClientOptions: core.OpenCookieOptions | undefined = undefined;
const reconciler: reconciliation.PolicyReconciler = reconciliation.createPolicyReconciler();
const reconcilePolicy = reconciler.reconcile;
const reconciliationInput: reconciliation.ConsentPolicyReconciliationInput | undefined = undefined;
const policyVersionChangedIssue: reconciliation.PolicyVersionChangedWithoutAffectedPurposeIssue | undefined = undefined;
const policyVersionUnchangedIssue: reconciliation.PolicyVersionUnchangedWithAffectedPurposeIssue | undefined = undefined;
const changes = domain.diffDecisions(null, []);
const consentMode = infrastructure.projectGoogleConsentModeState({ resources: [] }, {});

// @ts-expect-error auto does not re-export the generic runtime factory
const autoCreateOpenCookie = auto.createOpenCookie;
// @ts-expect-error auto does not re-export consent-receipt projection
const autoProjectConsentReceipt = auto.projectConsentReceipt;
// @ts-expect-error root does not re-export infrastructure runtime values
const rootCreateCookieDecisionStore = core.createCookieDecisionStore;
// @ts-expect-error root does not re-export application runtime values
const rootExecuteGrantTransition = core.executeGrantTransition;
// @ts-expect-error root does not re-export infrastructure runtime values
const rootResolveGpcSignal = core.resolveGpcSignal;
// @ts-expect-error application does not re-export domain runtime values
const applicationCanonicalizePolicy = application.canonicalizePolicy;
// @ts-expect-error the headless client is root-only
const applicationCreateOpenCookie = application.createOpenCookie;
// @ts-expect-error reconciliation has its own public product boundary
const applicationCreatePolicyReconciler = application.createPolicyReconciler;
// @ts-expect-error application does not re-export infrastructure runtime values
const applicationCreateCookieDecisionStore = application.createCookieDecisionStore;
// @ts-expect-error domain does not expose the low-level reconsent planner
const lowLevelReconsentPlanner = domain.planReconsent;
// @ts-expect-error reconciliation exposes only the bound reconciliation factory
const rawPolicyReconciler = reconciliation.reconcileConsentPolicy;
// @ts-expect-error reconciliation has no transferable verifier capability
const policySnapshotVerifierFactory = reconciliation.createPolicySnapshotVerifier;
// @ts-expect-error package-private policy identity validators are not public
const rootIdentityValidator = core.isSupportedPolicyIdentity;
// @ts-expect-error package-private policy identity validators are not public
const domainIdentityValidator = domain.isSupportedPolicyIdentity;
// @ts-expect-error domain does not re-export infrastructure runtime values
const domainCreateCookieDecisionStore = domain.createCookieDecisionStore;
// @ts-expect-error domain does not re-export application runtime values
const domainCreateTransitionQueue = domain.createTransitionQueue;
// @ts-expect-error infrastructure does not re-export domain runtime values
const infrastructureCanonicalizePolicy = infrastructure.canonicalizePolicy;
// @ts-expect-error infrastructure does not re-export application runtime values
const infrastructureCreateTransitionQueue = infrastructure.createTransitionQueue;
// @ts-expect-error infrastructure does not re-export domain runtime values
const infrastructureDiffDecisions = infrastructure.diffDecisions;

void policy;
void autoFactory;
void autoClient;
void autoCreateOpenCookie;
void autoProjectConsentReceipt;
void queue;
void rootClientFactory;
void rootClientOptions;
void reconciler;
void reconcilePolicy;
void reconciliationInput;
void policyVersionChangedIssue;
void policyVersionUnchangedIssue;
void changes;
void consentMode;
void rootCreateCookieDecisionStore;
void rootExecuteGrantTransition;
void rootResolveGpcSignal;
void applicationCanonicalizePolicy;
void applicationCreateOpenCookie;
void applicationCreatePolicyReconciler;
void applicationCreateCookieDecisionStore;
void lowLevelReconsentPlanner;
void rawPolicyReconciler;
void policySnapshotVerifierFactory;
void rootIdentityValidator;
void domainIdentityValidator;
void domainCreateCookieDecisionStore;
void domainCreateTransitionQueue;
void infrastructureCanonicalizePolicy;
void infrastructureCreateTransitionQueue;
void infrastructureDiffDecisions;
`;
}

function createPlainScriptConsumer(packageProfiles) {
  return `const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

(async () => {
const packageProfiles = ${JSON.stringify(packageProfiles)};
for (const profile of packageProfiles) {
  const packageDirectory = path.join(process.cwd(), "node_modules", ...profile.name.split("/"));
  const scriptPath = path.resolve(packageDirectory, profile.script);
  const relativeScriptPath = path.relative(packageDirectory, scriptPath);
  assert.ok(
    relativeScriptPath !== "" &&
      relativeScriptPath !== ".." &&
      !relativeScriptPath.startsWith(\`..\${path.sep}\`) &&
      !path.isAbsolute(relativeScriptPath),
    \`Plain-script entry escapes its package: \${profile.name}.\`,
  );
  const source = await readFile(scriptPath, "utf8");
  const context = { console, document: {} };
  context.globalThis = context;
  context.self = context;
  context.window = context;
  vm.runInNewContext(source, context, { filename: scriptPath });
  const globalValue = context[profile.globalName];
  assert.ok(globalValue, \`Missing \${profile.globalName} global for \${profile.name}.\`);
  if (profile.globalName === "OpenCookie") {
    assert.deepEqual(Reflect.ownKeys(globalValue), []);
    for (const legacyMethod of [
      "bootstrapOpenCookie",
      "mountOpenCookie",
      "createBlockedScriptController",
      "createBlockedIframeController",
    ]) {
      assert.equal(globalValue[legacyMethod], undefined);
    }
  }
}
console.log(\`Plain-script consumer loaded \${packageProfiles.length} browser bundles.\`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
}

async function linkExternalPeerDependencies({
  consumerDirectory,
  packages,
  repositoryRoot,
}) {
  const publicPackageNames = new Set(
    packages.map(({ manifest }) => manifest.name),
  );
  const externalPeers = new Map();

  for (const { directory, manifest } of packages) {
    for (const peerName of Object.keys(manifest.peerDependencies ?? {})) {
      if (!publicPackageNames.has(peerName)) {
        const optional =
          manifest.peerDependenciesMeta?.[peerName]?.optional === true;
        const existingPeer = externalPeers.get(peerName);
        externalPeers.set(peerName, {
          declaringPackageDirectories: new Set([
            ...(existingPeer?.declaringPackageDirectories ?? []),
            directory,
          ]),
          optional: (existingPeer?.optional ?? true) && optional,
        });
      }
    }
  }

  for (const [
    peerName,
    { declaringPackageDirectories, optional },
  ] of externalPeers) {
    const peerSource = await locateExternalPeerDependency({
      declaringPackageDirectories: [...declaringPackageDirectories],
      peerName,
      repositoryRoot,
    });
    if (peerSource === undefined) {
      if (optional) {
        continue;
      }
      throw new PackageVerificationError(
        `Required peer ${peerName} is not installed in the workspace for consumer verification.`,
      );
    }

    const peerDestination = path.join(
      consumerDirectory,
      "node_modules",
      peerName,
    );
    try {
      await access(peerDestination);
      continue;
    } catch {
      await mkdir(path.dirname(peerDestination), { recursive: true });
      await symlink(
        peerSource,
        peerDestination,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
}

export async function locateExternalPeerDependency({
  declaringPackageDirectories,
  peerName,
  repositoryRoot,
}) {
  const candidates = [
    ...declaringPackageDirectories.map((directory) =>
      path.join(directory, "node_modules", peerName),
    ),
    path.join(repositoryRoot, "node_modules", peerName),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // pnpm may install a peer beside a workspace package instead of the root.
    }
  }

  return undefined;
}

async function startVerdaccio({
  configuration,
  repositoryRoot,
  temporaryDirectory,
}) {
  const port = await reserveLoopbackPort();
  const listen = `127.0.0.1:${port}`;
  const registryUrl = assertLoopbackRegistryUrl(`http://${listen}/`);
  const runtimeConfiguration = structuredClone(configuration);
  runtimeConfiguration.listen = listen;
  validateVerdaccioConfiguration(runtimeConfiguration);

  const verdaccioDirectory = path.join(temporaryDirectory, "verdaccio");
  const configurationPath = path.join(verdaccioDirectory, "config.json");
  await mkdir(verdaccioDirectory, { recursive: true });
  await writeFile(
    configurationPath,
    `${JSON.stringify(runtimeConfiguration, null, 2)}\n`,
  );

  const verdaccioCli = path.join(
    repositoryRoot,
    "node_modules",
    "verdaccio",
    "bin",
    "verdaccio",
  );
  try {
    await access(verdaccioCli);
  } catch (error) {
    throw new PackageVerificationError(
      "Verdaccio is not installed locally. Run pnpm install before package verification.",
      { cause: error },
    );
  }

  const child = spawn(
    process.execPath,
    [verdaccioCli, "--config", configurationPath, "--listen", listen],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const controller = captureChildProcess(child);

  try {
    await waitForRegistry(registryUrl, controller);
  } catch (error) {
    await controller.stop();
    throw error;
  }

  return {
    stop: controller.stop,
    url: registryUrl,
  };
}

function captureChildProcess(child) {
  let output = "";
  let spawnError;
  const appendOutput = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-8_192);
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));

  return {
    get exitCode() {
      return child.exitCode;
    },
    get output() {
      return output;
    },
    get signalCode() {
      return child.signalCode;
    },
    get spawnError() {
      return spawnError;
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill("SIGTERM");
      if (await settlesWithin(closed, 3_000)) {
        return;
      }
      child.kill("SIGKILL");
      await settlesWithin(closed, 3_000);
    },
  };
}

async function waitForRegistry(registryUrl, controller) {
  const pingUrl = new URL("-/ping", registryUrl);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (controller.spawnError !== undefined) {
      throw new PackageVerificationError("Verdaccio failed to start.", {
        cause: controller.spawnError,
      });
    }
    if (controller.exitCode !== null || controller.signalCode !== null) {
      throw new PackageVerificationError(
        `Verdaccio exited before becoming ready. ${controller.output}`.trim(),
      );
    }

    try {
      const response = await fetch(pingUrl, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The disposable registry is still starting.
    }
    await delay(250);
  }

  throw new PackageVerificationError(
    `Verdaccio did not become ready on its literal loopback URL. ${controller.output}`.trim(),
  );
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  if (port === 0) {
    throw new PackageVerificationError(
      "Unable to reserve a literal loopback port for Verdaccio.",
    );
  }
  return port;
}

async function executeCommand(command, args, options = {}) {
  const captureOutput = options.captureOutput === true;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: captureOutput
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      reject(
        new PackageVerificationError(`Unable to start command ${command}.`, {
          cause: error,
        }),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve({ stderr, stdout });
        return;
      }
      reject(
        new PackageVerificationError(
          `Command failed (${command} ${args.join(" ")}): ${
            signal === null ? `exit ${exitCode}` : `signal ${signal}`
          }. ${stderr}`.trim(),
        ),
      );
    });
  });
}

function safePathSegment(packageName) {
  return packageName.replaceAll(/[^a-zA-Z0-9.-]/gu, "-");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settlesWithin(promise, milliseconds) {
  return Promise.race([
    promise.then(() => true),
    delay(milliseconds).then(() => false),
  ]);
}

const defaultTemporaryDirectoryResources = {
  create: () =>
    mkdtemp(path.join(tmpdir(), "opencookie-package-verification-")),
  remove: (directory) => rm(directory, { force: true, recursive: true }),
};
