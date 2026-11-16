import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  BINDING_E2E_CONTRACTS,
  BINDING_TAG,
  REQUIRED_E2E_CONTRACTS,
} from "./contract-catalogue.mjs";

const contractsRoot = fileURLToPath(
  new URL("../../tests/e2e/contracts/", import.meta.url),
);

function literalTags(details) {
  if (details === undefined || !ts.isObjectLiteralExpression(details)) {
    return [];
  }
  const tags = [];
  for (const property of details.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isIdentifier(property.name) ||
      property.name.text !== "tag"
    ) {
      continue;
    }
    const values = ts.isArrayLiteralExpression(property.initializer)
      ? property.initializer.elements
      : [property.initializer];
    for (const value of values) {
      if (ts.isStringLiteralLike(value)) tags.push(value.text);
    }
  }
  return tags;
}

function collectLiteralTests(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const tests = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "test"
    ) {
      const [title, details] = node.arguments;
      if (title !== undefined && ts.isStringLiteralLike(title)) {
        tests.push({ tags: literalTags(details), title: title.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return tests;
}

async function declaredContractTests() {
  const files = (await readdir(contractsRoot))
    .filter((file) => file.endsWith(".spec.ts"))
    .sort();
  const tests = [];
  for (const file of files) {
    const filePath = path.join(contractsRoot, file);
    tests.push(
      ...collectLiteralTests(await readFile(filePath, "utf8"), filePath),
    );
  }
  return tests;
}

function contractsNamedBy(tests) {
  const titleTokens = new Set(
    tests.flatMap(({ title }) => title.split(/\s+/u).filter(Boolean)),
  );
  return REQUIRED_E2E_CONTRACTS.filter((contract) => titleTokens.has(contract));
}

test("every stable G6 contract is bound to a real Playwright test title", async () => {
  const named = new Set(contractsNamedBy(await declaredContractTests()));
  const missing = REQUIRED_E2E_CONTRACTS.filter(
    (contract) => !named.has(contract),
  );

  assert.deepEqual(missing, []);
});

test("the binding tag sits on exactly the tests that prove the binding contracts", async () => {
  const tagged = (await declaredContractTests()).filter(({ tags }) =>
    tags.includes(BINDING_TAG),
  );

  assert.deepEqual(
    contractsNamedBy(tagged).sort(),
    [...BINDING_E2E_CONTRACTS].sort(),
  );
});

test("no test title spells the binding tag, so the change tier's grep matches the tag alone", async () => {
  const spelled = (await declaredContractTests())
    .map(({ title }) => title)
    .filter((title) => title.includes(BINDING_TAG));

  assert.deepEqual(spelled, []);
});
