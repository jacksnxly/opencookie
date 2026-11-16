import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  BINDING_E2E_CONTRACTS,
  BINDING_TAG,
  REQUIRED_E2E_CONTRACTS,
} from "./contract-catalogue.mjs";
import { createPlaywrightProjects } from "./project-matrix.mjs";
import { createE2ERunPolicy } from "./run-policy.mjs";
import { verifyPlaywrightResults } from "./verify-results.mjs";

const FRAMEWORKS = [
  "react-vite",
  "vue-vite",
  "next-app",
  "next-pages",
  "nuxt",
  "sveltekit",
  "astro",
];

const BINDING_TITLES = [
  "TEST-FIRST-VISIT-BANNER TEST-NO-PRECONSENT-LOAD TEST-IFRAME-FIRST-PARTY-CONTROL",
  "TEST-ACCEPT-ALL TEST-RELOAD-PERSISTENCE",
  "TEST-REJECT-ALL TEST-ESSENTIAL-APP-SURVIVES-REJECT",
  "TEST-SSR-HYDRATION-MATCH TEST-CLS-AND-FOUC",
  "TEST-CATALOGUE-NETWORK-COVERAGE TEST-THEMING-CONTRACT",
  "TEST-SPA-DYNAMIC-DISCOVERY",
  "a site's own settings link opens the choices",
  "TEST-CSP-NONCE-PROPERTY",
  "TEST-CONSENT-MODE-ORDER",
  "TEST-GPC-SERVER-CLIENT",
];

const contractsRoot = fileURLToPath(
  new URL("../../tests/e2e/contracts/", import.meta.url),
);

function names(projects) {
  return projects.map(({ name }) => name);
}

