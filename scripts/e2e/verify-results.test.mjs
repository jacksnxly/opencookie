import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BINDING_E2E_CONTRACTS,
  REQUIRED_E2E_CONTRACTS,
} from "./contract-catalogue.mjs";
import { createPlaywrightProjects } from "./project-matrix.mjs";
import { verifyPlaywrightResults } from "./verify-results.mjs";

const verifierPath = fileURLToPath(
  new URL("./verify-results.mjs", import.meta.url),
);
const CHANGE_TIER_EXECUTIONS =
  6 * REQUIRED_E2E_CONTRACTS.length + 14 * BINDING_E2E_CONTRACTS.length;

/** A green report of one tier: every owed contract, `repeats` runs each, no recordings. */
function tierReport({ repeats = 1, tier = "release" } = {}) {
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
      .map((project) => {
        executions += repeats;
        return {
          expectedStatus: "passed",
          projectName: project.name,
          results: Array.from({ length: repeats }, (_, repeat) => ({
            attachments: [],
            errors: [],
            retry: 0,
            status: "passed",
            workerIndex: repeat,
          })),
          status: "expected",
        };
      }),
    title: contract,
  }));
  return {
    config: {
      projects: projects.map(({ name }) => ({
        name,
        repeatEach: repeats,
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

async function validFixture(options) {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-e2e-results-"));
  const htmlReport = path.join(root, "html-report", "index.html");
  const junitReport = path.join(root, "results.xml");
  await mkdir(path.dirname(htmlReport), { recursive: true });
  await Promise.all([
    writeFile(htmlReport, "report"),
    writeFile(junitReport, "report"),
  ]);
  return { htmlReport, junitReport, report: tierReport(options), root };
}

function clone(value) {
  return structuredClone(value);
}

function jsonReporterRepeatFixture(report) {
  const split = clone(report);
  split.suites[0].specs = split.suites[0].specs.flatMap((spec) =>
    spec.tests.flatMap((test) =>
      test.results.map((result) => ({
        ...spec,
        tests: [{ ...test, results: [result] }],
      })),
    ),
  );
  return split;
}

describe("Playwright result verifier", () => {
  it("accepts the exact release matrix with one run per test and no recordings", async () => {
    const fixture = await validFixture({ tier: "release" });

    const summary = await verifyPlaywrightResults(fixture.report, {
      htmlReport: fixture.htmlReport,
      junitReport: fixture.junitReport,
    });

    assert.deepEqual(summary, {
      contracts: REQUIRED_E2E_CONTRACTS.length,
      projects: 48,
      repeats: 1,
      tests: 48 * REQUIRED_E2E_CONTRACTS.length,
      tier: "release",
    });
  });

  it("accepts a change-tier report whose framework projects prove the binding contracts", async () => {
    const fixture = await validFixture({ tier: "change" });

    const summary = await verifyPlaywrightResults(fixture.report, {
      expectedRepeats: 1,
      htmlReport: fixture.htmlReport,
      junitReport: fixture.junitReport,
      tier: "change",
    });

    assert.deepEqual(summary, {
      contracts: REQUIRED_E2E_CONTRACTS.length,
      projects: 20,
      repeats: 1,
      tests: CHANGE_TIER_EXECUTIONS,
      tier: "change",
    });
  });

  it("rejects a report verified against the other tier", async () => {
    const change = await validFixture({ tier: "change" });
    await assert.rejects(
      verifyPlaywrightResults(change.report, {
        htmlReport: change.htmlReport,
        junitReport: change.junitReport,
        tier: "release",
      }),
      /Missing Playwright projects: react-vite-firefox-desktop, react-vite-firefox-mobile,/u,
    );

    const release = await validFixture({ tier: "release" });
    await assert.rejects(
      verifyPlaywrightResults(release.report, {
        htmlReport: release.htmlReport,
        junitReport: release.junitReport,
        tier: "change",
      }),
      /expected-count mismatch/u,
    );
  });

  it("rejects an unknown tier and a pattern that selects none of the tier's projects", async () => {
    const fixture = await validFixture({ tier: "change" });
    await assert.rejects(
      verifyPlaywrightResults(fixture.report, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
        tier: "nightly",
      }),
      /Unknown E2E tier "nightly"/u,
    );
    await assert.rejects(
      verifyPlaywrightResults(fixture.report, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
        projectPatterns: ["react-vite-webkit-*"],
        tier: "change",
      }),
      /matched no G6 change-tier projects/u,
    );
  });

  it("accepts repeat-each executions emitted as separate JSON specs", async () => {
    const fixture = await validFixture({ repeats: 2, tier: "release" });
    const report = jsonReporterRepeatFixture(fixture.report);

    const summary = await verifyPlaywrightResults(report, {
      expectedRepeats: 2,
      htmlReport: fixture.htmlReport,
      junitReport: fixture.junitReport,
    });

    assert.equal(summary.tests, report.stats.expected);

    report.suites[0].specs.pop();
    await assert.rejects(
      verifyPlaywrightResults(report, {
        expectedRepeats: 2,
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
      }),
      /expected 2 repeats/u,
    );
  });

  it("keeps identical test locations distinct across suite paths", async () => {
    const fixture = await validFixture({ tier: "release" });
    const originalSuite = fixture.report.suites[0];
    const report = clone(fixture.report);
    report.suites = [
      { suites: [clone(originalSuite)], title: "first context" },
      { suites: [clone(originalSuite)], title: "second context" },
    ];
    report.stats.expected *= 2;

    const summary = await verifyPlaywrightResults(report, {
      htmlReport: fixture.htmlReport,
      junitReport: fixture.junitReport,
    });

    assert.equal(summary.tests, report.stats.expected);
  });

  it("accepts one complete browser shard without blessing omitted shard projects", async () => {
    const fixture = await validFixture({ tier: "release" });
    const shard = clone(fixture.report);
    const expectedProjects = createPlaywrightProjects({ tier: "release" })
      .map((project) => project.name)
      .filter((name) => name.includes("-chromium-"));
    const expectedProjectSet = new Set(expectedProjects);
    for (const spec of shard.suites[0].specs) {
      spec.tests = spec.tests.filter((test) =>
        expectedProjectSet.has(test.projectName),
      );
    }
    shard.stats.expected =
      expectedProjects.length * REQUIRED_E2E_CONTRACTS.length;

    const summary = await verifyPlaywrightResults(shard, {
      htmlReport: fixture.htmlReport,
      junitReport: fixture.junitReport,
      projectPatterns: ["*-chromium-*"],
      tier: "release",
    });

    assert.equal(summary.projects, 16);
    const omittedProject = expectedProjects.at(-1);
    for (const spec of shard.suites[0].specs) {
      spec.tests = spec.tests.filter(
        (test) => test.projectName !== omittedProject,
      );
    }
    await assert.rejects(
      verifyPlaywrightResults(shard, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
        projectPatterns: ["*-chromium-*"],
        tier: "release",
      }),
      /Missing Playwright projects/u,
    );
  });

  it("rejects missing projects and missing named contracts", async () => {
    const fixture = await validFixture({ tier: "release" });
    const missingProject = clone(fixture.report);
    for (const spec of missingProject.suites[0].specs) spec.tests.pop();
    await assert.rejects(
      verifyPlaywrightResults(missingProject, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
      }),
      /Missing Playwright projects/u,
    );

    const missingContract = clone(fixture.report);
    missingContract.suites[0].specs.pop();
    await assert.rejects(
      verifyPlaywrightResults(missingContract, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
      }),
      /Missing E2E contracts/u,
    );
  });

  it("rejects skips, flakes, interruptions, failures, retries, and a run more or fewer than expected", async () => {
    const fixture = await validFixture({ tier: "release" });
    for (const stat of ["flaky", "interrupted", "skipped", "unexpected"]) {
      const nonGreen = clone(fixture.report);
      nonGreen.stats[stat] = 1;
      await assert.rejects(
        verifyPlaywrightResults(nonGreen, {
          htmlReport: fixture.htmlReport,
          junitReport: fixture.junitReport,
        }),
        /non-green aggregate status/u,
        stat,
      );
    }

    const retried = clone(fixture.report);
    retried.suites[0].specs[0].tests[0].results[0].retry = 1;
    await assert.rejects(
      verifyPlaywrightResults(retried, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
      }),
      /retry or non-passing result/u,
    );

    const missingRun = clone(fixture.report);
    missingRun.suites[0].specs[0].tests[0].results.pop();
    await assert.rejects(
      verifyPlaywrightResults(missingRun, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
      }),
      /expected 1 repeats but recorded 0/u,
    );

    const extraRun = clone(fixture.report);
    const firstTest = extraRun.suites[0].specs[0].tests[0];
    firstTest.results.push(clone(firstTest.results[0]));
    extraRun.stats.expected += 1;
    await assert.rejects(
      verifyPlaywrightResults(extraRun, {
        htmlReport: fixture.htmlReport,
        junitReport: fixture.junitReport,
      }),
      /expected 1 repeats but recorded 2/u,
    );
  });

  it("requires --tier on the command line and names the tier it verified", async () => {
    const fixture = await validFixture({ tier: "change" });
    const reportPath = path.join(fixture.root, "results.json");
    await writeFile(reportPath, JSON.stringify(fixture.report));
    const files = [
      "--report",
      reportPath,
      "--html-report",
      fixture.htmlReport,
      "--junit-report",
      fixture.junitReport,
    ];

    const withoutTier = spawnSync(process.execPath, [verifierPath, ...files], {
      encoding: "utf8",
    });
    assert.notEqual(withoutTier.status, 0);
    assert.match(withoutTier.stderr, /--tier is required/u);

    const change = spawnSync(
      process.execPath,
      [verifierPath, ...files, "--tier", "change"],
      { encoding: "utf8" },
    );
    assert.equal(change.status, 0, change.stderr);
    assert.equal(
      change.stdout,
      `G6 result integrity PASS: change tier, 20 projects, ${String(REQUIRED_E2E_CONTRACTS.length)} contracts, 1 repeats, ${String(CHANGE_TIER_EXECUTIONS)} executions.\n`,
    );

    const asRelease = spawnSync(
      process.execPath,
      [verifierPath, ...files, "--tier", "release"],
      { encoding: "utf8" },
    );
    assert.notEqual(asRelease.status, 0);
    assert.match(asRelease.stderr, /Missing Playwright projects/u);
  });
});
