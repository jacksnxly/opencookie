/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "domain-no-outward-imports",
      severity: "error",
      from: { path: "^packages/core/src/domain/" },
      to: {
        path: "^packages/core/src/",
        pathNot: "^packages/core/src/domain/",
      },
    },
    {
      name: "application-no-infrastructure",
      severity: "error",
      from: { path: "^packages/core/src/application/" },
      to: { path: "^packages/core/src/infrastructure/" },
    },
    {
      name: "application-domain-entrypoints-only",
      severity: "error",
      from: { path: "^packages/core/src/application/" },
      to: {
        path: "^packages/core/src/domain/[^/]+/",
        pathNot: "^packages/core/src/domain/[^/]+/(?:index|runtime)[.]ts$",
      },
    },
    {
      name: "context-no-peer-internals",
      severity: "error",
      from: { path: "(^packages/core/src/domain/)([^/]+)/" },
      to: {
        path: "^$1",
        pathNot: ["^$1$2/", "^packages/core/src/domain/shared/"],
      },
    },
    {
      name: "core-no-adapters",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { path: "^packages/adapters/" },
    },
    {
      name: "adapter-no-peer-adapter",
      severity: "error",
      from: { path: "(^packages/adapters/)([^/]+)/" },
      to: { path: "^$1", pathNot: "^$1$2/" },
    },
    {
      name: "adapter-no-core-internals",
      severity: "error",
      from: { path: "^packages/adapters/" },
      to: { path: "^packages/core/src/" },
    },
    {
      name: "core-source-no-external-runtime",
      severity: "error",
      from: {
        path: "^packages/core/src/",
        pathNot: "(?:^|/)(?:__tests__|tests?)/|[.](?:spec|test)[.]",
      },
      to: {
        dependencyTypes: [
          "core",
          "npm",
          "npm-dev",
          "npm-peer",
          "npm-optional",
          "npm-bundled",
          "npm-no-pkg",
          "npm-unknown",
        ],
      },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      // Nuxt resolves these package self-references after installing tarballs.
      // enhanced-resolve cannot model the two packed-consumer fixture contexts.
      from: {
        pathNot:
          "^packages/adapters/nuxt/test-fixture/(?:app[.]vue|nuxt[.]config[.]ts)$",
      },
      to: { couldNotResolve: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.base.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      conditionNames: [
        "types",
        "svelte",
        "import",
        "require",
        "node",
        "default",
      ],
      exportsFields: ["exports"],
      mainFields: ["module", "main", "types", "typings"],
    },
    moduleSystems: ["es6"],
    exclude: "(^|/)(?:dist|temp)/|(?:^|/)tsdown[.]config[.]ts$",
    doNotFollow: { path: "node_modules" },
    combinedDependencies: false,
  },
};
