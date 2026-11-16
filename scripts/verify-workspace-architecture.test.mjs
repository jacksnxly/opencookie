import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fileURLToPath } from "node:url";

import cruiseConfig from "../.dependency-cruiser.mjs";
import {
  BUDGETS,
  ArchitectureValidationError,
  validateArchitectureModel,
} from "./verify-workspace-architecture-lib.mjs";

const budgetBytes = (name) => String(BUDGETS.get(name).exactBytes);

const apiExtractorConfig = JSON.parse(
  readFileSync(
    new URL("../config/api-extractor-base.json", import.meta.url),
    "utf8",
  ),
);
const rootManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const requiredRules = [
  "domain-no-outward-imports",
  "application-no-infrastructure",
  "application-domain-entrypoints-only",
  "context-no-peer-internals",
  "core-no-adapters",
  "adapter-no-peer-adapter",
  "adapter-no-core-internals",
  "core-source-no-external-runtime",
  "no-circular",
  "no-unresolvable",
];

function validModel() {
  return {
    browserProductionSources: [
      {
        path: "packages/core/src/infrastructure/storage/cookie-decision-store.ts",
        source: "const parsed = new URL(`http://${input}/`);",
      },
      {
        path: "packages/adapters/vanilla/src/mount.ts",
        source: "export function mountConsent() { return true; }",
      },
    ],
    packages: [
      {
        apiExtractorConfigNames: [
          "api-extractor.application.json",
          "api-extractor.auto.json",
          "api-extractor.domain.json",
          "api-extractor.infrastructure.json",
          "api-extractor.reconciliation.json",
          "api-extractor.json",
        ],
        apiReportNames: [
          "core-application.api.md",
          "core-auto.api.md",
          "core-domain.api.md",
          "core-infrastructure.api.md",
          "core-reconciliation.api.md",
          "core.api.md",
        ],
        directory: "packages/core",
        manifest: {
          name: "@opencookie-dev/core",
          dependencies: {},
          exports: {
            ".": coreExport("index"),
            "./application": coreExport("application"),
            "./auto": coreExport("auto"),
            "./domain": coreExport("domain"),
            "./infrastructure": coreExport("infrastructure"),
            "./reconciliation": coreExport("reconciliation"),
          },
        },
        hasApiExtractorConfig: true,
        hasApiReport: true,
        hasTsconfig: true,
      },
      {
        directory: "packages/adapters/vanilla",
        manifest: {
          name: "@opencookie-dev/vanilla",
          dependencies: {
            "@opencookie-dev/core": "workspace:^",
          },
        },
        hasApiExtractorConfig: true,
        hasApiReport: true,
        hasTsconfig: true,
      },
    ],
    cruiseConfig: {
      forbidden: requiredRules.map((name) => ({ name, severity: "error" })),
      options: {
        tsPreCompilationDeps: true,
      },
    },
    sizeConfig: [...BUDGETS].map(([name, budget]) => ({
      name,
      path: budget.expectedPath,
      limit: `${String(budget.exactBytes)} B`,
      ...(budget.compression === "gzip" ? { gzip: true } : { brotli: false }),
    })),
    workspacePackageDirectories: ["packages/adapters/vanilla", "packages/core"],
    workspacePackageSymlinks: [],
  };
}

function coreExport(name) {
  return {
    import: {
      types: `./dist/${name}.d.ts`,
      default: `./dist/${name}.js`,
    },
    require: {
      types: `./dist/${name}.d.cts`,
      default: `./dist/${name}.cjs`,
    },
  };
}

function expectIssues(mutator, patterns) {
  const model = validModel();
  mutator(model);

  assert.throws(
    () => validateArchitectureModel(model),
    (error) => {
      assert.ok(error instanceof ArchitectureValidationError);
      for (const pattern of patterns) assert.match(error.message, pattern);
      return true;
    },
  );
}

function browserPackage(directory, name) {
  return {
    directory,
    manifest: {
      name,
      dependencies: {
        "@opencookie-dev/core": "workspace:^",
      },
    },
    hasApiExtractorConfig: true,
    hasApiReport: true,
    hasTsconfig: true,
  };
}

function runLiveArchitectureManifest(repositoryRoot) {
  return spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts", "verify-workspace-architecture.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
}

function expandGroups(pattern, match) {
  return pattern.replace(/\$(\d+)/g, (_, index) => match[Number(index)] ?? "");
}

function dependencyMatchesRule(rule, fromPath, toPath) {
  const fromMatch = fromPath.match(new RegExp(rule.from.path));
  if (!fromMatch) return false;

  const toPatterns = Array.isArray(rule.to.path)
    ? rule.to.path
    : [rule.to.path];
  const excludedPatterns = Array.isArray(rule.to.pathNot)
    ? rule.to.pathNot
    : rule.to.pathNot
      ? [rule.to.pathNot]
      : [];

  const matchesTarget = toPatterns.some((pattern) =>
    new RegExp(expandGroups(pattern, fromMatch)).test(toPath),
  );
  const isExcluded = excludedPatterns.some((pattern) =>
    new RegExp(expandGroups(pattern, fromMatch)).test(toPath),
  );

  return matchesTarget && !isExcluded;
}

test("accepts explicit core product boundaries, per-entry API reports, and fixed gzip budgets", () => {
  assert.deepEqual(validateArchitectureModel(validModel()), {
    packageCount: 2,
    ruleCount: 10,
    apiReportCount: 7,
    sizeBudgetCount: 8,
    browserSourceCounts: {
      "@opencookie-dev/core": 1,
      "@opencookie-dev/vanilla": 1,
    },
  });
});

