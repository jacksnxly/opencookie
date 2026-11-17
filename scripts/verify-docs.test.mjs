import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as docsVerifier from "./verify-docs-lib.mjs";
import { ensureDocsDependencyLink } from "./verify-docs-bootstrap.mjs";
import {
  collectDocsContractIssues,
  collectInternalLinkIssues,
  collectRunnableSampleIds,
} from "./verify-docs-lib.mjs";
import {
  exportedSymbols,
  generateApiReference,
} from "./verify-docs-generate-api.mjs";
import { DX_CASES } from "./e2e/dx-catalogue.mjs";

const verifierRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const releaseDocsDependencyLink = await ensureDocsDependencyLink({
  docsRoot: path.join(verifierRepositoryRoot, "apps/docs"),
  repoRoot: verifierRepositoryRoot,
});
const { Window } = await import("happy-dom");
after(releaseDocsDependencyLink);

function rgb(color) {
  const shortHex = color.match(/^#([\da-f])([\da-f])([\da-f])$/iu);
  if (shortHex) {
    return shortHex.slice(1).map((part) => Number.parseInt(part + part, 16));
  }
  const hex = color.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu);
  if (hex) return hex.slice(1).map((part) => Number.parseInt(part, 16));
  const functional = color.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/iu,
  );
  if (functional) return functional.slice(1).map(Number);
  throw new TypeError(`Unsupported computed color: ${color}`);
}

function relativeLuminance([red, green, blue]) {
  const linear = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background, opacity = 1) {
  const composite = foreground.map(
    (channel, index) => channel * opacity + background[index] * (1 - opacity),
  );
  const lighter = Math.max(
    relativeLuminance(composite),
    relativeLuminance(background),
  );
  const darker = Math.min(
    relativeLuminance(composite),
    relativeLuminance(background),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-docs-verifier-"));
  const docsRoot = path.join(root, "docs");
  const samplesRoot = path.join(root, "samples");
  const distRoot = path.join(root, "dist");
  await Promise.all([
    mkdir(docsRoot, { recursive: true }),
    mkdir(samplesRoot, { recursive: true }),
    mkdir(path.join(distRoot, "guide"), { recursive: true }),
  ]);
  return { distRoot, docsRoot, root, samplesRoot };
}

test("collectRunnableSampleIds reads explicit sample components", () => {
  const source = [
    '<RunnableSample id="core-client" />',
    '<RunnableSample id="react-provider"></RunnableSample>',
  ].join("\n");

  assert.deepEqual(collectRunnableSampleIds(source), [
    "core-client",
    "react-provider",
  ]);
});

test("standalone docs verification provides an app-local dependency bootstrap", async () => {
  const bootstrap = await import("./verify-docs-bootstrap.mjs").catch(
    () => ({}),
  );
  assert.equal(typeof bootstrap.ensureDocsDependencyLink, "function");
});

test("core source typechecks from the docs consumer configuration", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(verifierRepositoryRoot, "node_modules/typescript/bin/tsc"),
      "--project",
      path.join(verifierRepositoryRoot, "apps/docs/tsconfig.samples.json"),
      "--pretty",
      "false",
    ],
    {
      cwd: verifierRepositoryRoot,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  );
});

test("API extraction includes named and default package exports", () => {
  assert.deepEqual(
    exportedSymbols(
      [
        "export interface Client {}",
        "export { createClient }",
        "export default createClient;",
      ].join("\n"),
    ),
    [
      { kind: "interface", name: "Client" },
      { kind: "re-export", name: "createClient" },
      { kind: "default", name: "default" },
    ],
  );
});

test("generated API reference ends with exactly one newline", async () => {
  const generated = await generateApiReference();

  assert.equal(generated.endsWith("\n"), true);
  assert.equal(generated.endsWith("\n\n"), false);
});

test("generated API reference maps each API report to its public subpath", async () => {
  const paths = await fixture();
  const packageRoot = path.join(paths.root, "packages/core");
  await mkdir(packageRoot, { recursive: true });
  await Promise.all([
    mkdir(path.join(packageRoot, "etc"), { recursive: true }),
    mkdir(path.join(packageRoot, "temp"), { recursive: true }),
    writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@fixture/core" }),
    ),
  ]);
  const snapshots = new Map([
    ["core.api.md", "export declare function createFixture(): void;\n"],
    [
      "core-application.api.md",
      "export declare function executeFixture(): void;\n",
    ],
    ["core-domain.api.md", "export declare function defineFixture(): void;\n"],
    [
      "core-infrastructure.api.md",
      "export declare function adaptFixture(): void;\n",
    ],
  ]);
  await Promise.all([
    ...[...snapshots].map(([name, snapshot]) =>
      writeFile(path.join(packageRoot, "etc", name), snapshot),
    ),
    writeFile(
      path.join(packageRoot, "temp/core.api.md"),
      snapshots.get("core.api.md"),
    ),
  ]);

  const generated = await generateApiReference({
    packagesRoot: path.join(paths.root, "packages"),
  });
  assert.equal(generated.match(/^## `@fixture\/core`$/gmu)?.length, 1);
  for (const subpath of ["application", "domain", "infrastructure"]) {
    const heading = `## \`@fixture/core/${subpath}\``;
    assert.equal(
      generated.split("\n").filter((line) => line === heading).length,
      1,
    );
  }
});

test("plain HTML CDN sample matches the auto bundle contract", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const source = await readFile(
    path.join(repositoryRoot, "apps/docs/samples/cdn-one-line.sample.ts"),
    "utf8",
  );

  assert.match(source, /\/dist\/auto\.iife\.js/u);
  for (const attribute of [
    "data-oc-policy-version",
    "data-oc-storage-key",
    "data-oc-purpose-id",
    "data-oc-purpose-label",
    "data-oc-purpose-description",
  ]) {
    assert.match(source, new RegExp(attribute, "u"));
  }
});