async function taggedBindingTitles() {
  const titles = [];
  for (const file of (await readdir(contractsRoot)).sort()) {
    if (!file.endsWith(".spec.ts")) continue;
    const filePath = path.join(contractsRoot, file);
    const source = ts.createSourceFile(
      filePath,
      await readFile(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "test"
      ) {
        const [title, details] = node.arguments;
        const tagged =
          details !== undefined &&
          ts.isObjectLiteralExpression(details) &&
          details.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === "tag" &&
              ts.isStringLiteralLike(property.initializer) &&
              property.initializer.text === BINDING_TAG,
          );
        if (tagged && title !== undefined && ts.isStringLiteralLike(title)) {
          titles.push(title.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return titles;
}

async function reportFiles() {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-e2e-tiers-"));
  const htmlReport = path.join(root, "html-report", "index.html");
  const junitReport = path.join(root, "results.xml");
  await mkdir(path.dirname(htmlReport), { recursive: true });
  await Promise.all([
    writeFile(htmlReport, "report"),
    writeFile(junitReport, "report"),
  ]);
  return { htmlReport, junitReport };
}

function tierReport(tier, omitted = () => false) {
  const projects = createPlaywrightProjects({ tier });
  let executions = 0;
  const specs = REQUIRED_E2E_CONTRACTS.map((contract) => ({
    ok: true,
    tests: projects
      .filter(
        (project) =>
          project.grep === undefined ||
          BINDING_E2E_CONTRACTS.includes(contract),
      )
      .filter((project) => !omitted(project.name, contract))
      .map((project) => {
        executions += 1;
        return {
          expectedStatus: "passed",
          projectName: project.name,
          results: [
            {
              attachments: [],
              errors: [],
              retry: 0,
              status: "passed",
              workerIndex: 0,
            },
          ],
          status: "expected",
        };
      }),
    title: contract,
  }));
  return {
    config: {
      projects: projects.map(({ name }) => ({
        name,
        repeatEach: 1,
        retries: 0,
      })),
    },
    errors: [],
    stats: {
      expected: executions,
      flaky: 0,
      interrupted: 0,
      skipped: 0,
      unexpected: 0,
    },
    suites: [{ specs, title: "contracts" }],
  };
}

test("the release tier is the full 48-project matrix", () => {
  const release = createPlaywrightProjects({ tier: "release" });
  assert.equal(release.length, 48);
  assert.equal(
    release.some((project) => project.grep !== undefined),
    false,
  );
  assert.deepEqual(names(createPlaywrightProjects()), names(release));
});

test("the change tier runs plain-cdn everywhere and each framework's bindings in Chromium", () => {
  const change = createPlaywrightProjects({ tier: "change" });
  assert.deepEqual(names(change), [
    "plain-cdn-chromium-desktop",
    "plain-cdn-chromium-mobile",
    "plain-cdn-firefox-desktop",
    "plain-cdn-firefox-mobile",
    "plain-cdn-webkit-desktop",
    "plain-cdn-webkit-mobile",
    ...FRAMEWORKS.flatMap((fixture) => [
      `${fixture}-chromium-desktop`,
      `${fixture}-chromium-mobile`,
    ]),
  ]);
  for (const project of change) {
    if (project.name.startsWith("plain-cdn-")) {
      assert.equal(project.grep, undefined, project.name);
    } else {
      assert.equal(String(project.grep), "/@binding/u", project.name);
    }
  }
});

test("both tiers run every test once and keep video and trace only on failure", () => {
  for (const tier of ["change", "release"]) {
    const policy = createE2ERunPolicy("/repository", { tier });
    assert.equal(policy.repeatEach, 1, tier);
    assert.equal(policy.retries, 0, tier);
    assert.equal(policy.use.video, "retain-on-failure", tier);
    assert.equal(policy.use.trace, "retain-on-failure", tier);
    assert.deepEqual(
      names(policy.projects),
      names(createPlaywrightProjects({ tier })),
    );
  }
});

test("the binding contracts are the framework integration contracts", () => {
  assert.equal(BINDING_TAG, "@binding");
  assert.deepEqual([...BINDING_E2E_CONTRACTS].sort(), [
    "TEST-ACCEPT-ALL",
    "TEST-CATALOGUE-NETWORK-COVERAGE",
    "TEST-CLS-AND-FOUC",
    "TEST-CONSENT-MODE-ORDER",
    "TEST-CSP-NONCE-PROPERTY",
    "TEST-ESSENTIAL-APP-SURVIVES-REJECT",
    "TEST-FIRST-VISIT-BANNER",
    "TEST-GPC-SERVER-CLIENT",
    "TEST-IFRAME-FIRST-PARTY-CONTROL",
    "TEST-NO-PRECONSENT-LOAD",
    "TEST-REJECT-ALL",
    "TEST-RELOAD-PERSISTENCE",
    "TEST-SPA-DYNAMIC-DISCOVERY",
    "TEST-SSR-HYDRATION-MATCH",
    "TEST-THEMING-CONTRACT",
  ]);
  for (const contract of BINDING_E2E_CONTRACTS) {
    assert.ok(REQUIRED_E2E_CONTRACTS.includes(contract), contract);
  }
});

test("exactly the ten integration tests carry the binding tag", async () => {
  assert.deepEqual(
    (await taggedBindingTitles()).sort(),
    [...BINDING_TITLES].sort(),
  );
});

test("a complete change-tier report passes with one run per test and no recordings", async () => {
  const files = await reportFiles();
  await verifyPlaywrightResults(tierReport("change"), {
    ...files,
    expectedRepeats: 1,
    tier: "change",
  });
});

test("the change tier still demands every binding contract from each framework project", async () => {
  const files = await reportFiles();
  await assert.rejects(
    verifyPlaywrightResults(
      tierReport(
        "change",
        (project, contract) =>
          project === "nuxt-chromium-mobile" &&
          contract === "TEST-CSP-NONCE-PROPERTY",
      ),
      { ...files, expectedRepeats: 1, tier: "change" },
    ),
    /nuxt-chromium-mobile/u,
  );
});

test("the change tier still demands every contract from plain-cdn in each engine", async () => {
  const files = await reportFiles();
  await assert.rejects(
    verifyPlaywrightResults(
      tierReport(
        "change",
        (project, contract) =>
          project === "plain-cdn-webkit-mobile" &&
          contract === "TEST-A11Y-VISUAL-MODES",
      ),
      { ...files, expectedRepeats: 1, tier: "change" },
    ),
    /plain-cdn-webkit-mobile/u,
  );
});

test("a release-tier report must cover all 48 projects", async () => {
  const files = await reportFiles();
  await verifyPlaywrightResults(tierReport("release"), {
    ...files,
    expectedRepeats: 1,
    tier: "release",
  });
  await assert.rejects(
    verifyPlaywrightResults(tierReport("change"), {
      ...files,
      expectedRepeats: 1,
      tier: "release",
    }),
  );
});