test("requires the dedicated core reconciliation product boundary", () => {
  expectIssues(
    (model) => {
      delete model.packages[0].manifest.exports["./reconciliation"];
      model.sizeConfig = model.sizeConfig.filter(
        ({ name }) => name !== "core reconciliation ESM",
      );
    },
    [
      /missing public export [.]\/reconciliation/i,
      new RegExp(
        `reconciliation.*${budgetBytes("core reconciliation ESM")} byte`,
        "iu",
      ),
    ],
  );

  expectIssues(
    (model) => {
      model.sizeConfig.find(
        ({ name }) => name === "core reconciliation ESM",
      ).limit = "11000 B";
    },
    [
      new RegExp(
        `core reconciliation.*exactly ${budgetBytes("core reconciliation ESM")} bytes`,
        "iu",
      ),
    ],
  );
});

test("requires the dedicated core auto product boundary", () => {
  expectIssues(
    (model) => {
      delete model.packages[0].manifest.exports["./auto"];
      model.sizeConfig = model.sizeConfig.filter(
        ({ name }) => name !== "core auto ESM",
      );
    },
    [
      /missing public export [.]\/auto/i,
      new RegExp(`core auto.*${budgetBytes("core auto ESM")} byte`, "iu"),
    ],
  );

  expectIssues(
    (model) => {
      model.sizeConfig.find(({ name }) => name === "core auto ESM").limit =
        "24850 B";
    },
    [
      new RegExp(
        `core auto.*exactly ${budgetBytes("core auto ESM")} bytes`,
        "iu",
      ),
    ],
  );
});

test("rejects a missing or non-error architecture rule", () => {
  expectIssues(
    (model) => {
      model.cruiseConfig.forbidden = model.cruiseConfig.forbidden.filter(
        (rule) => rule.name !== "domain-no-outward-imports",
      );
    },
    [/domain-no-outward-imports.*missing/i],
  );

  expectIssues(
    (model) => {
      model.cruiseConfig.forbidden[0].severity = "warn";
    },
    [/domain-no-outward-imports.*severity.*error/i],
  );
});

test("rejects changed, missing, or non-gzip public entry budgets", () => {
  expectIssues(
    (model) => {
      model.sizeConfig[0].limit = `${budgetBytes("core auto ESM")} B`;
    },
    [
      new RegExp(
        `core.*exactly ${budgetBytes("core browser ESM")} bytes`,
        "iu",
      ),
    ],
  );

  expectIssues(
    (model) => {
      model.sizeConfig = model.sizeConfig.filter(
        ({ name }) => name !== "core domain ESM",
      );
    },
    [new RegExp(`domain.*${budgetBytes("core domain ESM")} byte`, "iu")],
  );

  expectIssues(
    (model) => {
      model.sizeConfig.find(
        ({ name }) => name === "core infrastructure ESM",
      ).gzip = false;
    },
    [/infrastructure.*gzip/i],
  );

  expectIssues(
    (model) => {
      model.sizeConfig.find(({ name }) => name === "vanilla auto IIFE").limit =
        "34000 B";
    },
    [
      new RegExp(
        `vanilla.*exactly ${budgetBytes("vanilla auto IIFE")} bytes`,
        "iu",
      ),
    ],
  );

  expectIssues(
    (model) => {
      model.sizeConfig.find(
        ({ name }) => name === "vanilla auto IIFE raw",
      ).limit = "116500 B";
    },
    [
      new RegExp(
        `vanilla raw.*exactly ${budgetBytes("vanilla auto IIFE raw")} bytes`,
        "iu",
      ),
    ],
  );

  expectIssues(
    (model) => {
      model.sizeConfig.find(
        ({ name }) => name === "vanilla auto IIFE raw",
      ).brotli = true;
    },
    [/vanilla raw.*without compression/i],
  );
});

test("rejects catch-all or unbudgeted core public subpaths", () => {
  expectIssues(
    (model) => {
      model.packages[0].manifest.exports["./low-level"] =
        coreExport("low-level");
    },
    [/low-level.*must not be exported/i, /low-level.*size budget/i],
  );
});

test("requires API Extractor configuration and report names for every core subpath", () => {
  expectIssues(
    (model) => {
      model.packages[0].apiExtractorConfigNames =
        model.packages[0].apiExtractorConfigNames.filter(
          (name) => name !== "api-extractor.domain.json",
        );
      model.packages[0].apiReportNames = model.packages[0].apiReportNames.map(
        (name) =>
          name === "core-infrastructure.api.md"
            ? "core-low-level.api.md"
            : name,
      );
    },
    [/api-extractor[.]domain[.]json/i, /core-infrastructure[.]api[.]md/i],
  );
});

// @covers PP-20 REQ-THIN-ADAPTERS: adapters stay thin bindings over core contracts.
test("rejects runtime dependencies in core and peer adapter dependencies", () => {
  expectIssues(
    (model) => {
      model.packages[0].manifest.dependencies.runtime = "1.0.0";
    },
    [/core.*zero runtime dependencies/i],
  );

  expectIssues(
    (model) => {
      model.packages[1].manifest.peerDependencies = {
        "@opencookie-dev/react": "workspace:^",
      };
    },
    [/vanilla.*adapter.*react/i],
  );
});

