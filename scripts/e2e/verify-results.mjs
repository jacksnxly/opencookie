import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BINDING_E2E_CONTRACTS,
  REQUIRED_E2E_CONTRACTS,
} from "./contract-catalogue.mjs";
import { createPlaywrightProjects, E2E_TIERS } from "./project-matrix.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultReport = path.join(
  repositoryRoot,
  "artifacts/playwright/results.json",
);
const defaultHtmlReport = path.join(
  repositoryRoot,
  "artifacts/playwright/html-report/index.html",
);
const defaultJunitReport = path.join(
  repositoryRoot,
  "artifacts/playwright/results.xml",
);

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

function contractIds(title) {
  return REQUIRED_E2E_CONTRACTS.filter((contract) => title.includes(contract));
}

function logicalSpecKey(spec, suitePath) {
  return JSON.stringify([
    suitePath,
    String(spec.file ?? ""),
    Number(spec.line ?? 0),
    Number(spec.column ?? 0),
    String(spec.title ?? ""),
  ]);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function projectPatternExpression(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError("Project patterns must be non-empty strings.");
  }
  return new RegExp(
    `^${pattern.split("*").map(escapeRegularExpression).join(".*")}$`,
    "u",
  );
}

/**
 * Maps each project the report must prove to the contracts it must run: a
 * project that greps the binding tag owes the binding contracts, every other
 * project owes them all.
 */
function selectExpectedProjects(tier, projectPatterns) {
  const tierProjects = createPlaywrightProjects({ tier });
  const expressions = projectPatterns.map(projectPatternExpression);
  const selected = tierProjects.filter(
    ({ name }) =>
      expressions.length === 0 ||
      expressions.some((expression) => expression.test(name)),
  );
  if (selected.length === 0) {
    throw new Error(
      `Project patterns matched no G6 ${tier}-tier projects: ${projectPatterns.join(", ")}`,
    );
  }
  return new Map(
    selected.map((project) => [
      project.name,
      project.grep === undefined
        ? REQUIRED_E2E_CONTRACTS
        : BINDING_E2E_CONTRACTS,
    ]),
  );
}

