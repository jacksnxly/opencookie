import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

test("selects ATTW profiles from the package's explicit runtime formats", () => {
  assert.equal(
    attwProfileForManifest({
      exports: { ".": { import: "./index.js", require: "./index.cjs" } },
    }),
    "node16",
  );
  assert.equal(
    attwProfileForManifest({
      exports: { ".": { import: "./index.js" } },
    }),
    "esm-only",
  );
});

test("prevents ESM-only exports from falling through to CommonJS require", () => {
  assert.throws(
    () =>
      validatePackageModuleFormatContract({
        exports: {
          ".": {
            default: "./dist/index.js",
            import: "./dist/index.js",
            types: "./dist/index.d.ts",
          },
        },
        name: "@opencookie-dev/svelte",
        type: "module",
      }),
    /ESM-only.*default.*CommonJS/iu,
  );

  assert.doesNotThrow(() =>
    validatePackageModuleFormatContract({
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
      name: "@opencookie-dev/svelte",
      type: "module",
    }),
  );

  assert.doesNotThrow(() =>
    validatePackageModuleFormatContract({
      exports: {
        ".": {
          import: "./dist/index.js",
          require: "./dist/index.cjs",
          types: "./dist/index.d.ts",
        },
      },
      name: "@opencookie-dev/core",
      type: "module",
    }),
  );
});

test("accepts only literal loopback registry URLs", () => {
  assert.equal(
    assertLoopbackRegistryUrl("http://127.0.0.1:4873/"),
    "http://127.0.0.1:4873/",
  );

  for (const unsafeUrl of [
    "http://0.0.0.0:4873/",
    "http://localhost:4873/",
    "https://registry.npmjs.org/",
    "http://127.0.0.1:4873/other",
    "http://user:secret@127.0.0.1:4873/",
  ]) {
    assert.throws(
      () => assertLoopbackRegistryUrl(unsafeUrl),
      (error) => {
        assert.ok(error instanceof PackageVerificationError);
        assert.match(error.message, /literal loopback registry/i);
        return true;
      },
    );
  }
});

test("confines the Verdaccio npm uplink to external dependency reads", async () => {
  const configuration = JSON.parse(
    await readFile(
      new URL("../config/verdaccio.package-verification.json", import.meta.url),
      "utf8",
    ),
  );

  const proxiedConfiguration = {
    ...configuration,
    packages: {
      "@opencookie-dev/*": { access: "$all", publish: "$all" },
      opencookie: { access: "$all", publish: "$all" },
      "@*/*": {
        ...configuration.packages["@*/*"],
        proxy: "npmjs",
      },
      "**": { ...configuration.packages["**"], proxy: "npmjs" },
    },
    uplinks: {
      npmjs: {
        cache: false,
        url: "https://registry.npmjs.org/",
      },
    },
  };

  assert.deepEqual(validateVerdaccioConfiguration(proxiedConfiguration), {
    listen: "127.0.0.1:4873",
    packageRules: ["@opencookie-dev/*", "opencookie", "@*/*", "**"],
    storage: "./storage",
    uplink: "https://registry.npmjs.org/",
  });

  assert.throws(
    () =>
      validateVerdaccioConfiguration({
        ...proxiedConfiguration,
        listen: "0.0.0.0:4873",
      }),
    /literal loopback registry/i,
  );
  assert.throws(
    () =>
      validateVerdaccioConfiguration({
        ...proxiedConfiguration,
        uplinks: { npmjs: { url: "https://packages.example.test/" } },
      }),
    /official npm registry/i,
  );
  assert.throws(
    () =>
      validateVerdaccioConfiguration({
        ...proxiedConfiguration,
        auth: { htpasswd: { file: "./htpasswd" } },
      }),
    /must not define authentication/i,
  );
  assert.throws(
    () =>
      validateVerdaccioConfiguration({
        ...proxiedConfiguration,
        packages: {
          ...proxiedConfiguration.packages,
          "@opencookie-dev/*": {
            access: "$all",
            publish: "$all",
            proxy: "npmjs",
          },
        },
      }),
    /must never proxy/i,
  );
  assert.throws(
    () =>
      validateVerdaccioConfiguration({
        ...proxiedConfiguration,
        packages: {
          ...proxiedConfiguration.packages,
          opencookie: {
            access: "$all",
            publish: "$all",
            proxy: "npmjs",
          },
        },
      }),
    /must never proxy/i,
  );
});