test("allows only the declared framework wrapper adapter dependencies", () => {
  const model = validModel();
  for (const [framework, base] of [
    ["astro", "vanilla"],
    ["next", "react"],
    ["nuxt", "vue"],
  ]) {
    model.packages.push({
      directory: `packages/adapters/${framework}`,
      manifest: {
        name: `@opencookie-dev/${framework}`,
        dependencies: {
          "@opencookie-dev/core": "workspace:^",
          [`@opencookie-dev/${base}`]: "workspace:^",
        },
      },
      hasApiExtractorConfig: true,
      hasApiReport: true,
      hasTsconfig: true,
    });
    model.workspacePackageDirectories.push(`packages/adapters/${framework}`);
    model.browserProductionSources.push({
      path: `packages/adapters/${framework}/src/index.ts`,
      source: "export const adapter = true;",
    });
  }

  assert.doesNotThrow(() => validateArchitectureModel(model));
  const nextPackage = model.packages.find(
    (pkg) => pkg.manifest.name === "@opencookie-dev/next",
  );
  nextPackage.manifest.dependencies["@opencookie-dev/vue"] = "workspace:^";
  assert.throws(
    () => validateArchitectureModel(model),
    /@opencookie-dev\/next adapter cannot depend on peer adapter @opencookie-dev\/vue/,
  );
});

test("requires workspace protocol for internal dependencies", () => {
  expectIssues(
    (model) => {
      model.packages[1].manifest.dependencies["@opencookie-dev/core"] =
        "^0.0.0";
    },
    [/workspace protocol/i],
  );
});

test("rejects hidden browser transport primitives in shipped core and adapter source", () => {
  const mutations = [
    ["fetch", 'void fetch("/telemetry");'],
    ["XMLHttpRequest", "new XMLHttpRequest();"],
    ["WebSocket", 'new WebSocket("/events");'],
    ["EventSource", 'new EventSource("/events");'],
    ["sendBeacon", 'navigator.sendBeacon("/telemetry");'],
    ["serviceWorker", 'void navigator.serviceWorker.register("/worker.js");'],
    ["importScripts", 'importScripts("/worker.js");'],
    ["computed fetch", 'void globalThis["fetch"]("/telemetry");'],
    ["Worker", 'new Worker("/phone-home.js");'],
    ["SharedWorker", 'new SharedWorker("/phone-home.js");'],
    ["WebTransport", "new WebTransport(endpoint);"],
    ["dynamic import", 'void import("/phone-home.js");'],
    ["worklet addModule", 'void CSS.paintWorklet.addModule("/phone-home.js");'],
  ];

  for (const [label, source] of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/phone-home.ts",
          source,
        });
      },
      [
        /packages\/adapters\/vanilla\/src\/phone-home[.]ts/i,
        new RegExp(label.replace("computed ", ""), "i"),
      ],
    );
  }
});

test("resolves constant computed transports, destructuring, Reflect.get, and browser-global aliases", () => {
  const mutations = [
    [
      "const computed fetch",
      'const method = "fetch"; globalThis[method]("/phone-home");',
      /fetch/i,
    ],
    [
      "template computed fetch",
      "globalThis[`fe${'tch'}`](\"/phone-home\");",
      /fetch/i,
    ],
    [
      "computed destructuring",
      'const { ["fetch"]: request } = globalThis; request("/phone-home");',
      /fetch/i,
    ],
    [
      "Reflect.get",
      'Reflect.get(globalThis, "fetch")("/phone-home");',
      /fetch/i,
    ],
    [
      "global alias",
      'const browser = globalThis; browser.fetch("/phone-home");',
      /fetch/i,
    ],
    [
      "computed worklet",
      'const method = "add" + "Module"; CSS.paintWorklet[method]("/phone-home.js");',
      /worklet|addModule/i,
    ],
  ];

  for (const [label, source, issue] of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: `packages/adapters/vanilla/src/${label.replaceAll(" ", "-")}.ts`,
          source,
        });
      },
      [issue],
    );
  }
});

test("tracks exact browser and Reflect provenance through parameters, assignments, and aliases", () => {
  const mutations = [
    [
      "parameter destructuring",
      'function run({ ["fetch"]: request } = globalThis) { request("/phone-home"); } run();',
      /fetch/i,
    ],
    [
      "assignment destructuring",
      'let request; ({ ["fetch"]: request } = window); request("/phone-home");',
      /fetch/i,
    ],
    [
      "Reflect alias",
      'const mirror = Reflect; mirror.get(globalThis, "fetch")("/phone-home");',
      /fetch/i,
    ],
    [
      "destructured Reflect.get",
      'const root = globalThis; const mirror = Reflect; const { ["get"]: read } = mirror; read(root, "fetch")("/phone-home");',
      /fetch/i,
    ],
  ];

  for (const [label, source, issue] of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: `packages/adapters/vanilla/src/${label.replaceAll(" ", "-")}.ts`,
          source,
        });
      },
      [issue],
    );
  }
});

test("propagates browser provenance through mutable and nested assignment targets", () => {
  const mutations = [
    [
      "assigned global alias",
      'let root; root = globalThis; root.fetch("/phone-home");',
      /fetch/i,
    ],
    [
      "assigned Reflect alias",
      'let mirror; mirror = Reflect; mirror.get(globalThis, "fetch")("/phone-home");',
      /fetch/i,
    ],
    [
      "destructured Reflect alias",
      'let reflected; ({ Reflect: reflected } = globalThis); reflected.get(globalThis, "fetch")("/phone-home");',
      /fetch/i,
    ],
    [
      "destructured AudioContext constructor",
      'let Context; ({ AudioContext: Context } = globalThis); new Context().audioWorklet.addModule("/phone-home.js");',
      /worklet|addModule/i,
    ],
    [
      "nested AudioWorklet assignment",
      'let load; ({ audioWorklet: { addModule: load } } = new AudioContext()); load("/phone-home.js");',
      /worklet|addModule/i,
    ],
    [
      "assigned resource element",
      'let script; script = document.createElement("script"); script.src = "https:" + "//telemetry.example/collect";',
      /executable.*URL-shaped/i,
    ],
  ];

  for (const [label, source, issue] of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: `packages/adapters/vanilla/src/${label.replaceAll(" ", "-")}.ts`,
          source,
        });
      },
      [issue],
    );
  }
});