test("iframe blocking sample uses the non-navigable template contract", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const sample = await readFile(
    path.join(repositoryRoot, "apps/docs/samples/iframe-blocking.sample.ts"),
    "utf8",
  );
  const guide = await readFile(
    path.join(
      repositoryRoot,
      "apps/docs/src/content/docs/recipes/iframe-blocking.mdx",
    ),
    "utf8",
  );

  assert.match(sample, /<template/u);
  assert.match(sample, /data-oc-iframe/u);
  assert.doesNotMatch(sample, /<iframe title=/u);
  assert.match(guide, /non-navigable `template`/u);
});

test("Consent Mode guide keeps Basic mode as the documented default", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const sample = await readFile(
    path.join(repositoryRoot, "apps/docs/samples/consent-mode.sample.ts"),
    "utf8",
  );
  const guide = await readFile(
    path.join(repositoryRoot, "apps/docs/src/content/docs/recipes/signals.mdx"),
    "utf8",
  );

  assert.doesNotMatch(sample, /mode:\s*["']advanced["']/u);
  assert.doesNotMatch(sample, /waitForUpdateMs/u);
  assert.match(guide, /optional Google tags remain blocked/u);
  assert.match(guide, /affirmative consent/u);
  assert.match(guide, /cookieless (?:pings|measurements)/u);
  assert.match(guide, /denied default[\s\S]*update/u);
  assert.match(guide, /withdraw[\s\S]*denied/u);
  assert.match(guide, /Sec-GPC[\s\S]*exact value `1`/u);
  assert.match(guide, /synthetic[\s\S]*browser/u);
  assert.match(guide, /https:\/\/www\.w3\.org\/TR\/gpc\//u);
  assert.match(
    guide,
    /https:\/\/developers\.google\.com\/tag-platform\/security\/guides\/consent/u,
  );
});

test("decision lifecycle guide documents verified expiry and withdrawal behavior", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const guide = await readFile(
    path.join(
      repositoryRoot,
      "apps/docs/src/content/docs/recipes/decision-lifecycle.mdx",
    ),
    "utf8",
  );
  const sample = await readFile(
    path.join(repositoryRoot, "apps/docs/samples/decision-lifecycle.sample.ts"),
    "utf8",
  );

  assert.match(guide, /consentDurationMs/u);
  assert.match(guide, /initializ[ei][\s\S]*expired/u);
  assert.match(guide, /bootstrapOpenCookie\(\)[\s\S]*refresh/u);
  assert.match(guide, /headless[\s\S]*refresh\(\)/u);
  assert.doesNotMatch(guide, /no background timer/u);
  assert.doesNotMatch(
    guide,
    /re-block(?:ed|s)?(?: optional resources)? before (?:publishing )?the expired snapshot/u,
  );
  assert.match(guide, /withdrawConsent\(\)/u);
  assert.match(guide, /re-block/u);
  assert.match(sample, /withdrawConsent\(\)/u);
  assert.match(sample, /\.refresh\(\)/u);
  assert.match(sample, /status !== "expired"/u);
  assert.doesNotMatch(sample, /reloaded/u);
});

test("policy version guide uses verified current-inclusive history", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const [
    guide,
    sample,
    sampleSupport,
    eventStorming,
    coreReadme,
    vanillaReadme,
  ] = await Promise.all([
    readFile(
      path.join(
        repositoryRoot,
        "apps/docs/src/content/docs/recipes/policy-versioning.mdx",
      ),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "apps/docs/samples/policy-version.sample.ts"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "apps/docs/samples/_support.ts"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "docs/domain/EVENT-STORMING.md"),
      "utf8",
    ),
    readFile(path.join(repositoryRoot, "packages/core/README.md"), "utf8"),
    readFile(
      path.join(repositoryRoot, "packages/adapters/vanilla/README.md"),
      "utf8",
    ),
  ]);

  assert.match(guide, /current-inclusive/u);
  assert.match(guide, /policyHistory/u);
  assert.match(guide, /derives[\s\S]*change set/u);
  assert.match(guide, /unaffected[\s\S]*carry forward/u);
  assert.match(guide, /current-only[\s\S]*auto/u);
  assert.doesNotMatch(guide, /Pass the resulting change set/u);
  assert.match(sample, /policyHistory:\s*\[currentPolicy, previousPolicy\]/u);
  assert.match(sample, /status !== "requires-reconsent"/u);
  assert.match(sample, /catalogue-2026-08/u);
  assert.match(sample, /catalogue-2026-09/u);
  assert.match(sampleSupport, /policyHistory:\s*\[policySnapshot\]/u);
  assert.match(eventStorming, /derives[\s\S]*PolicyChangeSet/u);
  assert.match(eventStorming, /ConsentPolicyReconciliation/u);
  assert.doesNotMatch(
    eventStorming,
    /ReconcilePolicy` evaluates an existing ConsentRecord against the change set/u,
  );
  assert.doesNotMatch(eventStorming, /runtime-derived ReconsentPlan/u);
  assert.match(coreReadme, /exposes six explicit/u);
  assert.doesNotMatch(coreReadme, /six explicit, self-contained/u);
  assert.match(coreReadme, /@opencookie-dev\/core\/reconciliation/u);
  assert.match(coreReadme, /root-only headless/u);
  assert.match(vanillaReadme, /current-inclusive/u);
  assert.match(vanillaReadme, /current-only auto/u);
  assert.doesNotMatch(vanillaReadme, /re-block[\s\S]*before publishing/u);
});

test("root README gives a complete safe entrypoint", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");

  assert.match(readme, /npx --yes opencookie@0\.4\.2 init --yes/u);
  for (const adapter of [
    "@opencookie-dev/astro",
    "@opencookie-dev/next",
    "@opencookie-dev/nuxt",
    "@opencookie-dev/react",
    "@opencookie-dev/svelte",
    "@opencookie-dev/vanilla",
    "@opencookie-dev/vue",
  ]) {
    assert.ok(readme.includes(adapter), `README is missing ${adapter}.`);
  }
  assert.match(readme, /technical tool, not legal advice/u);
  assert.match(readme, /\/getting-started\//u);
});

test("black-box prerequisites pin the verified runtime and unattended initializer", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const [readme, installGuide] = await Promise.all([
    readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    readFile(
      path.join(
        repositoryRoot,
        "apps/docs/src/content/docs/getting-started/index.mdx",
      ),
      "utf8",
    ),
  ]);

  for (const source of [readme, installGuide]) {
    assert.match(source, /Node\.js `>=22\.12\.0`/u);
    assert.match(source, /Node\.js `24\.19\.0`/u);
    assert.match(source, /pnpm `11\.22\.0`/u);
    assert.match(source, /npx --yes opencookie@0\.4\.2 init --yes/u);
  }
});

async function currentDxDocsContracts(dxDocsVerifier) {
  const sampleVerifier = await import("./verify-docs-samples-lib.mjs");
  const sample = sampleVerifier.extractDisplayedSample(
    await readFile(
      path.join(
        verifierRepositoryRoot,
        "apps/docs/samples/plain-minimal.sample.ts",
      ),
      "utf8",
    ),
    "plain-minimal.sample.ts",
  );
  return dxDocsVerifier.buildDxDocsContracts(DX_CASES, {
    plainMinimalSource: sample.source,
  });
}

test("framework quick starts stay synchronized with the packed DX catalogue", async () => {
  const dxDocsVerifier = await import("./verify-docs-dx-contract.mjs").catch(
    () => ({}),
  );
  assert.equal(typeof dxDocsVerifier.buildDxDocsContracts, "function");
  assert.equal(typeof dxDocsVerifier.collectDxDocsIssues, "function");
  if (
    typeof dxDocsVerifier.buildDxDocsContracts !== "function" ||
    typeof dxDocsVerifier.collectDxDocsIssues !== "function"
  ) {
    return;
  }

  const contracts = await currentDxDocsContracts(dxDocsVerifier);
  assert.equal(contracts.length, 9);
  assert.match(
    contracts.find(({ id }) => id === "next-app").scaffold,
    /--import-alias '@\/\*'/u,
  );
  assert.deepEqual(contracts.find(({ id }) => id === "nuxt").allowBuilds, [
    "esbuild",
  ]);

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  assert.deepEqual(
    await dxDocsVerifier.collectDxDocsIssues({
      definitions: DX_CASES,
      docsRoot: path.join(
        repositoryRoot,
        "apps/docs/src/content/docs/getting-started",
      ),
    }),
    [],
  );
});

test("every getting-started guide publishes real browser evidence", async () => {
  const screenshotStages = [
    "banner-preconsent",
    "preferences-open",
    "withdrawal-reload-blocked",
  ];
  const guideSlugs = [
    "plain-html",
    "react-vite",
    "vue-vite",
    "next-app",
    "next-pages",
    "nuxt",
    "sveltekit",
    "astro",
  ];

  for (const guideSlug of guideSlugs) {
    const guide = await readFile(
      path.join(
        verifierRepositoryRoot,
        "apps/docs/src/content/docs/getting-started",
        `${guideSlug}.mdx`,
      ),
      "utf8",
    );
    assert.match(
      guide,
      /Observed output:/u,
      `${guideSlug} must record the fresh-app command result.`,
    );

    for (const screenshotStage of screenshotStages) {
      const publicPath = `/images/getting-started/${guideSlug}/${screenshotStage}.png`;
      assert.ok(
        guide.includes(publicPath),
        `${guideSlug} must publish ${screenshotStage} browser evidence.`,
      );
      const image = await readFile(
        path.join(
          verifierRepositoryRoot,
          "apps/docs/public",
          publicPath.slice(1),
        ),
      );
      assert.equal(
        image.subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a",
        `${publicPath} must be a PNG file.`,
      );
    }
  }
});

test("one DX workflow contract drives documented and Pass C command order", async (t) => {
  const workflow = await import("./e2e/dx-catalogue.mjs").catch(() => ({}));
  assert.equal(typeof workflow.buildDxWorkflowContracts, "function");
  assert.equal(typeof workflow.passCCheckIdsForDefinition, "function");
  if (
    typeof workflow.buildDxWorkflowContracts !== "function" ||
    typeof workflow.passCCheckIdsForDefinition !== "function"
  ) {
    return;
  }

  const contracts = workflow.buildDxWorkflowContracts(DX_CASES);
  const plain = contracts.find(({ id }) => id === "plain-cdn");
  const react = contracts.find(({ id }) => id === "react-vite");
  const nuxt = contracts.find(({ id }) => id === "nuxt");
  const astro = contracts.find(({ id }) => id === "astro");
  assert.ok(plain);
  assert.ok(react);
  assert.ok(nuxt);
  assert.ok(astro);

  assert.deepEqual(
    plain.documentedSteps.map(({ id }) => id),
    ["scaffold", "document", "install", "init", "build", "serve"],
  );
  const plainServe = plain.documentedSteps.find(({ id }) => id === "serve");
  const reactServe = react.documentedSteps.find(({ id }) => id === "serve");
  const nuxtServe = nuxt.documentedSteps.find(({ id }) => id === "serve");
  assert.ok(plainServe);
  assert.ok(reactServe);
  assert.ok(nuxtServe);
  assert.equal(
    workflow.renderDxWorkflowCommand(plainServe.command),
    "python3 -m http.server 4173",
  );
  assert.equal(
    workflow.renderDxWorkflowCommand(reactServe.command),
    "pnpm preview --host 127.0.0.1 --port 4173",
  );
  assert.equal(
    workflow.renderDxWorkflowCommand(nuxtServe.command),
    "node .output/server/index.mjs",
  );
  assert.deepEqual(workflow.passCCheckIdsForDefinition(plain.definition), [
    "scaffold",
    "document",
    "init",
    "test-manifest",
    "test-setup",
    "browser-setup",
    "render",
    "persistence",
  ]);
  assert.deepEqual(workflow.passCCheckIdsForDefinition(react.definition), [
    "scaffold",
    "install",
    "init",
    "build",
    "test-setup",
    "browser-setup",
    "render",
    "persistence",
  ]);
  for (const contract of [nuxt, astro]) {
    const ids = workflow.passCCheckIdsForDefinition(contract.definition);
    assert.ok(ids.indexOf("approve-builds") < ids.indexOf("install"));
    assert.ok(ids.indexOf("install") < ids.indexOf("init"));
    const approval = contract.documentedSteps.find(
      ({ id }) => id === "approve-builds",
    );
    assert.ok(approval);
    assert.match(approval.command.args.at(-1), /flag:\s*["']wx["']/u);
  }

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const sampleVerifier = await import("./verify-docs-samples-lib.mjs");
  const displayed = sampleVerifier.extractDisplayedSample(
    await readFile(
      path.join(repositoryRoot, "apps/docs/samples/plain-minimal.sample.ts"),
      "utf8",
    ),
    "plain-minimal.sample.ts",
  );
  const exactPlain = workflow
    .buildDxWorkflowContracts(DX_CASES, {
      plainMinimalSource: displayed.source,
    })
    .find(({ id }) => id === "plain-cdn");
  const document = exactPlain.documentedSteps.find(
    ({ id }) => id === "document",
  );
  const consumer = await mkdtemp(path.join(tmpdir(), "opencookie-plain-doc-"));
  t.after(() => rm(consumer, { force: true, recursive: true }));
  const result = spawnSync(document.command.command, document.command.args, {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(path.join(consumer, "index.html"), "utf8"),
    displayed.source,
  );
  await assert.rejects(
    readFile(path.join(consumer, "package.json")),
    /ENOENT/u,
  );
  const testManifest = workflow.passCInnerCommand(
    exactPlain.definition,
    "test-manifest",
    {},
  );
  assert.match(testManifest.args.at(-1), /flag:\s*["']wx["']/u);
  const manifestResult = spawnSync(testManifest.command, testManifest.args, {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(manifestResult.status, 0, manifestResult.stderr);
  const repeatedManifest = spawnSync(testManifest.command, testManifest.args, {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.notEqual(repeatedManifest.status, 0);
});

test("the DX docs verifier detects a command that drifts from the catalogue", async () => {
  const dxDocsVerifier = await import("./verify-docs-dx-contract.mjs").catch(
    () => ({}),
  );
  assert.equal(typeof dxDocsVerifier.buildDxDocsContracts, "function");
  assert.equal(typeof dxDocsVerifier.collectDxDocsIssues, "function");
  if (
    typeof dxDocsVerifier.buildDxDocsContracts !== "function" ||
    typeof dxDocsVerifier.collectDxDocsIssues !== "function"
  ) {
    return;
  }

  const paths = await fixture();
  const contracts = await currentDxDocsContracts(dxDocsVerifier);
  await Promise.all(
    contracts.map(({ build, createPage, guide, init, install, scaffold }) =>
      writeFile(
        path.join(paths.docsRoot, guide),
        [
          `- Scaffold: \`${scaffold}\``,
          ...(createPage === undefined
            ? []
            : [`- Create page: \`${createPage}\``]),
          `- Install: \`${install}\``,
          `- Initialize: \`${init}\``,
          `- Build: \`${build}\``,
          "",
        ].join("\n"),
      ),
    ),
  );
  const react = contracts.find(({ id }) => id === "react-vite");
  assert.ok(react);
  await writeFile(
    path.join(paths.docsRoot, react.guide),
    [
      "- Scaffold: `pnpm dlx create-vite@latest . --template react-ts`",
      `- Install: \`${react.install}\``,
      `- Initialize: \`${react.init}\``,
      `- Build: \`${react.build}\``,
      "",
    ].join("\n"),
  );

  const issues = await dxDocsVerifier.collectDxDocsIssues({
    definitions: DX_CASES,
    docsRoot: paths.docsRoot,
  });
  assert.equal(
    issues.some(
      (issue) => issue.includes("react-vite.mdx") && issue.includes("Scaffold"),
    ),
    true,
  );
});

