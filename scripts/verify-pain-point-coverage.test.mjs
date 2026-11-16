import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPainPointCoverage,
  isTestSourceFile,
  parseTraceability,
  parseDeclaredPainPoints,
  parseBoundPainPoints,
} from "./verify-pain-point-coverage-lib.mjs";

const TABLE = `# doc

## Traceability table

| Pain point | Requirement or ADR | Test |
| --- | --- | --- |
| PP-01 | REQ-A | TEST-A |
| PP-02 | REQ-B | TEST-B |
| PP-03 | REQ-C | TEST-C |
`;

test("reads every declared pain point from the traceability table", () => {
  assert.deepEqual(parseDeclaredPainPoints(TABLE), ["PP-01", "PP-02", "PP-03"]);
});

test("reads bound pain points only from an explicit covers marker", () => {
  const marker = "@" + "covers";
  const bound = parseBoundPainPoints([
    `it('blocks before consent', () => {}); // ${marker} PP-01`,
    "// PP-02 is merely mentioned here, which is not a binding",
    `/* ${marker} PP-03 */`,
  ]);
  assert.deepEqual([...bound].sort(), ["PP-01", "PP-03"]);
});

test("accepts a pain point that is bound to a test", () => {
  assert.doesNotThrow(() => {
    assertPainPointCoverage({
      declared: ["PP-01"],
      bound: new Set(["PP-01"]),
      unboundLedger: new Map(),
    });
  });
});

test("accepts an unbound pain point that is recorded in the ledger", () => {
  assert.doesNotThrow(() => {
    assertPainPointCoverage({
      declared: ["PP-01"],
      bound: new Set(),
      unboundLedger: new Map([["PP-01", "no coverage yet"]]),
    });
  });
});

test("rejects a pain point that is neither bound nor recorded", () => {
  assert.throws(
    () =>
      assertPainPointCoverage({
        declared: ["PP-02"],
        bound: new Set(),
        unboundLedger: new Map(),
      }),
    /PP-02/u,
  );
});

test("rejects a ledger entry that is actually bound, so the ledger only shrinks", () => {
  assert.throws(
    () =>
      assertPainPointCoverage({
        declared: ["PP-01"],
        bound: new Set(["PP-01"]),
        unboundLedger: new Map([["PP-01", "stale"]]),
      }),
    /PP-01/u,
  );
});

test("rejects a ledger entry for a pain point the document does not declare", () => {
  assert.throws(
    () =>
      assertPainPointCoverage({
        declared: ["PP-01"],
        bound: new Set(["PP-01"]),
        unboundLedger: new Map([["PP-99", "ghost"]]),
      }),
    /PP-99/u,
  );
});

test("counts gate verifiers as test sources, not only package tests", () => {
  assert.equal(isTestSourceFile("browser-runtime.test.ts"), true);
  assert.equal(isTestSourceFile("policy-store.spec.tsx"), true);
  assert.equal(
    isTestSourceFile("verify-workspace-architecture.test.mjs"),
    true,
  );
  assert.equal(isTestSourceFile("size-budget-units.test.mjs"), true);
  assert.equal(isTestSourceFile("verify-all-lib.mjs"), false);
  assert.equal(isTestSourceFile("README.md"), false);
});

test("ignores its own fixtures so sample identifiers are never read as bindings", () => {
  assert.equal(isTestSourceFile("verify-pain-point-coverage.test.mjs"), false);
});

test("reads the test identifier each pain point is traced to", () => {
  assert.deepEqual(
    [...parseTraceability(TABLE).entries()],
    [
      ["PP-01", "TEST-A"],
      ["PP-02", "TEST-B"],
      ["PP-03", "TEST-C"],
    ],
  );
});

test("binds a pain point when its traced test identifier appears in a test source", () => {
  const traceability = parseTraceability(TABLE);
  const bound = parseBoundPainPoints(
    ['test("TEST-B drives a real browser", () => {});'],
    traceability,
  );
  assert.deepEqual([...bound], ["PP-02"]);
});

test("does not bind a pain point whose traced identifier appears nowhere", () => {
  const traceability = parseTraceability(TABLE);
  const bound = parseBoundPainPoints(["nothing relevant here"], traceability);
  assert.deepEqual([...bound], []);
});