test("fails closed when a mutable browser alias has an ambiguous reassignment", () => {
  for (const source of [
    'let root; root = globalThis; root = maybeLocal; root.fetch("/phone-home");',
    'let mirror; mirror = Reflect; mirror = maybeLocal; mirror.get(globalThis, "fetch")("/phone-home");',
    'let script; script = document.createElement("script"); script = maybeLocal; script.src = "https://telemetry.example/collect";',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/ambiguous-browser-alias.ts",
          source,
        });
      },
      [/ambiguous mutable browser provenance/i],
    );
  }
});

test("pairs array assignment elements and fails closed for lossy browser patterns", () => {
  const mutations = [
    [
      "array element",
      'let root; [root] = [globalThis]; root.fetch("/phone-home");',
      /fetch/i,
    ],
    [
      "nested array element",
      'let root; [[root]] = [[globalThis]]; root.fetch("/phone-home");',
      /fetch/i,
    ],
    [
      "array default",
      'let root; [root = local] = [globalThis]; root.fetch("/phone-home");',
      /ambiguous mutable browser provenance/i,
    ],
    [
      "array rest",
      'let roots; [...roots] = [globalThis]; roots[0].fetch("/phone-home");',
      /ambiguous mutable browser provenance/i,
    ],
  ];

  for (const [label, source, issue] of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: `packages/adapters/vanilla/src/${label.replaceAll(" ", "-")}.ts`,
          source,
        });
      },
      [issue],
    );
  }
});

test("merges conditional browser provenance conservatively", () => {
  const mutations = [
    [
      "browser or local",
      'let root; root = chooseBrowser ? globalThis : local; root.fetch("/phone-home");',
      /ambiguous mutable browser provenance/i,
    ],
    [
      "equivalent browser globals",
      'let root; root = chooseBrowser ? globalThis : window; root.fetch("/phone-home");',
      /fetch/i,
    ],
    [
      "Reflect or local",
      'let mirror; mirror = chooseBrowser ? Reflect : local; mirror.get(globalThis, "fetch")("/phone-home");',
      /ambiguous mutable browser provenance/i,
    ],
  ];

  for (const [label, source, issue] of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: `packages/adapters/vanilla/src/${label.replaceAll(" ", "-")}.ts`,
          source,
        });
      },
      [issue],
    );
  }
});

test("fails closed when known browser provenance is stored in an unsupported property target", () => {
  const mutations = [
    'const holder = {}; holder.root = globalThis; holder.root.fetch("/phone-home");',
    'const holder = {}; holder["mirror"] = Reflect; holder.mirror.get(globalThis, "fetch")("/phone-home");',
    'const holder = { root: globalThis }; holder.root.fetch("/phone-home");',
    'const holder = { nested: {} }; holder.nested.context = new AudioContext(); holder.nested.context.audioWorklet.addModule("/phone-home.js");',
  ];

  for (const source of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/unsupported-browser-storage.ts",
          source,
        });
      },
      [/unsupported property storage of known browser provenance/i],
    );
  }
});

test("allows compound mutable assignments whose provenance remains local", () => {
  const model = validModel();
  model.browserProductionSources.push({
    path: "packages/adapters/vanilla/src/local-compound-assignments.ts",
    source: [
      "declare const chooseFirst: boolean;",
      "const first = { fetch: (_url: string) => undefined };",
      "const second = { fetch: (_url: string) => undefined };",
      "let selected;",
      "selected = chooseFirst ? first : second;",
      'selected.fetch("/local");',
      "let fromArray;",
      "[fromArray = second] = [first];",
      'fromArray.fetch("/local");',
      "let rest;",
      "[...rest] = [first];",
      'rest[0].fetch("/local");',
      "const holder: { root?: typeof first } = {};",
      "holder.root = first;",
      'holder.root.fetch("/local");',
      "const literal = { root: first };",
      'literal.root.fetch("/local");',
      "interface Worker { readonly local: true; }",
      "type SharedWorker = { readonly local: true };",
    ].join("\n"),
  });

  assert.doesNotThrow(() => validateArchitectureModel(model));
});

test("rejects browser roots captured by array binding declarations and parameters", () => {
  for (const source of [
    'const [root] = [globalThis]; root.fetch("/phone-home");',
    'const [[root]] = [[globalThis]]; root.fetch("/phone-home");',
    'const [, root] = [local, globalThis]; root.fetch("/phone-home");',
    'const [root = globalThis] = []; root.fetch("/phone-home");',
    'const [...roots] = [globalThis]; roots[0].fetch("/phone-home");',
    'function run([root] = [globalThis]) { root.fetch("/phone-home"); } run();',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/array-binding-root.ts",
          source,
        });
      },
      [/unsupported direct browser root globalThis/i],
    );
  }
});

test("rejects browser roots hidden by logical and sequence expressions", () => {
  for (const source of [
    'let root; root = maybeLocal || globalThis; root.fetch("/phone-home");',
    'let root; root = globalThis && globalThis; root.fetch("/phone-home");',
    'let root; root = maybeLocal ?? globalThis; root.fetch("/phone-home");',
    'let root; root = (local, globalThis); root.fetch("/phone-home");',
    'let mirror; mirror = maybeLocal || Reflect; mirror.get(supplied, "fetch")("/phone-home");',
    'const Context = (local, AudioContext); new Context().audioWorklet.addModule("/phone-home.js");',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/compound-root.ts",
          source,
        });
      },
      [/unsupported direct browser root (?:globalThis|Reflect|AudioContext)/i],
    );
  }
});