test("the DX docs verifier rejects contradictory build approvals", async () => {
  const dxDocsVerifier = await import("./verify-docs-dx-contract.mjs");
  const paths = await fixture();
  const contracts = await currentDxDocsContracts(dxDocsVerifier);
  await Promise.all(
    contracts.map(
      ({ build, buildApproval, createPage, guide, init, install, scaffold }) =>
        writeFile(
          path.join(paths.docsRoot, guide),
          [
            `- Scaffold: \`${scaffold}\``,
            ...(createPage === undefined
              ? []
              : [`- Create page: \`${createPage}\``]),
            ...(buildApproval === undefined
              ? []
              : [`- Approve builds: \`${buildApproval}\``]),
            `- Install: \`${install}\``,
            `- Initialize: \`${init}\``,
            `- Build: \`${build}\``,
            "",
          ].join("\n"),
        ),
    ),
  );
  const nuxt = contracts.find(({ id }) => id === "nuxt");
  const react = contracts.find(({ id }) => id === "react-vite");
  assert.ok(nuxt);
  assert.ok(react);
  await Promise.all([
    writeFile(
      path.join(paths.docsRoot, nuxt.guide),
      [
        `- Scaffold: \`${nuxt.scaffold}\``,
        `- Approve builds: \`${nuxt.buildApproval}\``,
        "- Approve builds: `printf '%s\\n' allowBuilds: '  \"sharp\": true' > pnpm-workspace.yaml`",
        `- Install: \`${nuxt.install}\``,
        `- Initialize: \`${nuxt.init}\``,
        `- Build: \`${nuxt.build}\``,
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(paths.docsRoot, react.guide),
      [
        `- Scaffold: \`${react.scaffold}\``,
        "- Approve builds: `printf '%s\\n' allowBuilds: '  \"sharp\": true' > pnpm-workspace.yaml`",
        `- Install: \`${react.install}\``,
        `- Initialize: \`${react.init}\``,
        `- Build: \`${react.build}\``,
        "",
      ].join("\n"),
    ),
  ]);

  const issues = await dxDocsVerifier.collectDxDocsIssues({
    definitions: DX_CASES,
    docsRoot: paths.docsRoot,
  });
  assert.equal(
    issues.some(
      (issue) => issue.includes("nuxt.mdx") && issue.includes("Approve builds"),
    ),
    true,
  );
  assert.equal(
    issues.some(
      (issue) =>
        issue.includes("react-vite.mdx") && issue.includes("Approve builds"),
    ),
    true,
  );
});

test("Next samples mirror current generated provider locations and imports", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const [appSample, pagesSample] = await Promise.all([
    readFile(
      path.join(repositoryRoot, "apps/docs/samples/next-app.sample.ts"),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "apps/docs/samples/next-pages.sample.ts"),
      "utf8",
    ),
  ]);

  assert.match(appSample, /docs:consumer-path: app\/opencookie-provider\.tsx/u);
  assert.match(appSample, /from "\.\.\/opencookie\.config";/u);
  assert.doesNotMatch(appSample, /opencookie\.config\.js/u);
  assert.match(pagesSample, /docs:consumer-path: opencookie-provider\.tsx/u);
  assert.match(pagesSample, /from "\.\/opencookie\.config";/u);
  assert.doesNotMatch(pagesSample, /opencookie\.config\.js/u);
});

