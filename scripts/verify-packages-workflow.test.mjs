import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverPublicPackages,
  locateExternalPeerDependency,
  parsePackResult,
  runPackageVerification,
} from "./verify-packages-workflow.mjs";

test("locates framework peers beside the workspace package that declares them", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "opencookie-package-peer-"),
  );
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));

  const packageDirectory = path.join(repositoryRoot, "packages/adapters/react");
  const packageLocalPeer = path.join(packageDirectory, "node_modules/react");
  await mkdir(packageLocalPeer, { recursive: true });

  assert.equal(
    await locateExternalPeerDependency({
      declaringPackageDirectories: [packageDirectory],
      peerName: "react",
      repositoryRoot,
    }),
    packageLocalPeer,
  );
});

test("discovers public package manifests recursively and rejects an empty release", async (t) => {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "opencookie-package-discovery-"),
  );
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));

  await writeManifest(repositoryRoot, "packages/core", {
    name: "@opencookie-dev/core",
    version: "1.2.3",
  });
  await writeManifest(repositoryRoot, "packages/adapters/vanilla", {
    name: "@opencookie-dev/vanilla",
    version: "1.2.3",
  });
  await writeManifest(repositoryRoot, "packages/private", {
    name: "@opencookie-dev/private",
    private: true,
    version: "1.2.3",
  });

  assert.deepEqual(
    (await discoverPublicPackages(repositoryRoot)).map(
      ({ manifest }) => manifest.name,
    ),
    ["@opencookie-dev/core", "@opencookie-dev/vanilla"],
  );

  await writeManifest(repositoryRoot, "packages/core", {
    name: "@opencookie-dev/core",
    private: "true",
    version: "1.2.3",
  });
  await writeManifest(repositoryRoot, "packages/adapters/vanilla", {
    name: "@opencookie-dev/vanilla",
    private: true,
    version: "1.2.3",
  });
  await assert.rejects(
    discoverPublicPackages(repositoryRoot),
    /private field must be boolean/i,
  );

  await writeManifest(repositoryRoot, "packages/core", {
    name: "@opencookie-dev/core",
    private: true,
    version: "1.2.3",
  });

  await assert.rejects(
    discoverPublicPackages(repositoryRoot),
    /no public packages found/i,
  );
});

test("accepts one exact npm pack tarball and rejects path escapes", async (t) => {
  const tarballDirectory = await mkdtemp(
    path.join(tmpdir(), "opencookie-tarball-output-"),
  );
  t.after(() => rm(tarballDirectory, { force: true, recursive: true }));

  const expectedTarball = path.join(
    tarballDirectory,
    "opencookie-core-1.2.3.tgz",
  );
  await writeFile(expectedTarball, "fixture tarball");

  assert.equal(
    await parsePackResult(
      JSON.stringify([{ filename: path.basename(expectedTarball) }]),
      tarballDirectory,
    ),
    expectedTarball,
  );

  await assert.rejects(
    parsePackResult(
      JSON.stringify([{ filename: "../escaped.tgz" }]),
      tarballDirectory,
    ),
    /single exact tarball/i,
  );
  await assert.rejects(
    parsePackResult(
      JSON.stringify([
        { filename: path.basename(expectedTarball) },
        { filename: "second.tgz" },
      ]),
      tarballDirectory,
    ),
    /single exact tarball/i,
  );
});

