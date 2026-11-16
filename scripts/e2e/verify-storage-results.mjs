import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createStorageContractCases,
  STORAGE_E2E_CONTRACTS,
  STORAGE_E2E_INTEGRATIONS,
} from "./storage-contract-catalogue.mjs";
import { createStoragePlaywrightProjects } from "./storage-project-matrix.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const artifactRoot = path.join(repositoryRoot, "artifacts/playwright-storage");
const defaultReport = path.join(artifactRoot, "results.json");
const defaultHtmlReport = path.join(artifactRoot, "html-report/index.html");
const defaultJunitReport = path.join(artifactRoot, "results.xml");

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function allSpecs(suites, parentPath = []) {
  const specs = [];
  for (const suiteValue of suites) {
    const suite = object(suiteValue, "Playwright suite");
    const suitePath = [...parentPath, String(suite.title ?? "")];
    specs.push(
      ...array(suite.specs ?? [], "Playwright specs").map((specValue) => ({
        spec: object(specValue, "Playwright spec"),
        suitePath,
      })),
    );
    specs.push(
      ...allSpecs(
        array(suite.suites ?? [], "Nested Playwright suites"),
        suitePath,
      ),
    );
  }
  return specs;
}

function aggregateIsGreen(stats) {
  return ["flaky", "interrupted", "skipped", "unexpected"].every(
    (key) => Number(stats[key] ?? 0) === 0,
  );
}

async function requireFile(filePath, label) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new Error(`${label} path is missing.`);
  }
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} is missing at ${filePath}.`);
  }
}

function caseForTitle(title) {
  return createStorageContractCases().find(
    ({ contract, integration }) => title === `${contract} ${integration.id}`,
  );
}

function sameMembers(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((entry) => expected.includes(entry))
  );
}

const STORAGE_OPERATION_KEYS = Object.freeze([
  "cookieReads",
  "cookieWrites",
  "localGetterReads",
  "localReads",
  "localRemoves",
  "localWrites",
]);

function operationCounters(value, label) {
  const counters = object(value, label);
  if (
    !sameMembers(Object.keys(counters), STORAGE_OPERATION_KEYS) ||
    STORAGE_OPERATION_KEYS.some(
      (key) =>
        !Number.isSafeInteger(counters[key]) || Number(counters[key]) < 0,
    )
  ) {
    throw new Error(`${label} must contain exact nonnegative counters.`);
  }
  return counters;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function requireExecutionArtifact(
  attachment,
  {
    artifactName,
    contentType,
    executionArtifactRoot,
    extension,
    projectName,
    seenArtifactPaths,
  },
) {
  if (
    typeof attachment.path !== "string" ||
    attachment.path.length === 0 ||
    "body" in attachment
  ) {
    throw new Error(
      `${projectName} ${artifactName} must be file-backed with a path.`,
    );
  }
  if (attachment.contentType !== contentType) {
    throw new Error(`${projectName} ${artifactName} must be ${contentType}.`);
  }
  if (path.extname(String(attachment.path ?? "")) !== extension) {
    throw new Error(
      `${projectName} ${artifactName} must use the ${extension} extension.`,
    );
  }
  await requireFile(attachment.path, `${projectName} ${artifactName}`);
  const resolvedPath = await realpath(attachment.path);
  if (!isWithin(executionArtifactRoot, resolvedPath)) {
    throw new Error(
      `${projectName} ${artifactName} is outside the storage artifact root.`,
    );
  }
  if (seenArtifactPaths.has(resolvedPath)) {
    throw new Error(`${projectName} reuses an execution artifact.`);
  }
  seenArtifactPaths.add(resolvedPath);
  return resolvedPath;
}

async function verifyEvidence(
  attachment,
  contractCase,
  projectName,
  artifactOptions,
) {
  const evidencePath = await requireExecutionArtifact(attachment, {
    ...artifactOptions,
    artifactName: "storage evidence",
    contentType: "application/json",
    extension: ".json",
    projectName,
  });
  const evidence = object(
    JSON.parse(await readFile(evidencePath, "utf8")),
    `${projectName} storage evidence`,
  );
  if (
    evidence.contract !== contractCase.contract ||
    evidence.integration !== contractCase.integration.id ||
    evidence.mechanism !== contractCase.mechanism
  ) {
    throw new Error(
      `${projectName} storage evidence does not match its storage case.`,
    );
  }
  if (contractCase.recoveryOutcome === "policy-remains-blocked") {
    if (
      evidence.policyLabel !== "deterministic emulation" ||
      evidence.recoveryOutcome !== contractCase.recoveryOutcome ||
      evidence.released !== false
    ) {
      throw new Error(
        `${projectName} cross-site policy evidence must remain blocked under deterministic emulation.`,
      );
    }
    const beforeRetry = operationCounters(
      evidence.beforeRetryOperations,
      `${projectName} cross-site before-retry operations`,
    );
    const afterRetry = operationCounters(
      evidence.afterRetryOperations,
      `${projectName} cross-site after-retry operations`,
    );
    if (
      Number(beforeRetry.cookieWrites) < 1 ||
      Number(afterRetry.cookieWrites) <= Number(beforeRetry.cookieWrites)
    ) {
      throw new Error(
        `${projectName} cross-site policy retry must make an additional cookie write attempt.`,
      );
    }
  } else if (
    "policyLabel" in evidence ||
    "recoveryOutcome" in evidence ||
    "released" in evidence ||
    "beforeRetryOperations" in evidence ||
    "afterRetryOperations" in evidence
  ) {
    throw new Error(
      `${projectName} non-policy evidence must not claim a cross-site policy outcome.`,
    );
  }
}

function junitAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}="([0-9]+)"`, "u").exec(attributes);
  return match === null ? undefined : Number.parseInt(match[1], 10);
}