test("docs contract rejects raw fenced blocks and missing sample modules", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.docsRoot, "index.mdx"),
    [
      "---",
      "title: Home",
      "description: Test",
      "---",
      '<RunnableSample id="missing" />',
      "```ts",
      "const bypass = true;",
      "```",
    ].join("\n"),
  );

  const issues = await collectDocsContractIssues({
    docsRoot: paths.docsRoot,
    requiredRoutes: ["index"],
    samplesRoot: paths.samplesRoot,
  });

  assert.equal(
    issues.some((issue) => issue.includes("raw fenced code")),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.includes("missing.sample.ts")),
    true,
  );
});

test("docs contract rejects every unverified block code renderer", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.docsRoot, "index.mdx"),
    [
      "---",
      "title: Home",
      "description: Test",
      "---",
      "~~~ts",
      'const neverChecked: number = "wrong";',
      "~~~",
      '<Code code="const hidden = true" lang="ts" />',
      "<pre><code>const raw = true</code></pre>",
      "    const indentedBypass = true;",
    ].join("\n"),
  );

  const issues = await collectDocsContractIssues({
    docsRoot: paths.docsRoot,
    requiredRoutes: ["index"],
    samplesRoot: paths.samplesRoot,
  });

  assert.equal(
    issues.some((issue) => issue.includes("fenced code")),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.includes("unapproved MDX component: Code")),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.includes("raw pre or code element")),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.includes("indented code")),
    true,
  );
});