test("runs representative root and subpath exports through packed ESM, CommonJS, and conditional type consumers", async (t) => {
  const repositoryRoot = await createFixtureRepository();
  t.after(() => rm(repositoryRoot, { force: true, recursive: true }));

  const commands = [];
  const smokeSources = new Map();
  const removedDirectories = [];
  let registryStopCount = 0;

  const runCommand = async (command, args, options = {}) => {
    commands.push({ args: [...args], command, ...options });

    if (command === "npm" && args[0] === "pack") {
      const manifest = JSON.parse(
        await readFile(path.join(options.cwd, "package.json"), "utf8"),
      );
      assert.match(
        await readFile(path.join(options.cwd, "dist/index.js"), "utf8"),
        /export/u,
      );
      if (manifest.name === "@opencookie-dev/vanilla") {
        assert.equal(manifest.dependencies["@opencookie-dev/core"], "^1.0.0");
      }

      const tarballDirectory = args[args.indexOf("--pack-destination") + 1];
      const filename = `${manifest.name
        .replace(/^@/u, "")
        .replaceAll("/", "-")}-${manifest.version}.tgz`;
      await writeFile(path.join(tarballDirectory, filename), "fixture tarball");
      return { stderr: "", stdout: JSON.stringify([{ filename }]) };
    }

    if (command === "npm" && args[0] === "publish") {
      const userConfigurationPath = args[args.indexOf("--userconfig") + 1];
      const userConfiguration = await readFile(userConfigurationPath, "utf8");
      assert.match(
        userConfiguration,
        /^\/\/127\.0\.0\.1:4873\/:_authToken=[a-zA-Z0-9_-]+$/mu,
      );
      assert.doesNotMatch(userConfiguration, /registry\.npmjs\.org/iu);
    }

    if (command === process.execPath) {
      const consumerName = path.basename(options.cwd);
      const typeConsumerSource =
        consumerName === "types"
          ? "smoke.ts"
          : consumerName === "types-cjs"
            ? "smoke.cts"
            : undefined;
      const source = await readFile(
        typeConsumerSource === undefined
          ? args[0]
          : path.join(options.cwd, typeConsumerSource),
        "utf8",
      );
      smokeSources.set(consumerName, source);
      if (consumerName === "plain-script") {
        assert.doesNotThrow(() => new Function(source));
      }
    }

    return { stderr: "", stdout: "" };
  };

  const result = await runPackageVerification({
    logger: { log() {} },
    repositoryRoot,
    runCommand,
    startRegistry: async () => ({
      stop: async () => {
        registryStopCount += 1;
      },
      url: "http://127.0.0.1:4873/",
    }),
    temporaryDirectoryResources: {
      create: () =>
        mkdtemp(path.join(tmpdir(), "opencookie-package-workflow-")),
      remove: async (directory) => {
        removedDirectories.push(directory);
        await rm(directory, { force: true, recursive: true });
      },
    },
  });

  assert.deepEqual(result.packageNames, [
    "@opencookie-dev/core",
    "@opencookie-dev/vanilla",
  ]);
  assert.deepEqual(commands[0], {
    args: ["build"],
    command: "pnpm",
    cwd: repositoryRoot,
  });

  const packCommands = commands.filter(
    ({ args, command }) => command === "npm" && args[0] === "pack",
  );
  assert.equal(packCommands.length, 2);
  assert.ok(
    packCommands.every(
      ({ args }) =>
        args.includes("--pack-destination") &&
        args.includes("--ignore-scripts"),
    ),
  );

  const publintTarballs = commands
    .filter(
      ({ args, command }) =>
        command === "pnpm" && args[0] === "exec" && args[1] === "publint",
    )
    .map(({ args }) => args[2]);
  const attwTarballs = commands
    .filter(
      ({ args, command }) =>
        command === "pnpm" && args[0] === "exec" && args[1] === "attw",
    )
    .map(({ args }) => args[2]);
  assert.deepEqual(attwTarballs, publintTarballs);
  assert.equal(publintTarballs.length, 2);
  assert.ok(publintTarballs.every((tarball) => tarball.endsWith(".tgz")));

  const publishCommands = commands.filter(
    ({ args, command }) => command === "npm" && args[0] === "publish",
  );
  assert.deepEqual(
    publishCommands.map(({ args }) => path.basename(args[1])),
    ["opencookie-dev-core-1.0.0.tgz", "opencookie-dev-vanilla-1.0.0.tgz"],
  );

  const registryCommands = commands.filter(
    ({ args, command }) =>
      command === "npm" && (args[0] === "publish" || args[0] === "install"),
  );
  assert.ok(
    registryCommands.every(
      ({ args, env }) =>
        args[args.indexOf("--registry") + 1] === "http://127.0.0.1:4873/" &&
        args.includes("--userconfig") &&
        args.includes("--globalconfig") &&
        env.NPM_CONFIG_REGISTRY === "http://127.0.0.1:4873/" &&
        env.NPM_CONFIG_GLOBALCONFIG.endsWith("global-npmrc") &&
        env.NO_PROXY.includes("127.0.0.1"),
    ),
  );

  assert.match(smokeSources.get("esm"), /await import\(packageName\)/u);
  assert.match(
    smokeSources.get("esm"),
    /createRequire\(import[.]meta[.]url\)/u,
  );
  assert.match(
    smokeSources.get("esm"),
    /cjsReconciliation[.]createPolicyReconciler/u,
  );
  assert.match(smokeSources.get("cjs"), /require\(packageName\)/u);
  for (const consumerName of ["esm", "cjs"]) {
    assert.match(
      smokeSources.get(consumerName),
      /application[.]createPolicyReconciler, undefined/u,
    );
    assert.match(
      smokeSources.get(consumerName),
      /application[.]createOpenCookie, undefined/u,
    );
    assert.match(
      smokeSources.get(consumerName),
      /typeof reconciliation[.]createPolicyReconciler/u,
    );
    assert.match(
      smokeSources.get(consumerName),
      /reconciliation[.]reconcileConsentPolicy, undefined/u,
    );
    assert.match(
      smokeSources.get(consumerName),
      /reconciliation[.]createPolicySnapshotVerifier, undefined/u,
    );
    assert.match(
      smokeSources.get(consumerName),
      /domain[.]planReconsent, undefined/u,
    );
  }
  assert.match(
    smokeSources.get("types"),
    /createPolicyReconciler.*@opencookie-dev\/core\/reconciliation/u,
  );
  assert.match(
    smokeSources.get("types"),
    /ConsentPolicyReconciliationInput.*@opencookie-dev\/core\/reconciliation/u,
  );
  assert.match(
    smokeSources.get("types"),
    /PolicyReconciler.*@opencookie-dev\/core\/reconciliation/u,
  );
  assert.match(
    smokeSources.get("types"),
    /type PolicyVersionChangedWithoutAffectedPurposeIssue/u,
  );
  assert.match(
    smokeSources.get("types"),
    /type PolicyVersionUnchangedWithAffectedPurposeIssue/u,
  );
  assert.match(
    smokeSources.get("types"),
    /domain does not expose caller-authored reconsent change sets/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /reconciliation[.]createPolicyReconciler/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /reconciliation[.]ConsentPolicyReconciliationInput/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /reconciliation[.]PolicyReconciler/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /reconciliation[.]PolicyVersionChangedWithoutAffectedPurposeIssue/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /reconciliation[.]PolicyVersionUnchangedWithAffectedPurposeIssue/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /domain does not expose the low-level reconsent planner/u,
  );
  const coreEntrySmokeContract = [
    ["@opencookie-dev/core", "definePolicy"],
    ["@opencookie-dev/core/application", "createTransitionQueue"],
    ["@opencookie-dev/core/auto", "createAutoOpenCookieFactory"],
    ["@opencookie-dev/core/domain", "diffDecisions"],
    ["@opencookie-dev/core/infrastructure", "projectGoogleConsentModeState"],
    ["@opencookie-dev/core/reconciliation", "createPolicyReconciler"],
  ];
  const missingCoreEntryChecks = [];
  for (const [specifier, representativeExport] of coreEntrySmokeContract) {
    for (const consumerName of ["esm", "cjs", "types", "types-cjs"]) {
      if (!smokeSources.get(consumerName)?.includes(specifier)) {
        missingCoreEntryChecks.push(`${consumerName} resolve ${specifier}`);
      }
    }
    for (const consumerName of ["esm", "cjs"]) {
      if (
        !new RegExp(`\\.${representativeExport}\\(`, "u").test(
          smokeSources.get(consumerName) ?? "",
        )
      ) {
        missingCoreEntryChecks.push(
          `${consumerName} execute ${specifier}.${representativeExport}`,
        );
      }
    }
  }
  assert.deepEqual(missingCoreEntryChecks, []);
  for (const consumerName of ["esm", "cjs"]) {
    assert.match(smokeSources.get(consumerName), /Object[.]keys\(auto\)/u);
    assert.match(
      smokeSources.get(consumerName),
      /auto[.]createOpenCookie, undefined/u,
    );
    assert.match(
      smokeSources.get(consumerName),
      /auto[.]projectConsentReceipt, undefined/u,
    );
  }
  assert.match(
    smokeSources.get("types"),
    /createAutoOpenCookieFactory.*@opencookie-dev\/core\/auto/u,
  );
  assert.match(smokeSources.get("types"), /type AutoOpenCookieDefinition/u);
  assert.match(
    smokeSources.get("types"),
    /@ts-expect-error auto does not re-export the generic runtime factory/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /auto[.]createAutoOpenCookieFactory/u,
  );
  assert.match(
    smokeSources.get("types"),
    /@ts-expect-error application does not re-export domain runtime values/u,
  );
  assert.match(
    smokeSources.get("types"),
    /@ts-expect-error infrastructure does not re-export application runtime values/u,
  );
  for (const [, representativeExport] of coreEntrySmokeContract) {
    assert.match(
      smokeSources.get("types-cjs"),
      new RegExp(`\\.${representativeExport}\\(`, "u"),
    );
  }
  assert.match(
    smokeSources.get("types-cjs"),
    /import core = require\("@opencookie-dev\/core"\)/u,
  );
  const plainScriptSource = smokeSources.get("plain-script");
  assert.match(plainScriptSource, /Reflect[.]ownKeys/u);
  assert.match(plainScriptSource, /bootstrapOpenCookie/u);
  assert.match(plainScriptSource, /mountOpenCookie/u);
  assert.match(plainScriptSource, /createBlockedScriptController/u);
  assert.match(plainScriptSource, /createBlockedIframeController/u);
  assert.match(
    smokeSources.get("types-cjs"),
    /@ts-expect-error application does not re-export domain runtime values/u,
  );
  assert.match(
    smokeSources.get("types-cjs"),
    /@ts-expect-error infrastructure does not re-export application runtime values/u,
  );
  assert.match(smokeSources.get("plain-script"), /OpenCookie/u);
  assert.equal(registryStopCount, 1);
  assert.equal(removedDirectories.length, 1);
});

