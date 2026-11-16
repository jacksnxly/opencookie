import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDxWorkflowContracts,
  renderDxWorkflowCommand,
} from "./e2e/dx-catalogue.mjs";
import { extractDisplayedSample } from "./verify-docs-samples-lib.mjs";

const plainMinimalSamplePath = fileURLToPath(
  new URL("../apps/docs/samples/plain-minimal.sample.ts", import.meta.url),
);

async function plainMinimalSource() {
  return extractDisplayedSample(
    await readFile(plainMinimalSamplePath, "utf8"),
    "plain-minimal.sample.ts",
  ).source;
}

export function buildDxDocsContracts(definitions, options) {
  return Object.freeze(
    buildDxWorkflowContracts(definitions, options).map((contract) => {
      const byId = new Map(
        contract.documentedSteps.map((step) => [step.id, step]),
      );
      return Object.freeze({
        allowBuilds: Object.freeze([...contract.definition.allowBuilds]),
        build: renderDxWorkflowCommand(byId.get("build")?.command),
        buildApproval: byId.has("approve-builds")
          ? renderDxWorkflowCommand(byId.get("approve-builds").command)
          : undefined,
        createPage:
          byId.has("document") && byId.get("document").command !== undefined
            ? renderDxWorkflowCommand(byId.get("document").command)
            : undefined,
        documentedSteps: contract.documentedSteps,
        guide: contract.guide,
        id: contract.id,
        init: renderDxWorkflowCommand(byId.get("init")?.command),
        install: renderDxWorkflowCommand(byId.get("install")?.command),
        scaffold: renderDxWorkflowCommand(byId.get("scaffold")?.command),
        serve: renderDxWorkflowCommand(byId.get("serve")?.command),
      });
    }),
  );
}

function documentedCommands(source) {
  const commands = new Map();
  const duplicates = new Set();
  const orderedLabels = [];
  const pattern =
    /^- (Scaffold|Create page|Approve builds|Install|Initialize|Build|Serve): `([^`\n]+)`$/gmu;
  for (const match of source.matchAll(pattern)) {
    const label = match[1];
    if (commands.has(label)) duplicates.add(label);
    commands.set(label, match[2]);
    orderedLabels.push(label);
  }
  return { commands, duplicates, orderedLabels };
}

export async function collectDxDocsIssues({ definitions, docsRoot }) {
  const issues = [];
  const contracts = buildDxDocsContracts(definitions, {
    plainMinimalSource: await plainMinimalSource(),
  });

  for (const contract of contracts) {
    const file = path.join(docsRoot, contract.guide);
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        issues.push(`${contract.guide} is missing for DX case ${contract.id}.`);
        continue;
      }
      throw error;
    }

    const { commands, duplicates, orderedLabels } = documentedCommands(source);
    const expectedSteps = contract.documentedSteps;
    const expectedLabels = expectedSteps.map(({ label }) => label);
    if (JSON.stringify(orderedLabels) !== JSON.stringify(expectedLabels)) {
      issues.push(
        `${contract.guide} command order drifted. Expected ${expectedLabels.join(" -> ")}, received ${orderedLabels.join(" -> ")}.`,
      );
    }
    for (const step of expectedSteps) {
      if (duplicates.has(step.label)) {
        issues.push(`${contract.guide} repeats the ${step.label} command.`);
        continue;
      }
      const expected = renderDxWorkflowCommand(step.command);
      const actual = commands.get(step.label);
      if (actual !== expected) {
        issues.push(
          `${contract.guide} ${step.label} command drifted. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
        );
      }
    }
    for (const unexpected of orderedLabels.filter(
      (label) => !expectedLabels.includes(label),
    )) {
      issues.push(`${contract.guide} has an unexpected ${unexpected} command.`);
    }
  }

  return issues.sort();
}