test("docs contract accepts referenced runnable samples with a run export", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.docsRoot, "index.mdx"),
    [
      "---",
      "title: Home",
      "description: Test",
      "---",
      '<RunnableSample id="core-client" />',
    ].join("\n"),
  );
  await writeFile(
    path.join(paths.samplesRoot, "core-client.sample.ts"),
    "export function run(): void {}\n",
  );

  assert.deepEqual(
    await collectDocsContractIssues({
      docsRoot: paths.docsRoot,
      requiredRoutes: ["index"],
      samplesRoot: paths.samplesRoot,
    }),
    [],
  );
});

test("sample extraction isolates the exact consumer-visible module", async () => {
  const sampleVerifier = await import("./verify-docs-samples-lib.mjs").catch(
    () => ({}),
  );
  assert.equal(typeof sampleVerifier.extractDisplayedSample, "function");
  assert.deepEqual(
    sampleVerifier.extractDisplayedSample(
      [
        "// docs:consumer-path: src/example.ts",
        'import { privateHelper } from "./_support.js";',
        "// docs:display:start",
        'import { createOpenCookie } from "@opencookie-dev/core";',
        "export const client = createOpenCookie;",
        "// docs:display:end",
        "export function run() { privateHelper(); }",
      ].join("\n"),
      "example.sample.ts",
    ),
    {
      consumerPath: "src/example.ts",
      source:
        'import { createOpenCookie } from "@opencookie-dev/core";\nexport const client = createOpenCookie;\n',
    },
  );
});

