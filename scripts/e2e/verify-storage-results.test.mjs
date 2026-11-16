import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { createStorageContractCases } from "./storage-contract-catalogue.mjs";
import { createStoragePlaywrightProjects } from "./storage-project-matrix.mjs";
import { verifyStoragePlaywrightResults } from "./verify-storage-results.mjs";

function clone(value) {
  return structuredClone(value);
}

const verifierFixturePaths = new Set();

async function cleanupVerifierFixtures() {
  const ownedPaths = [...verifierFixturePaths];
  await Promise.all(
    ownedPaths.map((ownedPath) =>
      rm(ownedPath, { force: true, recursive: true }),
    ),
  );
  for (const ownedPath of ownedPaths) verifierFixturePaths.delete(ownedPath);
}

afterEach(cleanupVerifierFixtures);

async function validFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencookie-storage-e2e-"));
  const outsideArtifact = `${root}-outside.zip`;
  verifierFixturePaths.add(root);
  verifierFixturePaths.add(outsideArtifact);
  const htmlReport = path.join(root, "html-report", "index.html");
  const junitReport = path.join(root, "results.xml");
  await mkdir(path.dirname(htmlReport), { recursive: true });
  await Promise.all([
    writeFile(htmlReport, "html"),
    writeFile(
      junitReport,
      '<?xml version="1.0" encoding="UTF-8"?><testsuites tests="36" failures="0" errors="0" skipped="0"><testsuite name="storage" tests="36" failures="0" errors="0" skipped="0"></testsuite></testsuites>',
    ),
    writeFile(outsideArtifact, "outside"),
  ]);

  const projectNames = createStoragePlaywrightProjects().map(
    ({ name }) => name,
  );
  const cases = createStorageContractCases();
  const specs = [];
  for (const contractCase of cases) {
    const tests = [];
    for (const projectName of projectNames) {
      const executionRoot = path.join(
        root,
        "test-results",
        projectName,
        contractCase.id,
      );
      const trace = path.join(executionRoot, "trace.zip");
      const video = path.join(executionRoot, "video.webm");
      const screenshot = path.join(executionRoot, "test-finished-1.png");
      const secondScreenshot = path.join(executionRoot, "test-finished-2.png");
      const evidence = path.join(executionRoot, "storage-evidence.json");
      await mkdir(executionRoot, { recursive: true });
      await writeFile(
        evidence,
        `${JSON.stringify({
          contract: contractCase.contract,
          integration: contractCase.integration.id,
          mechanism: contractCase.mechanism,
          ...(contractCase.fault ===
          "deterministic-cross-site-cookie-denial-emulation"
            ? {
                afterRetryOperations: {
                  cookieReads: 4,
                  cookieWrites: 2,
                  localGetterReads: 0,
                  localReads: 0,
                  localRemoves: 0,
                  localWrites: 0,
                },
                beforeRetryOperations: {
                  cookieReads: 2,
                  cookieWrites: 1,
                  localGetterReads: 0,
                  localReads: 0,
                  localRemoves: 0,
                  localWrites: 0,
                },
                policyLabel: "deterministic emulation",
                recoveryOutcome: "policy-remains-blocked",
                released: false,
              }
            : {}),
        })}\n`,
      );
      await Promise.all([
        writeFile(trace, "trace"),
        writeFile(video, "video"),
        writeFile(screenshot, "screenshot"),
        ...(contractCase.fault === "context-ephemerality"
          ? [writeFile(secondScreenshot, "second context screenshot")]
          : []),
      ]);
      tests.push({
        expectedStatus: "passed",
        projectName,
        results: [
          {
            attachments: [
              { contentType: "application/zip", name: "trace", path: trace },
              { contentType: "video/webm", name: "video", path: video },
              {
                contentType: "image/png",
                name: "screenshot",
                path: screenshot,
              },
              ...(contractCase.fault === "context-ephemerality"
                ? [
                    {
                      contentType: "image/png",
                      name: "screenshot",
                      path: secondScreenshot,
                    },
                  ]
                : []),
              {
                contentType: "application/json",
                name: "storage-evidence",
                path: evidence,
              },
            ],
            errors: [],
            retry: 0,
            status: "passed",
          },
        ],
        status: "expected",
      });
    }
    specs.push({
      column: 1,
      file: "storage/storage-resilience.spec.ts",
      line: specs.length + 1,
      tests,
      title: `${contractCase.contract} ${contractCase.integration.id}`,
    });
  }
  return {
    artifactRoot: root,
    htmlReport,
    junitReport,
    outsideArtifact,
    report: {
      config: {
        projects: projectNames.map((name) => ({
          name,
          repeatEach: 1,
          retries: 0,
        })),
      },
      errors: [],
      stats: {
        expected: projectNames.length * cases.length,
        flaky: 0,
        interrupted: 0,
        skipped: 0,
        unexpected: 0,
      },
      suites: [{ specs, title: "storage resilience" }],
    },
  };
}