test("rejects browser roots stored through destructuring property targets", () => {
  for (const source of [
    'const holder = {}; [holder.root] = [globalThis]; holder.root.fetch("/phone-home");',
    'const holder = {}; [holder["root"]] = [globalThis]; holder.root.fetch("/phone-home");',
    'const holder = {}; const alias = holder; [alias.root] = [globalThis]; holder.root.fetch("/phone-home");',
    'const holder = {}; ({ root: holder.root } = { root: (local, globalThis) }); holder.root.fetch("/phone-home");',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/destructured-property-root.ts",
          source,
        });
      },
      [/unsupported direct browser root globalThis/i],
    );
  }
});

test("allows compound local, shadowed, type-only, and inert documentation forms", () => {
  const model = validModel();
  model.browserProductionSources.push({
    path: "packages/adapters/vanilla/src/inert-compound-root-names.ts",
    source: [
      "declare const chooseFirst: boolean;",
      "const first = { fetch: (_url: string) => undefined };",
      "const second = { fetch: (_url: string) => undefined };",
      "const [root = second] = [first];",
      'root.fetch("/local");',
      "const selected = chooseFirst ? first : second;",
      'selected.fetch("/local");',
      "const logical = first || second;",
      'logical.fetch("/local");',
      "const sequenced = (first, second);",
      'sequenced.fetch("/local");',
      "const holder: { root?: typeof first } = {};",
      "[holder.root] = [first];",
      'holder.root.fetch("/local");',
      "function inspect(globalThis: unknown, Reflect: unknown, AudioContext: unknown) {",
      "  return [globalThis, Reflect, AudioContext];",
      "}",
      "type GlobalThis = { readonly local: true };",
      "interface ReflectShape { readonly local: true; }",
      'const documentation = "globalThis.fetch https://docs.example/reference";',
      "void inspect; void documentation;",
    ].join("\n"),
  });

  assert.doesNotThrow(() => validateArchitectureModel(model));
});

test("allows only the vetted direct browser root forms used by production", () => {
  const model = validModel();
  model.browserProductionSources.push(
    {
      path: "packages/adapters/vanilla/src/auto.ts",
      source: [
        "(globalThis as { OpenCookie?: object }).OpenCookie = Object.freeze({});",
        "const resolvedDocument =",
        '  typeof globalThis.document === "undefined" ? undefined : globalThis.document;',
        "void resolvedDocument;",
      ].join("\n"),
    },
    {
      path: "packages/adapters/vanilla/src/runtime-guards.ts",
      source: [
        "function resolveDocument(configured: Document | undefined): Document | undefined {",
        "  const resolved =",
        '    configured ?? (typeof document === "undefined" ? undefined : document);',
        "  return resolved;",
        "}",
        "void resolveDocument;",
      ].join("\n"),
    },
    {
      path: "packages/adapters/vue/src/index.ts",
      source: 'const isServer = typeof window === "undefined"; void isServer;',
    },
    {
      path: "packages/core/src/domain/consent-decisioning/evaluate-consent.ts",
      source: [
        "function inspect(decision: object): void {",
        '  void Reflect.get(decision, "purposeId");',
        '  void Reflect.get(decision, "value");',
        "}",
        "void inspect;",
      ].join("\n"),
    },
    {
      path: "packages/core/src/auto/safe-reflect.ts",
      source: [
        "void Reflect.has(source, field);",
        "void Reflect.ownKeys(source);",
        "void Reflect.apply(callback, receiver, []);",
      ].join("\n"),
    },
  );

  assert.doesNotThrow(() => validateArchitectureModel(model));
});

test("rejects near misses outside the vetted direct browser root forms", () => {
  const mutations = [
    {
      path: "packages/adapters/vanilla/src/auto.ts",
      source:
        'const root = globalThis.document; root.defaultView.fetch("/phone-home");',
    },
    {
      path: "packages/adapters/vanilla/src/runtime-guards.ts",
      source:
        'const resolved = document; resolved.defaultView.fetch("/phone-home");',
    },
    {
      path: "packages/core/src/domain/consent-decisioning/evaluate-consent.ts",
      source:
        'function inspect(decision: object) { return Reflect.get(decision, "fetch"); } void inspect;',
    },
    {
      path: "packages/core/src/auto/unsafe-reflect.ts",
      source: 'Reflect.set(target, "request", supplied);',
    },
  ];

  for (const mutation of mutations) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push(mutation);
      },
      [/unsupported direct browser root/i],
    );
  }
});

test("rejects array bindings derived from the vetted document fallback", () => {
  const fallback = [
    "const resolvedDocument =",
    '  typeof globalThis.document === "undefined" ? undefined : globalThis.document;',
  ].join("\n");

  for (const source of [
    'const [root] = [resolvedDocument.defaultView]; root.fetch("/phone-home");',
    'const [[root]] = [[resolvedDocument.defaultView]]; root.fetch("/phone-home");',
    'const [, root] = [local, resolvedDocument.defaultView]; root.fetch("/phone-home");',
    'const [root = resolvedDocument.defaultView] = []; root.fetch("/phone-home");',
    'let root; [root = resolvedDocument.defaultView] = []; root.fetch("/phone-home");',
    'const [...roots] = [resolvedDocument.defaultView]; roots[0].fetch("/phone-home");',
    'function run([root] = [resolvedDocument.defaultView]) { root.fetch("/phone-home"); } run();',
    'const tuple = [resolvedDocument.defaultView]; const [root] = tuple; root.fetch("/phone-home");',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/auto.ts",
          source: `${fallback}\n${source}`,
        });
      },
      [/browser provenance/i],
    );
  }
});