test("repository samples expose independently compilable consumer modules", async () => {
  const sampleVerifier = await import("./verify-docs-samples-lib.mjs").catch(
    () => ({}),
  );
  assert.equal(typeof sampleVerifier.collectDisplayedSampleIssues, "function");
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );

  assert.deepEqual(
    await sampleVerifier.collectDisplayedSampleIssues(
      path.join(repositoryRoot, "apps/docs/samples"),
    ),
    [],
  );
});

test("the executable demo store implements the complete persistence contract", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const supportSource = await readFile(
    path.join(repositoryRoot, "apps/docs/samples/_support.ts"),
    "utf8",
  );

  assert.match(supportSource, /store:\s*\{[\s\S]*?clear:\s*\(/u);
});

test("internal link check rejects missing routes and fragments", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.distRoot, "index.html"),
    '<a href="/guide/#missing">Guide</a><a href="/gone/">Gone</a>',
  );
  await writeFile(
    path.join(paths.distRoot, "guide", "index.html"),
    '<h1 id="present">Guide</h1>',
  );

  const issues = await collectInternalLinkIssues(paths.distRoot);

  assert.equal(
    issues.some((issue) => issue.includes("#missing")),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.includes("/gone/")),
    true,
  );
});

test("internal link check accepts routes, fragments, assets, and external URLs", async () => {
  const paths = await fixture();
  await mkdir(path.join(paths.distRoot, "_astro"), { recursive: true });
  await writeFile(path.join(paths.distRoot, "_astro", "app.js"), "");
  await writeFile(
    path.join(paths.distRoot, "index.html"),
    [
      '<a href="/guide/#present">Guide</a>',
      '<a href="https://example.test/path">External</a>',
      '<script src="/_astro/app.js"></script>',
    ].join(""),
  );
  await writeFile(
    path.join(paths.distRoot, "guide", "index.html"),
    '<h1 id="present">Guide</h1>',
  );

  assert.deepEqual(await collectInternalLinkIssues(paths.distRoot), []);
});

test("internal link check validates fragments on literal index files", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.distRoot, "index.html"),
    '<a href="/guide/index.html#missing">Guide</a>',
  );
  await writeFile(
    path.join(paths.distRoot, "guide", "index.html"),
    '<h1 id="present">Guide</h1>',
  );

  const issues = await collectInternalLinkIssues(paths.distRoot);

  assert.equal(
    issues.some((issue) => issue.includes("/guide/index.html#missing")),
    true,
  );
});