async function verifyJunitReport(junitReport, expectedExecutions) {
  const xml = await readFile(junitReport, "utf8");
  const root = /<testsuites\b([^>]*)>/u.exec(xml);
  if (root === null) {
    throw new Error("Playwright storage JUnit report has no testsuites root.");
  }
  const attributes = root[1] ?? "";
  if (junitAttribute(attributes, "tests") !== expectedExecutions) {
    throw new Error(
      `JUnit report must record ${String(expectedExecutions)} tests.`,
    );
  }
  for (const status of ["failures", "errors", "skipped"]) {
    if (junitAttribute(attributes, status) !== 0) {
      throw new Error(`JUnit report must record zero ${status}.`);
    }
  }
}

/** Validates complete, exact evidence for the standalone storage matrix. */
export async function verifyStoragePlaywrightResults(
  reportValue,
  {
    artifactRoot: configuredArtifactRoot = artifactRoot,
    htmlReport = defaultHtmlReport,
    junitReport = defaultJunitReport,
  } = {},
) {
  const report = object(reportValue, "Playwright report");
  const errors = array(report.errors ?? [], "Playwright report errors");
  const stats = object(report.stats ?? {}, "Playwright report stats");
  if (errors.length > 0 || !aggregateIsGreen(stats)) {
    throw new Error("Playwright report has a non-green aggregate status.");
  }

  const expectedProjects = createStoragePlaywrightProjects().map(
    ({ name }) => name,
  );
  const expectedProjectSet = new Set(expectedProjects);
  await requireFile(configuredArtifactRoot, "Playwright storage artifact root");
  const resolvedArtifactRoot = await realpath(configuredArtifactRoot);
  const executionArtifactRoot = await realpath(
    path.join(configuredArtifactRoot, "test-results"),
  );
  const seenArtifactPaths = new Set();
  const configuredProjects = array(
    object(report.config ?? {}, "Playwright config").projects ?? [],
    "Playwright config projects",
  );
  const configuredNames = configuredProjects.map((value) =>
    String(object(value, "Configured Playwright project").name ?? ""),
  );
  if (
    new Set(configuredNames).size !== expectedProjects.length ||
    !sameMembers(configuredNames, expectedProjects)
  ) {
    throw new Error(
      `Configured storage projects do not match the expected matrix: ${configuredNames.join(", ")}`,
    );
  }
  for (const projectValue of configuredProjects) {
    const project = object(projectValue, "Configured Playwright project");
    if (project.repeatEach !== 1 || project.retries !== 0) {
      throw new Error(
        `Project ${String(project.name)} must use one repeat and zero retries.`,
      );
    }
  }

  const expectedCases = createStorageContractCases();
  const observedCases = new Map(
    expectedProjects.map((project) => [project, new Set()]),
  );
  let executions = 0;
  for (const { spec } of allSpecs(
    array(report.suites ?? [], "Playwright suites"),
  )) {
    const title = String(spec.title ?? "");
    const contractCase = caseForTitle(title);
    if (contractCase === undefined) {
      throw new Error(`Unexpected or ambiguous storage case: ${title}`);
    }
    for (const testValue of array(spec.tests ?? [], "Playwright tests")) {
      const test = object(testValue, "Playwright test");
      const projectName = String(test.projectName ?? "");
      if (!expectedProjectSet.has(projectName)) {
        throw new Error(`Unexpected storage project result: ${projectName}`);
      }
      const caseId = contractCase.id;
      const seen = observedCases.get(projectName);
      if (seen?.has(caseId) === true) {
        throw new Error(`Duplicate storage case: ${projectName}:${caseId}`);
      }
      seen?.add(caseId);
      if (test.expectedStatus !== "passed" || test.status !== "expected") {
        throw new Error(
          `${projectName} contains a non-passing test classification.`,
        );
      }
      const results = array(test.results ?? [], "Playwright test results");
      if (results.length !== 1) {
        throw new Error(
          `${projectName} ${title} must record exactly one repeat.`,
        );
      }
      const result = object(results[0], "Playwright test result");
      if (
        result.status !== "passed" ||
        result.retry !== 0 ||
        array(result.errors ?? [], "Playwright result errors").length > 0
      ) {
        throw new Error(
          `${projectName} contains a retry or non-passing result.`,
        );
      }
      const attachments = array(
        result.attachments ?? [],
        "Playwright result attachments",
      );
      for (const [artifactName, contentType, extension] of [
        ["trace", "application/zip", ".zip"],
        ["video", "video/webm", ".webm"],
      ]) {
        const matchingAttachments = attachments.filter(
          ({ name }) => name === artifactName,
        );
        if (matchingAttachments.length === 0) {
          throw new Error(
            `${projectName} is missing ${artifactName} evidence.`,
          );
        }
        if (matchingAttachments.length !== 1) {
          throw new Error(
            `${projectName} must have exactly one ${artifactName} attachment.`,
          );
        }
        await requireExecutionArtifact(matchingAttachments[0], {
          artifactName,
          contentType,
          executionArtifactRoot,
          extension,
          projectName,
          seenArtifactPaths,
        });
      }
      const expectedScreenshotCount = contractCase.screenshotCount ?? 1;
      const screenshotAttachments = attachments.filter(
        ({ name }) => name === "screenshot",
      );
      if (screenshotAttachments.length === 0) {
        throw new Error(`${projectName} is missing screenshot evidence.`);
      }
      if (screenshotAttachments.length !== expectedScreenshotCount) {
        throw new Error(
          `${projectName} must have exactly ${String(expectedScreenshotCount)} screenshot attachment${expectedScreenshotCount === 1 ? "" : "s"}.`,
        );
      }
      for (const screenshotAttachment of screenshotAttachments) {
        await requireExecutionArtifact(screenshotAttachment, {
          artifactName: "screenshot",
          contentType: "image/png",
          executionArtifactRoot,
          extension: ".png",
          projectName,
          seenArtifactPaths,
        });
      }
      const storageEvidenceAttachments = attachments.filter(
        ({ name }) => name === "storage-evidence",
      );
      if (storageEvidenceAttachments.length === 0) {
        throw new Error(`${projectName} is missing storage evidence.`);
      }
      if (storageEvidenceAttachments.length !== 1) {
        throw new Error(
          `${projectName} must have exactly one storage evidence attachment.`,
        );
      }
      await verifyEvidence(
        storageEvidenceAttachments[0],
        contractCase,
        projectName,
        {
          executionArtifactRoot,
          seenArtifactPaths,
        },
      );
      executions += 1;
    }
  }

  const missingCases = [];
  for (const projectName of expectedProjects) {
    const seen = observedCases.get(projectName) ?? new Set();
    for (const contractCase of expectedCases) {
      if (!seen.has(contractCase.id)) {
        missingCases.push(`${projectName}:${contractCase.id}`);
      }
    }
  }
  if (missingCases.length > 0) {
    throw new Error(`Missing storage cases: ${missingCases.join(", ")}`);
  }
  const expectedExecutions = expectedProjects.length * expectedCases.length;
  if (
    executions !== expectedExecutions ||
    Number(stats.expected ?? -1) !== expectedExecutions
  ) {
    throw new Error(
      `Storage execution mismatch: expected=${String(expectedExecutions)} stats=${String(stats.expected)} observed=${String(executions)}.`,
    );
  }
  await requireFile(htmlReport, "Playwright storage HTML report");
  await requireFile(junitReport, "Playwright storage JUnit report");
  const [resolvedHtmlReport, resolvedJunitReport] = await Promise.all([
    realpath(htmlReport),
    realpath(junitReport),
  ]);
  if (
    !isWithin(resolvedArtifactRoot, resolvedHtmlReport) ||
    !isWithin(resolvedArtifactRoot, resolvedJunitReport)
  ) {
    throw new Error("Storage summary reports are outside the artifact root.");
  }
  await verifyJunitReport(resolvedJunitReport, expectedExecutions);

  return Object.freeze({
    cases: expectedCases.length,
    contracts: STORAGE_E2E_CONTRACTS.length,
    integrations: STORAGE_E2E_INTEGRATIONS.length,
    projects: expectedProjects.length,
    repeats: 1,
    tests: executions,
  });
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const reportPath = option(args, "--report", defaultReport);
  const htmlReport = option(args, "--html-report", defaultHtmlReport);
  const junitReport = option(args, "--junit-report", defaultJunitReport);
  if (reportPath === undefined) throw new Error("Report path is missing.");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const summary = await verifyStoragePlaywrightResults(report, {
    htmlReport,
    junitReport,
  });
  console.log(
    `Storage E2E result integrity PASS: ${String(summary.projects)} projects, ${String(summary.integrations)} integrations, ${String(summary.contracts)} contracts, ${String(summary.repeats)} repeat, ${String(summary.tests)} executions.`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await main();
}