/** Validates that a Playwright JSON report proves one complete G6 tier. */
export async function verifyPlaywrightResults(
  reportValue,
  {
    expectedRepeats = 1,
    htmlReport = defaultHtmlReport,
    junitReport = defaultJunitReport,
    projectPatterns = [],
    tier = "release",
  } = {},
) {
  if (!E2E_TIERS.includes(tier)) {
    throw new TypeError(
      `Unknown E2E tier ${JSON.stringify(tier)}; expected one of: ${E2E_TIERS.join(", ")}.`,
    );
  }
  if (!Number.isSafeInteger(expectedRepeats) || expectedRepeats < 1) {
    throw new TypeError("Expected repeats must be a positive safe integer.");
  }
  const report = object(reportValue, "Playwright report");
  const errors = array(report.errors ?? [], "Playwright report errors");
  const stats = object(report.stats ?? {}, "Playwright report stats");
  if (errors.length > 0 || !aggregateIsGreen(stats)) {
    throw new Error("Playwright report has a non-green aggregate status.");
  }

  if (!Array.isArray(projectPatterns)) {
    throw new TypeError("Project patterns must be an array.");
  }
  const expectedProjects = selectExpectedProjects(tier, projectPatterns);
  const configuredProjects = array(
    object(report.config ?? {}, "Playwright config").projects ?? [],
    "Playwright config projects",
  );
  for (const projectValue of configuredProjects) {
    const project = object(projectValue, "Configured Playwright project");
    if (!expectedProjects.has(project.name)) continue;
    if (project.repeatEach !== expectedRepeats || project.retries !== 0) {
      throw new Error(
        `Project ${String(project.name)} must use ${String(expectedRepeats)} repeats and zero retries.`,
      );
    }
  }

  const seenProjects = new Set();
  const seenContracts = new Map(
    [...expectedProjects.keys()].map((project) => [project, new Set()]),
  );
  const logicalExecutions = new Map();
  let executions = 0;
  for (const { spec, suitePath } of allSpecs(
    array(report.suites ?? [], "Playwright suites"),
  )) {
    const contracts = contractIds(String(spec.title ?? ""));
    const specKey = logicalSpecKey(spec, suitePath);
    for (const testValue of array(spec.tests ?? [], "Playwright tests")) {
      const test = object(testValue, "Playwright test");
      const projectName = String(test.projectName ?? "");
      if (!expectedProjects.has(projectName)) continue;
      seenProjects.add(projectName);
      for (const contract of contracts)
        seenContracts.get(projectName)?.add(contract);
      if (test.expectedStatus !== "passed" || test.status !== "expected") {
        throw new Error(
          `${projectName} contains a non-passing test classification.`,
        );
      }
      const results = array(test.results ?? [], "Playwright test results");
      const executionKey = JSON.stringify([projectName, specKey]);
      const groupedResults = logicalExecutions.get(executionKey) ?? {
        projectName,
        results: [],
        title: String(spec.title ?? ""),
      };
      groupedResults.results.push(...results);
      logicalExecutions.set(executionKey, groupedResults);
      for (const resultValue of results) {
        const result = object(resultValue, "Playwright test result");
        const resultErrors = array(
          result.errors ?? [],
          "Playwright result errors",
        );
        if (
          result.status !== "passed" ||
          result.retry !== 0 ||
          resultErrors.length > 0
        ) {
          throw new Error(
            `${projectName} contains a retry or non-passing result.`,
          );
        }
        // Trace and video are kept on failure only, so a pass carries neither.
        executions += 1;
      }
    }
  }

  for (const execution of logicalExecutions.values()) {
    if (execution.results.length !== expectedRepeats) {
      throw new Error(
        `${execution.projectName} ${execution.title} expected ${String(expectedRepeats)} repeats but recorded ${String(execution.results.length)}.`,
      );
    }
  }

  const missingProjects = [...expectedProjects.keys()].filter(
    (project) => !seenProjects.has(project),
  );
  if (missingProjects.length > 0) {
    throw new Error(
      `Missing Playwright projects: ${missingProjects.join(", ")}`,
    );
  }
  const missingContracts = [];
  for (const [project, requiredContracts] of expectedProjects) {
    const observed = seenContracts.get(project) ?? new Set();
    for (const contract of requiredContracts) {
      if (!observed.has(contract))
        missingContracts.push(`${project}:${contract}`);
    }
  }
  if (missingContracts.length > 0) {
    throw new Error(`Missing E2E contracts: ${missingContracts.join(", ")}`);
  }
  if (Number(stats.expected ?? -1) !== executions) {
    throw new Error(
      `Playwright expected-count mismatch: stats=${String(stats.expected)} executions=${String(executions)}.`,
    );
  }
  await requireFile(htmlReport, "Playwright HTML report");
  await requireFile(junitReport, "Playwright JUnit report");

  return Object.freeze({
    contracts: new Set([...expectedProjects.values()].flat()).size,
    projects: expectedProjects.size,
    repeats: expectedRepeats,
    tests: executions,
    tier,
  });
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${name} requires a value.`);
    values.push(value);
  }
  return values;
}

async function main() {
  const args = process.argv.slice(2);
  const tier = option(args, "--tier", undefined);
  if (tier === undefined) {
    throw new Error(
      `--tier is required: one of ${E2E_TIERS.join(", ")}, the tier the report ran.`,
    );
  }
  const repeatsValue = option(args, "--expected-repeats", "1");
  const expectedRepeats = Number.parseInt(repeatsValue ?? "", 10);
  const reportPath = option(args, "--report", defaultReport);
  const htmlReport = option(args, "--html-report", defaultHtmlReport);
  const junitReport = option(args, "--junit-report", defaultJunitReport);
  const projectPatterns = options(args, "--project-pattern");
  if (reportPath === undefined) throw new Error("Report path is missing.");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const summary = await verifyPlaywrightResults(report, {
    expectedRepeats,
    htmlReport,
    junitReport,
    projectPatterns,
    tier,
  });
  console.log(
    `G6 result integrity PASS: ${summary.tier} tier, ${String(summary.projects)} projects, ${String(summary.contracts)} contracts, ${String(summary.repeats)} repeats, ${String(summary.tests)} executions.`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await main();
}