test("built pages require exactly one primary heading", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.distRoot, "index.html"),
    "<h1>Generated title</h1><main><h1>Repeated title</h1></main>",
  );
  await writeFile(
    path.join(paths.distRoot, "guide", "index.html"),
    "<main><p>No primary heading</p></main>",
  );

  const collectPageStructureIssues = docsVerifier.collectPageStructureIssues;
  assert.equal(typeof collectPageStructureIssues, "function");
  const issues = await collectPageStructureIssues(paths.distRoot);

  assert.equal(
    issues.some((issue) => issue.includes("2 primary headings")),
    true,
  );
  assert.equal(
    issues.some((issue) => issue.includes("no primary heading")),
    true,
  );
});

test("page heading checks ignore HTML displayed inside code samples", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.distRoot, "index.html"),
    '<h1>Guide</h1><button data-code="<main><h1>Example</h1></main>">Copy</button>',
  );

  assert.deepEqual(
    await docsVerifier.collectPageStructureIssues(paths.distRoot),
    [],
  );
});

test("page heading checks do not load linked resources", async () => {
  const paths = await fixture();
  const requestedUrls = [];
  const request = https.request;
  https.request = (url) => {
    requestedUrls.push(String(url));
    throw new Error("Page structure inspection initiated an HTTPS request.");
  };

  try {
    await writeFile(
      path.join(paths.distRoot, "index.html"),
      [
        "<!doctype html>",
        '<link rel="stylesheet" href="/styles.css">',
        "<h1>Guide</h1>",
        '<iframe src="/frame.html"></iframe>',
      ].join(""),
    );

    assert.deepEqual(
      await docsVerifier.collectPageStructureIssues(paths.distRoot),
      [],
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requestedUrls, []);
  } finally {
    https.request = request;
  }
});

test("playground bulk decisions synchronize controls and receipt", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const playgroundModule = await import(
    pathToFileURL(
      path.join(repositoryRoot, "apps/docs/src/scripts/consent-playground.ts"),
    ).href
  ).catch(() => ({}));
  assert.equal(typeof playgroundModule.initializePlayground, "function");

  const window = new Window({ url: "https://opencookie.dev/playground/" });
  window.document.body.innerHTML = [
    "<section data-consent-playground>",
    '<input type="checkbox" value="analytics" data-purpose>',
    '<input type="checkbox" value="personalization" data-purpose>',
    '<button type="button" data-decision="reject">Reject all</button>',
    '<button type="button" data-decision="accept">Accept all</button>',
    '<button type="button" data-decision="granular">Save choices</button>',
    "<output data-receipt><strong data-receipt-status></strong>",
    "<span data-receipt-method></span>",
    "<span data-receipt-analytics></span>",
    "<span data-receipt-personalization></span></output>",
    '<button type="button" data-reset>Reset</button>',
    "</section>",
  ].join("");
  const root = window.document.querySelector("[data-consent-playground]");
  playgroundModule.initializePlayground(root, window.localStorage);
  const analytics = root.querySelector('[value="analytics"]');
  const personalization = root.querySelector('[value="personalization"]');

  root.querySelector('[data-decision="accept"]').click();
  assert.equal(analytics.checked, true);
  assert.equal(personalization.checked, true);
  assert.equal(
    root.querySelector("[data-receipt-analytics]").textContent,
    "granted",
  );

  root.querySelector('[data-decision="reject"]').click();
  assert.equal(analytics.checked, false);
  assert.equal(personalization.checked, false);
  assert.equal(
    root.querySelector("[data-receipt-analytics]").textContent,
    "denied",
  );
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem("opencookie-docs-playground")),
    { granted: [], method: "reject-all" },
  );

  analytics.checked = true;
  root.querySelector('[data-decision="granular"]').click();
  assert.equal(analytics.checked, true);
  assert.equal(personalization.checked, false);
  assert.equal(
    root.querySelector("[data-receipt-analytics]").textContent,
    "granted",
  );
  assert.deepEqual(
    JSON.parse(window.localStorage.getItem("opencookie-docs-playground")),
    { granted: ["analytics"], method: "granular" },
  );

  window.localStorage.setItem(
    "opencookie-docs-playground",
    JSON.stringify({ granted: ["personalization"], method: "restored" }),
  );
  const restoredRoot = root.cloneNode(true);
  window.document.body.append(restoredRoot);
  playgroundModule.initializePlayground(restoredRoot, window.localStorage);
  assert.equal(
    restoredRoot.querySelector('[value="analytics"]').checked,
    false,
  );
  assert.equal(
    restoredRoot.querySelector('[value="personalization"]').checked,
    true,
  );
  assert.equal(
    restoredRoot.querySelector("[data-receipt-method]").textContent,
    "restored",
  );

  restoredRoot.querySelector("[data-reset]").click();
  assert.equal(window.localStorage.getItem("opencookie-docs-playground"), null);
  assert.equal(
    restoredRoot.querySelector('[value="personalization"]').checked,
    false,
  );
  assert.equal(
    restoredRoot.querySelector("[data-receipt-status]").textContent,
    "No decision yet",
  );
  window.close();
});