async function createFixtureRepository() {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "opencookie-package-repository-"),
  );

  await writeManifest(repositoryRoot, "packages/core", {
    exports: {
      ".": fixtureDualExport("index"),
      "./application": fixtureDualExport("application"),
      "./domain": fixtureDualExport("domain"),
      "./infrastructure": fixtureDualExport("infrastructure"),
      "./reconciliation": fixtureDualExport("reconciliation"),
    },
    name: "@opencookie-dev/core",
    type: "module",
    version: "1.0.0",
  });
  const coreEntries = new Map([
    ["index", "definePolicy"],
    ["application", "createTransitionQueue"],
    ["domain", "diffDecisions"],
    ["infrastructure", "projectGoogleConsentModeState"],
    ["reconciliation", "createPolicyReconciler"],
  ]);
  await Promise.all(
    [...coreEntries].flatMap(([entry, representativeExport]) => [
      writeFile(
        path.join(repositoryRoot, `packages/core/dist/${entry}.js`),
        `export function ${representativeExport}() { return undefined; }\n`,
      ),
      writeFile(
        path.join(repositoryRoot, `packages/core/dist/${entry}.cjs`),
        `exports.${representativeExport} = () => undefined;\n`,
      ),
      writeFile(
        path.join(repositoryRoot, `packages/core/dist/${entry}.d.ts`),
        `export declare function ${representativeExport}(): void;\n`,
      ),
      writeFile(
        path.join(repositoryRoot, `packages/core/dist/${entry}.d.cts`),
        `export declare function ${representativeExport}(): void;\n`,
      ),
    ]),
  );

  await writeManifest(repositoryRoot, "packages/adapters/vanilla", {
    dependencies: { "@opencookie-dev/core": "workspace:^" },
    exports: {
      ".": {
        import: "./dist/index.js",
        require: "./dist/index.cjs",
      },
    },
    name: "@opencookie-dev/vanilla",
    type: "module",
    unpkg: "./dist/index.iife.js",
    version: "1.0.0",
  });
  await writeFile(
    path.join(repositoryRoot, "packages/adapters/vanilla/dist/index.js"),
    "export const vanilla = true;\n",
  );
  await writeFile(
    path.join(repositoryRoot, "packages/adapters/vanilla/dist/index.cjs"),
    "exports.vanilla = true;\n",
  );
  await writeFile(
    path.join(repositoryRoot, "packages/adapters/vanilla/dist/index.iife.js"),
    "globalThis.OpenCookie = {};\n",
  );

  await mkdir(path.join(repositoryRoot, "config"), { recursive: true });
  await copyFile(
    new URL("../config/verdaccio.package-verification.json", import.meta.url),
    path.join(repositoryRoot, "config/verdaccio.package-verification.json"),
  );

  return repositoryRoot;
}

function fixtureDualExport(entry) {
  return {
    import: {
      types: `./dist/${entry}.d.ts`,
      default: `./dist/${entry}.js`,
    },
    require: {
      types: `./dist/${entry}.d.cts`,
      default: `./dist/${entry}.cjs`,
    },
  };
}

async function writeManifest(repositoryRoot, relativeDirectory, manifest) {
  const directory = path.join(repositoryRoot, relativeDirectory);
  await mkdir(path.join(directory, "dist"), { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