function options(fixture) {
  return {
    artifactRoot: fixture.artifactRoot,
    htmlReport: fixture.htmlReport,
    junitReport: fixture.junitReport,
  };
}

describe("storage-resilience Playwright result verifier", () => {
  it("cleans only verifier fixtures created by the current process", async () => {
    const fixture = await validFixture();
    const untracked = await mkdtemp(
      path.join(tmpdir(), "opencookie-storage-untracked-"),
    );
    try {
      await cleanupVerifierFixtures();
      await assert.rejects(access(fixture.artifactRoot), { code: "ENOENT" });
      await assert.rejects(access(fixture.outsideArtifact), { code: "ENOENT" });
      await access(untracked);
    } finally {
      await rm(untracked, { force: true, recursive: true });
    }
  });

  it("accepts exactly 3 projects by 12 cases by 1 repeat", async () => {
    const fixture = await validFixture();
    const summary = await verifyStoragePlaywrightResults(
      fixture.report,
      options(fixture),
    );

    assert.deepEqual(summary, {
      cases: 12,
      contracts: 6,
      integrations: 2,
      projects: 3,
      repeats: 1,
      tests: 36,
    });
  });

  it("rejects missing and duplicate integration-contract cases", async () => {
    const fixture = await validFixture();
    const missing = clone(fixture.report);
    missing.suites[0].specs.pop();
    missing.stats.expected -= 3;
    await assert.rejects(
      verifyStoragePlaywrightResults(missing, options(fixture)),
      /Missing storage cases/u,
    );

    const duplicate = clone(fixture.report);
    duplicate.suites[0].specs.push(clone(duplicate.suites[0].specs[0]));
    duplicate.stats.expected += 3;
    await assert.rejects(
      verifyStoragePlaywrightResults(duplicate, options(fixture)),
      /Duplicate storage case/u,
    );
  });

  it("rejects extra projects, repeats, skips, retries, and missing evidence", async () => {
    const fixture = await validFixture();

    const extraProject = clone(fixture.report);
    extraProject.config.projects.push({
      name: "storage-safari",
      repeatEach: 1,
      retries: 0,
    });
    await assert.rejects(
      verifyStoragePlaywrightResults(extraProject, options(fixture)),
      /Configured storage projects/u,
    );

    const duplicateProject = clone(fixture.report);
    duplicateProject.config.projects[2].name =
      duplicateProject.config.projects[0].name;
    await assert.rejects(
      verifyStoragePlaywrightResults(duplicateProject, options(fixture)),
      /Configured storage projects/u,
    );

    const repeated = clone(fixture.report);
    repeated.config.projects[0].repeatEach = 2;
    await assert.rejects(
      verifyStoragePlaywrightResults(repeated, options(fixture)),
      /one repeat and zero retries/u,
    );

    const skipped = clone(fixture.report);
    skipped.stats.skipped = 1;
    await assert.rejects(
      verifyStoragePlaywrightResults(skipped, options(fixture)),
      /non-green aggregate status/u,
    );

    const retried = clone(fixture.report);
    retried.suites[0].specs[0].tests[0].results[0].retry = 1;
    await assert.rejects(
      verifyStoragePlaywrightResults(retried, options(fixture)),
      /retry or non-passing result/u,
    );

    const missingEvidence = clone(fixture.report);
    missingEvidence.suites[0].specs[0].tests[0].results[0].attachments.pop();
    await assert.rejects(
      verifyStoragePlaywrightResults(missingEvidence, options(fixture)),
      /missing storage evidence/u,
    );

    const duplicateTrace = clone(fixture.report);
    duplicateTrace.suites[0].specs[0].tests[0].results[0].attachments.push(
      clone(
        duplicateTrace.suites[0].specs[0].tests[0].results[0].attachments[0],
      ),
    );
    await assert.rejects(
      verifyStoragePlaywrightResults(duplicateTrace, options(fixture)),
      /exactly one trace/u,
    );

    const decoratedTitle = clone(fixture.report);
    decoratedTitle.suites[0].specs[0].title += " ignored suffix";
    await assert.rejects(
      verifyStoragePlaywrightResults(decoratedTitle, options(fixture)),
      /Unexpected or ambiguous storage case/u,
    );
  });

  it("rejects evidence that mislabels the exercised mechanism", async () => {
    const fixture = await validFixture();
    const report = clone(fixture.report);
    const evidence =
      report.suites[0].specs[0].tests[0].results[0].attachments.find(
        ({ name }) => name === "storage-evidence",
      );
    assert.ok(evidence?.path);
    await writeFile(
      evidence.path,
      `${JSON.stringify({
        contract: "wrong-contract",
        integration: "plain-cdn-auto",
        mechanism: "wrong-mechanism",
      })}\n`,
    );

    await assert.rejects(
      verifyStoragePlaywrightResults(report, options(fixture)),
      /does not match its storage case/u,
    );
  });

  it("rejects inline reporter bodies instead of file-backed evidence", async () => {
    const fixture = await validFixture();
    const report = clone(fixture.report);
    const evidence =
      report.suites[0].specs[0].tests[0].results[0].attachments.find(
        ({ name }) => name === "storage-evidence",
      );
    assert.ok(evidence?.path);
    const body = (await readFile(evidence.path)).toString("base64");
    delete evidence.path;
    evidence.body = body;

    await assert.rejects(
      verifyStoragePlaywrightResults(report, options(fixture)),
      /storage evidence must be file-backed with a path/u,
    );
  });

  it("rejects incomplete or falsely recovered cross-site emulation evidence", async () => {
    const fixture = await validFixture();
    const report = clone(fixture.report);
    const policySpec = report.suites[0].specs.find(({ title }) =>
      title.startsWith(
        "TEST-STORAGE-DETERMINISTIC-CROSS-SITE-COOKIE-DENIAL-EMULATION",
      ),
    );
    const attachment = policySpec?.tests[0].results[0].attachments.find(
      ({ name }) => name === "storage-evidence",
    );
    assert.ok(attachment?.path);
    const validEvidence = JSON.parse(await readFile(attachment.path, "utf8"));
    const verifyMutation = async (mutation, pattern) => {
      const evidence = clone(validEvidence);
      mutation(evidence);
      await writeFile(attachment.path, `${JSON.stringify(evidence)}\n`);
      await assert.rejects(
        verifyStoragePlaywrightResults(report, options(fixture)),
        pattern,
      );
    };

    await verifyMutation((evidence) => {
      delete evidence.recoveryOutcome;
    }, /cross-site policy evidence/u);
    await verifyMutation((evidence) => {
      evidence.policyLabel = "native third-party-cookie proof";
    }, /cross-site policy evidence/u);
    await verifyMutation((evidence) => {
      evidence.recoveryOutcome = "recovered";
      evidence.released = true;
    }, /cross-site policy evidence/u);
    await verifyMutation((evidence) => {
      evidence.afterRetryOperations.cookieWrites =
        evidence.beforeRetryOperations.cookieWrites;
    }, /additional cookie write/u);

    await writeFile(attachment.path, `${JSON.stringify(validEvidence)}\n`);
    const duplicate = clone(report);
    const duplicatePolicySpec = duplicate.suites[0].specs.find(({ title }) =>
      title.startsWith(
        "TEST-STORAGE-DETERMINISTIC-CROSS-SITE-COOKIE-DENIAL-EMULATION",
      ),
    );
    const duplicateAttachments =
      duplicatePolicySpec?.tests[0].results[0].attachments;
    const duplicateEvidence = duplicateAttachments?.find(
      ({ name }) => name === "storage-evidence",
    );
    assert.ok(duplicateAttachments && duplicateEvidence);
    duplicateAttachments.push(clone(duplicateEvidence));
    await assert.rejects(
      verifyStoragePlaywrightResults(duplicate, options(fixture)),
      /exactly one storage evidence attachment/u,
    );
  });

  it("rejects reused, escaped, or mislabeled execution artifacts", async () => {
    const fixture = await validFixture();
    const reused = clone(fixture.report);
    const firstTrace =
      reused.suites[0].specs[0].tests[0].results[0].attachments[0];
    reused.suites[0].specs[1].tests[0].results[0].attachments[0].path =
      firstTrace.path;
    await assert.rejects(
      verifyStoragePlaywrightResults(reused, options(fixture)),
      /reuses an execution artifact/u,
    );

    const escaped = clone(fixture.report);
    escaped.suites[0].specs[0].tests[0].results[0].attachments[0].path =
      fixture.outsideArtifact;
    await assert.rejects(
      verifyStoragePlaywrightResults(escaped, options(fixture)),
      /outside the storage artifact root/u,
    );

    const mislabeled = clone(fixture.report);
    mislabeled.suites[0].specs[0].tests[0].results[0].attachments[2].contentType =
      "text/plain";
    await assert.rejects(
      verifyStoragePlaywrightResults(mislabeled, options(fixture)),
      /must be image\/png/u,
    );
  });

  it("requires exactly two screenshots only for isolated-context proof", async () => {
    const fixture = await validFixture();
    const contextSpec = fixture.report.suites[0].specs.find(({ title }) =>
      title.startsWith("TEST-STORAGE-CONTEXT-EPHEMERALITY"),
    );
    const contextAttachments = contextSpec?.tests[0].results[0].attachments;
    const contextScreenshot = contextAttachments?.find(
      ({ name }) => name === "screenshot",
    );
    assert.ok(contextAttachments && contextScreenshot?.path);

    await verifyStoragePlaywrightResults(fixture.report, options(fixture));

    const nonContextSpec = fixture.report.suites[0].specs.find(
      ({ title }) => !title.startsWith("TEST-STORAGE-CONTEXT-EPHEMERALITY"),
    );
    const nonContextAttachments =
      nonContextSpec?.tests[0].results[0].attachments;
    const nonContextScreenshot = nonContextAttachments?.find(
      ({ name }) => name === "screenshot",
    );
    assert.ok(nonContextAttachments && nonContextScreenshot?.path);
    const extraNonContextScreenshot = path.join(
      path.dirname(nonContextScreenshot.path),
      "test-finished-2.png",
    );
    await writeFile(extraNonContextScreenshot, "extra screenshot");
    const extraNonContextAttachment = {
      contentType: "image/png",
      name: "screenshot",
      path: extraNonContextScreenshot,
    };
    nonContextAttachments.push(extraNonContextAttachment);
    await assert.rejects(
      verifyStoragePlaywrightResults(fixture.report, options(fixture)),
      /must have exactly 1 screenshot attachment/u,
    );
    nonContextAttachments.pop();

    const thirdContextScreenshot = path.join(
      path.dirname(contextScreenshot.path),
      "test-finished-3.png",
    );
    await writeFile(thirdContextScreenshot, "third context screenshot");
    contextAttachments.push({
      contentType: "image/png",
      name: "screenshot",
      path: thirdContextScreenshot,
    });
    await assert.rejects(
      verifyStoragePlaywrightResults(fixture.report, options(fixture)),
      /must have exactly 2 screenshot attachments/u,
    );
  });

  it("binds the JUnit summary to the same 36 green executions", async () => {
    const fixture = await validFixture();
    await writeFile(
      fixture.junitReport,
      '<?xml version="1.0"?><testsuites tests="35" failures="0" errors="0" skipped="0"></testsuites>',
    );

    await assert.rejects(
      verifyStoragePlaywrightResults(fixture.report, options(fixture)),
      /JUnit report must record 36 tests/u,
    );
  });
});