test("rejects property targets derived from the vetted document fallback", () => {
  const fallback = [
    "const resolvedDocument =",
    '  typeof globalThis.document === "undefined" ? undefined : globalThis.document;',
  ].join("\n");

  for (const source of [
    'const holder = {}; [holder.root] = [resolvedDocument.defaultView]; holder.root.fetch("/phone-home");',
    'const holder = {}; [holder["root"]] = [resolvedDocument.defaultView]; holder.root.fetch("/phone-home");',
    'const holder = {}; const alias = holder; [alias.root] = [resolvedDocument.defaultView]; holder.root.fetch("/phone-home");',
    'const holder = {}; ({ root: holder.root } = { root: resolvedDocument.defaultView }); holder.root.fetch("/phone-home");',
    'const tuple = [resolvedDocument.defaultView]; const holder = {}; [holder.root] = tuple; holder.root.fetch("/phone-home");',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/auto.ts",
          source: `${fallback}\n${source}`,
        });
      },
      [/browser provenance/i],
    );
  }
});

test("tracks AudioWorklet provenance through global constructors and nested destructuring", () => {
  for (const source of [
    'const { audioWorklet: { addModule: load } } = new AudioContext(); load("/phone-home.js");',
    'void new globalThis.AudioContext().audioWorklet.addModule("/phone-home.js");',
    'void new globalThis.webkitAudioContext().audioWorklet.addModule("/phone-home.js");',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/audio-worklet-egress.ts",
          source,
        });
      },
      [/worklet|addModule/i],
    );
  }
});

test("fails closed for unresolved computed access on known browser globals", () => {
  for (const source of [
    'globalThis[method]("/phone-home");',
    'window[method]("/phone-home");',
    'Reflect.get(self, method)("/phone-home");',
    'const { [method]: request } = globalThis; request("/phone-home");',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/adapters/vanilla/src/unresolved-browser-access.ts",
          source,
        });
      },
      [/unresolved computed access/i],
    );
  }
});

test("allows shadowed local names instead of treating property spelling as browser egress", () => {
  const model = validModel();
  model.browserProductionSources.push({
    path: "packages/adapters/vanilla/src/local-names.ts",
    source: [
      "const fetch = { local: true };",
      "void fetch.local;",
      "const port = { sendBeacon: () => true };",
      "void port.sendBeacon();",
      "const Worker = class {};",
      "void new Worker();",
      "function inspect(globalThis) { return globalThis.fetch; }",
      "interface SharedWorker { readonly local: true; }",
      "type Worker = { readonly local: true };",
    ].join("\n"),
  });

  assert.doesNotThrow(() => validateArchitectureModel(model));
});

test("rejects constant-folded external URLs at executable resource-loading sinks", () => {
  for (const source of [
    'const value = "https:" + "//telemetry.example/collect"; document.createElement("script").src = value;',
    'const value = `${\'https\'}://telemetry.example/collect`; document.createElement("iframe").setAttribute("src", value);',
    'const value = "//telemetry.example/collect"; location.assign(value);',
    'const scheme = "wss"; const value = scheme + "://telemetry.example/events"; new WebSocket(value);',
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push({
          path: "packages/core/src/phone-home.ts",
          source,
        });
      },
      [/packages\/core\/src\/phone-home[.]ts/i, /executable.*URL-shaped/i],
    );
  }
});

test("allows inert help, diagnostics, and documentation URL strings", () => {
  const model = validModel();
  model.browserProductionSources.push({
    path: "packages/core/src/documentation-link.ts",
    source: [
      'const help = "Read https:" + "//docs.example/setup";',
      "const diagnostic = `${'https'}://status.example/incidents`;",
      'const documentation = "//docs.example/reference";',
      "console.info(help, documentation);",
      "void new Error(diagnostic);",
    ].join("\n"),
  });
  assert.doesNotThrow(() => validateArchitectureModel(model));
});

test("allows URL parsing that does not reach a network or resource-loading sink", () => {
  const model = validModel();
  for (const source of [
    "const parsed = new URL(`http://${input}/`);",
    "const parsed = new URL(`https://${input}/`);",
    "const parsed = new URL(`http://${host}/`);",
    'const parsed = new URL("https://docs.example/reference");',
  ]) {
    model.browserProductionSources[0].source = source;
    assert.doesNotThrow(() => validateArchitectureModel(model));
  }
});

test("does not scan tests, docs, fixtures, or the Node CLI", () => {
  const model = validModel();
  for (const path of [
    "packages/core/src/runtime.test.ts",
    "packages/adapters/vanilla/src/runtime.spec.ts",
    "packages/adapters/nuxt/test-fixture/runtime.ts",
    "packages/cli/src/index.ts",
    "apps/docs/src/content/docs/phone-home.ts",
  ]) {
    model.browserProductionSources.push({
      path,
      source:
        'fetch("https://telemetry.example/collect"); navigator.sendBeacon("/collect");',
    });
  }

  assert.doesNotThrow(() => validateArchitectureModel(model));
});

test("rejects malformed production source instead of scanning a partial AST", () => {
  expectIssues(
    (model) => {
      model.browserProductionSources.push({
        path: "packages/adapters/vanilla/src/broken.ts",
        source: "export const broken = ;",
      });
    },
    [/broken[.]ts.*parse diagnostic/i],
  );
});

test("scans and rejects test or fixture modules reached from production imports", () => {
  for (const [importPath, reachedPath] of [
    ["./phone-home.test.js", "phone-home.test.ts"],
    ["./fixtures/phone-home.js", "fixtures/phone-home.ts"],
  ]) {
    expectIssues(
      (model) => {
        model.browserProductionSources.push(
          {
            path: "packages/adapters/vanilla/src/production-import.ts",
            source: `import ${JSON.stringify(importPath)};`,
          },
          {
            path: `packages/adapters/vanilla/src/${reachedPath}`,
            source: 'fetch("https://telemetry.example/collect");',
          },
        );
      },
      [/production-import[.]ts.*excluded-looking source/i, /fetch/i],
    );
  }
});