test("receipt labels render with an AA contrast margin", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const css = await readFile(
    path.join(repositoryRoot, "apps/docs/src/styles/opencookie.css"),
    "utf8",
  );
  const window = new Window();
  const style = window.document.createElement("style");
  style.textContent = css;
  window.document.head.append(style);
  window.document.body.innerHTML =
    '<output class="oc-receipt"><dl><div><dt>method</dt><dd>granular</dd></div></dl></output>';
  const receipt = window.document.querySelector(".oc-receipt");
  const label = window.document.querySelector(".oc-receipt dt");
  const receiptStyle = window.getComputedStyle(receipt);
  const labelStyle = window.getComputedStyle(label);
  const ratio = contrastRatio(
    rgb(labelStyle.color),
    rgb(receiptStyle.backgroundColor),
    Number(labelStyle.opacity),
  );

  assert.ok(ratio >= 4.8, `Expected contrast >= 4.8:1, received ${ratio}:1`);
  window.close();
});

test("the theming recipe maps focus indicators to the shipped ink token", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const [recipe, mountSource] = await Promise.all([
    readFile(
      path.join(
        repositoryRoot,
        "apps/docs/src/content/docs/recipes/a11y-i18n-theming.mdx",
      ),
      "utf8",
    ),
    readFile(
      path.join(repositoryRoot, "packages/adapters/vanilla/src/mount.ts"),
      "utf8",
    ),
  ]);

  assert.match(
    mountSource,
    /\.oc-btn:focus-visible[^}]*outline:4px solid var\(--oc-ink\)/u,
  );
  assert.match(
    recipe,
    /`--oc-ink` for body text, borders, and focus indicators/u,
  );
  assert.match(recipe, /`--oc-accent` for primary control fills/u);
  assert.doesNotMatch(recipe, /`--oc-accent`[^.]*focus ring/u);
});

test("the storage recipe publishes the branded Safari proof boundary", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const recipe = await readFile(
    path.join(repositoryRoot, "apps/docs/src/content/docs/recipes/testing.mdx"),
    "utf8",
  );

  assert.match(recipe, /pnpm e2e:storage:safari:serve/u);
  assert.match(recipe, /http:\/\/localhost/u);
  assert.match(recipe, /http:\/\/127[.]0[.]0[.]1/u);
  assert.match(
    recipe,
    /https:\/\/support[.]apple[.]com\/guide\/safari\/browse-privately-ibrw1069\/mac/u,
  );
  assert.match(
    recipe,
    /https:\/\/support[.]apple[.]com\/en-au\/guide\/safari\/sfri40732\/mac/u,
  );
  assert.match(recipe, /does not unlock Private Browsing/u);
  assert.match(recipe, /does not change Safari privacy settings/u);
  assert.match(
    recipe,
    /Verified in installed Safari 26[.]5 on macOS 26[.]5[.]1/u,
  );
  assert.match(
    recipe,
    /same Private window restored the decision after reload/u,
  );
  assert.match(recipe, /new Private window started without that decision/u);
  for (const screenshot of [
    "private-preconsent",
    "private-reload-persisted",
    "private-fresh-context",
  ]) {
    const publicPath = `/images/recipes/testing/safari-${screenshot}.png`;
    assert.ok(
      recipe.includes(publicPath),
      `The Safari recipe must publish ${screenshot} evidence.`,
    );
    const image = await readFile(
      path.join(repositoryRoot, "apps/docs/public", publicPath.slice(1)),
    );
    assert.equal(
      image.subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      `${publicPath} must be a PNG file.`,
    );
  }
  assert.doesNotMatch(
    recipe,
    /```sh[\s\S]*pnpm e2e:storage:safari:serve[\s\S]*```/u,
  );
});

test("repository docs expose the complete Phase 5 route and sample contract", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const requiredRoutes = [
    "index",
    "getting-started/index",
    "getting-started/plain-html",
    "getting-started/react-vite",
    "getting-started/vue-vite",
    "getting-started/sveltekit",
    "getting-started/next-app",
    "getting-started/next-pages",
    "getting-started/next-15-app",
    "getting-started/nuxt",
    "getting-started/astro",
    "recipes/pre-consent-blocking",
    "recipes/csp-nonce",
    "recipes/decision-lifecycle",
    "recipes/ssr-hydration-cls",
    "recipes/policy-versioning",
    "recipes/signals",
    "recipes/iframe-blocking",
    "recipes/subdomain-scope",
    "recipes/testing",
    "recipes/a11y-i18n-theming",
    "playground/index",
    "reference/api",
    "reference/support",
  ];

  assert.deepEqual(
    await collectDocsContractIssues({
      docsRoot: path.join(repositoryRoot, "apps/docs/src/content/docs"),
      requiredRoutes,
      samplesRoot: path.join(repositoryRoot, "apps/docs/samples"),
    }),
    [],
  );
});

test("the docs verify command rejects a stale generated API page", async () => {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "apps/docs/package.json"), "utf8"),
  );

  assert.match(
    manifest.scripts.verify,
    /verify-docs-generate-api\.mjs --check/u,
  );
});
