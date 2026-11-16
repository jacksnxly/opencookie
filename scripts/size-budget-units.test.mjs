import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BUDGETS } from "./verify-workspace-architecture-lib.mjs";
import {
  coreConsumerGraphs,
  programmaticRouteGraphs,
} from "./verify-core-consumer-sizes-lib.mjs";

const DOCUMENTED_DECIMAL_BYTES = Object.freeze(
  new Map([
    ["core browser ESM", 27_708],
    ["core domain ESM", 10_543],
    ["core application ESM", 14_220],
    ["core reconciliation ESM", 7_941],
    ["core infrastructure ESM", 5_789],
    ["core auto ESM", 26_121],
    ["vanilla auto IIFE", 45_000],
    ["vanilla auto IIFE raw", 150_000],
  ]),
);

const EXACT_BYTE_LIMIT = /^(\d+)\s*B$/u;

function readSizeConfig() {
  return JSON.parse(
    readFileSync(new URL("../.size-limit.json", import.meta.url), "utf8"),
  );
}

function grouped(value) {
  return String(value).replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
}

// @covers PP-21 REQ-SIZE-BUDGETS: bundle size is an enforced release gate, not advice.
test("every size budget states its documented decimal byte ceiling", () => {
  const entries = readSizeConfig();
  assert.equal(entries.length, DOCUMENTED_DECIMAL_BYTES.size);

  for (const entry of entries) {
    const documented = DOCUMENTED_DECIMAL_BYTES.get(entry.name);
    assert.ok(
      documented !== undefined,
      `${entry.name} is not a documented budget.`,
    );
    const match = EXACT_BYTE_LIMIT.exec(String(entry.limit).trim());
    assert.ok(
      match !== null,
      `${entry.name} must state an exact byte ceiling.`,
    );
    assert.equal(Number(match[1]), documented);
  }
});

test("the architecture verifier pins the same ceilings as the size config", () => {
  const entries = readSizeConfig();
  assert.equal(BUDGETS.size, entries.length);
  for (const entry of entries) {
    const budget = BUDGETS.get(entry.name);
    assert.ok(
      budget,
      `The architecture verifier has no expectation for ${entry.name}.`,
    );
    assert.equal(
      budget.exactBytes,
      Number(EXACT_BYTE_LIMIT.exec(entry.limit)?.[1]),
    );
  }
});

test("the combined consumer graphs keep their ratcheted ceilings", () => {
  assert.deepEqual(
    coreConsumerGraphs.map(({ limitBytes, name }) => [name, limitBytes]),
    [
      ["core root plus infrastructure", 32_388],
      ["core root plus domain plus infrastructure", 42_565],
      ["core domain plus application plus infrastructure", 32_835],
    ],
  );
});

test("the vanilla README states the budgets instead of the old caps", () => {
  const readme = readFileSync(
    new URL("../packages/adapters/vanilla/README.md", import.meta.url),
    "utf8",
  );
  assert.match(
    readme,
    /The active budgets are 45,000 gzip bytes and 150,000 raw bytes/u,
  );
  assert.match(
    readme,
    /Its budget is 50,000 gzip bytes and 175,000 raw bytes/u,
  );
  assert.equal(programmaticRouteGraphs[0]?.limitBytes, 50_000);
  assert.equal(programmaticRouteGraphs[0]?.rawLimitBytes, 175_000);
  for (const retired of ["39,581", "130,124", "44,379", "151,960"]) {
    assert.equal(
      readme.includes(retired),
      false,
      `packages/adapters/vanilla/README.md still states the retired cap ${retired}.`,
    );
  }
});

test("the shipped core README states the enforced per-entry ceilings", () => {
  const readme = readFileSync(
    new URL("../packages/core/README.md", import.meta.url),
    "utf8",
  );
  const rows = new Map([
    ["root", "core browser ESM"],
    ["domain", "core domain ESM"],
    ["application", "core application ESM"],
    ["reconciliation", "core reconciliation ESM"],
    ["infrastructure", "core infrastructure ESM"],
    ["auto", "core auto ESM"],
  ]);

  for (const [label, budget] of rows) {
    const ceiling = DOCUMENTED_DECIMAL_BYTES.get(budget);
    assert.ok(ceiling, `${budget} has no documented ceiling.`);
    assert.match(
      readme,
      new RegExp(
        `\\|\\s*${label}\\s*\\|[^|]*\\|\\s*${grouped(ceiling)} bytes\\s*\\|`,
        "u",
      ),
      `packages/core/README.md must state ${grouped(ceiling)} bytes as the ${label} hard limit.`,
    );
  }
});