test("keeps genuinely unreachable tests and fixtures outside the production scan", () => {
  const model = validModel();
  model.browserProductionSources.push(
    {
      path: "packages/core/src/unreachable.test.ts",
      source: "export const broken = ; fetch('https://telemetry.example');",
    },
    {
      path: "packages/adapters/vanilla/src/fixtures/unreachable.ts",
      source: "export const broken = ; new Worker('/phone-home.js');",
    },
  );

  assert.doesNotThrow(() => validateArchitectureModel(model));
});

test("rejects source symlinks before they can disappear from the inventory", () => {
  expectIssues(
    (model) => {
      model.browserProductionSources.push({
        path: "packages/adapters/vanilla/src/linked-runtime.ts",
        source: "",
        isSymbolicLink: true,
      });
    },
    [/linked-runtime[.]ts.*symbolic link/i],
  );
});

test("cross-checks discovered packages against the authoritative workspace inventory", () => {
  expectIssues(
    (model) => {
      model.workspacePackageDirectories = ["packages/core"];
    },
    [/workspace package inventory.*packages\/adapters\/vanilla/i],
  );

  expectIssues(
    (model) => {
      model.workspacePackageDirectories.push("packages/adapters/react");
    },
    [/workspace package inventory.*packages\/adapters\/react/i],
  );

  expectIssues(
    (model) => {
      model.workspacePackageSymlinks.push("packages/adapters/linked-package");
    },
    [/linked-package.*symbolic link/i],
  );
});

test("normalizes Windows source paths while enforcing browser egress", () => {
  expectIssues(
    (model) => {
      model.browserProductionSources.push({
        path: "packages\\adapters\\vanilla\\src\\windows-egress.ts",
        source: 'fetch("/phone-home");',
      });
    },
    [/packages\/adapters\/vanilla\/src\/windows-egress[.]ts.*fetch/i],
  );
});

test("reports and requires a scanned source count for every browser package", () => {
  const result = validateArchitectureModel(validModel());
  assert.deepEqual(result.browserSourceCounts, {
    "@opencookie-dev/core": 1,
    "@opencookie-dev/vanilla": 1,
  });

  expectIssues(
    (model) => {
      model.packages.push(
        browserPackage("packages/adapters/react", "@opencookie-dev/react"),
      );
      model.workspacePackageDirectories.push("packages/adapters/react");
    },
    [/@opencookie-dev\/react.*scanned source inventory/i],
  );
});