test("rewrites workspace ranges to publishable internal versions", () => {
  const manifest = {
    dependencies: {
      "@opencookie-dev/core": "workspace:^",
      external: "2.0.0",
    },
    optionalDependencies: {
      "@opencookie-dev/vanilla": "workspace:~",
    },
    peerDependencies: {
      "@opencookie-dev/react": "workspace:*",
    },
  };

  assert.deepEqual(
    rewriteWorkspaceDependencies(
      manifest,
      new Map([
        ["@opencookie-dev/core", "1.2.3"],
        ["@opencookie-dev/react", "3.0.0"],
        ["@opencookie-dev/vanilla", "2.4.0"],
      ]),
    ),
    {
      dependencies: {
        "@opencookie-dev/core": "^1.2.3",
        external: "2.0.0",
      },
      optionalDependencies: {
        "@opencookie-dev/vanilla": "~2.4.0",
      },
      peerDependencies: {
        "@opencookie-dev/react": "3.0.0",
      },
    },
  );

  assert.throws(
    () =>
      rewriteWorkspaceDependencies(
        { dependencies: { "@opencookie-dev/missing": "workspace:^" } },
        new Map(),
      ),
    /missing.*published version/i,
  );
});

test("sorts public packages in internal dependency order", () => {
  const packages = [
    {
      manifest: {
        dependencies: { "@opencookie-dev/react": "workspace:^" },
        name: "opencookie",
        version: "1.0.0",
      },
    },
    {
      manifest: {
        dependencies: { "@opencookie-dev/core": "workspace:^" },
        name: "@opencookie-dev/react",
        version: "1.0.0",
      },
    },
    {
      manifest: { name: "@opencookie-dev/core", version: "1.0.0" },
    },
  ];

  assert.deepEqual(
    sortPackagesForPublication(packages).map(({ manifest }) => manifest.name),
    ["@opencookie-dev/core", "@opencookie-dev/react", "opencookie"],
  );

  assert.throws(
    () =>
      sortPackagesForPublication([
        {
          manifest: {
            dependencies: { second: "workspace:^" },
            name: "first",
            version: "1.0.0",
          },
        },
        {
          manifest: {
            dependencies: { first: "workspace:^" },
            name: "second",
            version: "1.0.0",
          },
        },
      ]),
    /dependency cycle/i,
  );
});

test("always stops a disposable registry, including unsafe and failed runs", async () => {
  let stopCount = 0;
  const registry = {
    stop: async () => {
      stopCount += 1;
    },
    url: "http://127.0.0.1:4873/",
  };

  await assert.rejects(
    withDisposableRegistry(
      async () => registry,
      async () => {
        throw new Error("consumer failed");
      },
    ),
    /consumer failed/i,
  );
  assert.equal(stopCount, 1);

  registry.url = "http://0.0.0.0:4873/";
  await assert.rejects(
    withDisposableRegistry(
      async () => registry,
      async () => undefined,
    ),
    /literal loopback registry/i,
  );
  assert.equal(stopCount, 2);
});

test("always removes its exact temporary directory after failure", async () => {
  const calls = [];

  await assert.rejects(
    usingTemporaryDirectory(
      {
        create: async () => "/tmp/opencookie-package-verification-test",
        remove: async (directory) => calls.push(directory),
      },
      async () => {
        throw new Error("verification failed");
      },
    ),
    /verification failed/i,
  );

  assert.deepEqual(calls, ["/tmp/opencookie-package-verification-test"]);
});