test("the live manifest collector fails closed for production mutations", () => {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const vanillaSource = join(
    repositoryRoot,
    "packages",
    "adapters",
    "vanilla",
    "src",
  );
  const livePath = join(vanillaSource, "architecture-live-mutation.ts");
  const reachedPath = join(vanillaSource, "architecture-live-mutation.test.ts");
  const targetPath = join(vanillaSource, "architecture-live-target.ts");
  const linkedPath = join(vanillaSource, "architecture-live-link.ts");
  const workspacePath = join(repositoryRoot, "pnpm-workspace.yaml");
  const workspaceSource = readFileSync(workspacePath, "utf8");
  const linkedPackagePath = join(
    repositoryRoot,
    "packages",
    "adapters",
    "architecture-live-package",
  );
  let linkedPackageTarget;

  const mutations = [
    {
      label: "primitive",
      expected: /architecture-live-mutation[.]ts.*Worker/i,
      setup() {
        writeFileSync(livePath, 'new Worker("/phone-home.js");\n');
      },
    },
    {
      label: "URL-shaped value",
      expected: /architecture-live-mutation[.]ts.*URL-shaped value/i,
      setup() {
        writeFileSync(
          livePath,
          'const value = "https:" + "//telemetry.example/collect"; document.createElement("script").src = value;\n',
        );
      },
    },
    {
      label: "parse diagnostic",
      expected: /architecture-live-mutation[.]ts.*parse diagnostic/i,
      setup() {
        writeFileSync(livePath, "export const broken = ;\n");
      },
    },
    {
      label: "production-reachable fixture",
      expected:
        /imports excluded-looking source.*architecture-live-mutation[.]test[.]ts/i,
      setup() {
        writeFileSync(
          livePath,
          'import "./architecture-live-mutation.test.js";\n',
        );
        writeFileSync(reachedPath, 'fetch("/phone-home");\n');
      },
    },
    {
      label: "source symlink",
      expected: /architecture-live-link[.]ts.*symbolic link/i,
      skip: process.platform === "win32",
      setup() {
        writeFileSync(targetPath, "export const local = true;\n");
        symlinkSync(targetPath, linkedPath);
      },
    },
    {
      label: "workspace package symlink",
      expected: /architecture-live-package.*symbolic link/i,
      skip: process.platform === "win32",
      setup() {
        linkedPackageTarget = mkdtempSync(
          join(tmpdir(), "opencookie-arch-package-"),
        );
        writeFileSync(
          join(linkedPackageTarget, "package.json"),
          '{"name":"@opencookie-dev/architecture-live-package"}\n',
        );
        symlinkSync(linkedPackageTarget, linkedPackagePath, "dir");
      },
    },
    {
      label: "workspace inventory mismatch",
      expected: /workspace package inventory.*packages\/(?:cli|core)/i,
      setup() {
        const changedWorkspace = workspaceSource.replace(
          "  - packages/*\n",
          "",
        );
        assert.notEqual(changedWorkspace, workspaceSource);
        writeFileSync(workspacePath, changedWorkspace);
      },
    },
  ];

  function cleanup() {
    for (const path of [livePath, reachedPath, targetPath, linkedPath]) {
      rmSync(path, { force: true });
    }
    rmSync(linkedPackagePath, { force: true, recursive: true });
    if (linkedPackageTarget !== undefined) {
      rmSync(linkedPackageTarget, { force: true, recursive: true });
      linkedPackageTarget = undefined;
    }
    writeFileSync(workspacePath, workspaceSource);
  }

  function assertMutationCleanup() {
    const result = spawnSync(
      "git",
      [
        "status",
        "--short",
        "--",
        "pnpm-workspace.yaml",
        "packages/adapters/architecture-live-package",
        "packages/adapters/vanilla/src/architecture-live-link.ts",
        "packages/adapters/vanilla/src/architecture-live-mutation.test.ts",
        "packages/adapters/vanilla/src/architecture-live-mutation.ts",
        "packages/adapters/vanilla/src/architecture-live-target.ts",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", "live architecture mutation leaked state");
    assert.equal(readFileSync(workspacePath, "utf8"), workspaceSource);
  }

  try {
    for (const mutation of mutations) {
      cleanup();
      if (mutation.skip === true) continue;
      mutation.setup();
      const result = runLiveArchitectureManifest(repositoryRoot);
      assert.notEqual(
        result.status,
        0,
        `${mutation.label} unexpectedly passed live arch:manifests\n${result.stdout}${result.stderr}`,
      );
      assert.match(
        `${result.stdout}${result.stderr}`,
        /Architecture verification failed/i,
      );
      assert.match(`${result.stdout}${result.stderr}`, mutation.expected);
      cleanup();
      assertMutationCleanup();
    }
  } finally {
    cleanup();
    assertMutationCleanup();
  }
});

test("requires TypeScript and committed API contracts for every package", () => {
  expectIssues(
    (model) => {
      model.packages[1].hasApiReport = false;
      model.packages[1].hasTsconfig = false;
    },
    [/vanilla.*API report/i, /vanilla.*tsconfig/i],
  );
});

test("domain boundary catches outward imports through the core root barrel", () => {
  const domainRule = cruiseConfig.forbidden.find(
    (rule) => rule.name === "domain-no-outward-imports",
  );
  const from = "packages/core/src/domain/policy-catalogue/root-bypass.ts";

  assert.ok(domainRule);
  assert.equal(
    dependencyMatchesRule(domainRule, from, "packages/core/src/index.ts"),
    true,
  );
  assert.equal(
    dependencyMatchesRule(
      domainRule,
      from,
      "packages/core/src/application/index.ts",
    ),
    true,
  );
  assert.equal(
    dependencyMatchesRule(
      domainRule,
      from,
      "packages/core/src/infrastructure/index.ts",
    ),
    true,
  );
  assert.equal(
    dependencyMatchesRule(
      domainRule,
      from,
      "packages/core/src/domain/shared/contracts.ts",
    ),
    false,
  );
});

test("application imports domains through context or runtime boundaries", () => {
  const entrypointRule = cruiseConfig.forbidden.find(
    (rule) => rule.name === "application-domain-entrypoints-only",
  );
  const from = "packages/core/src/application/runtime/rehydrate.ts";

  assert.ok(entrypointRule);
  assert.equal(
    dependencyMatchesRule(
      entrypointRule,
      from,
      "packages/core/src/domain/consent-decisioning/consent-record.ts",
    ),
    true,
  );
  assert.equal(
    dependencyMatchesRule(
      entrypointRule,
      from,
      "packages/core/src/domain/consent-decisioning/index.ts",
    ),
    false,
  );
  assert.equal(
    dependencyMatchesRule(
      entrypointRule,
      from,
      "packages/core/src/domain/consent-decisioning/runtime.ts",
    ),
    false,
  );
});

test("API Extractor fails forgotten nested exports instead of hiding API drift", () => {
  assert.deepEqual(
    apiExtractorConfig.messages?.extractorMessageReporting?.[
      "ae-forgotten-export"
    ],
    {
      logLevel: "error",
      addToApiReportFile: false,
    },
  );
});

test("verify arch builds package exports before dependency resolution", () => {
  const steps = rootManifest.scripts["verify:arch"]
    .split("&&")
    .map((step) => step.trim());
  const build = steps.indexOf("pnpm build");
  const imports = steps.indexOf("pnpm arch:imports");

  assert.notEqual(build, -1);
  assert.notEqual(imports, -1);
  assert.ok(
    build < imports,
    "pnpm build must run before dependency-cruiser resolves workspace exports in a clean clone",
  );
});

test("dependency resolution includes modern conditional package exports", () => {
  assert.deepEqual(cruiseConfig.options.enhancedResolveOptions, {
    conditionNames: ["types", "svelte", "import", "require", "node", "default"],
    exportsFields: ["exports"],
    mainFields: ["module", "main", "types", "typings"],
  });
});

test("limits the Nuxt self-reference exception to its two packed-consumer fixtures", () => {
  const unresolvedRule = cruiseConfig.forbidden.find(
    (rule) => rule.name === "no-unresolvable",
  );

  assert.deepEqual(unresolvedRule?.from, {
    pathNot:
      "^packages/adapters/nuxt/test-fixture/(?:app[.]vue|nuxt[.]config[.]ts)$",
  });
});

test("emits a portable public declaration for the Nuxt module", () => {
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const compiler = fileURLToPath(
    new URL("../node_modules/typescript/bin/tsc", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      compiler,
      "--build",
      "packages/adapters/nuxt",
      "--pretty",
      "false",
      "--force",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
