import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  RELEASED_SIZES,
  SIZE_BUDGET_AXES,
  assertLiveSizeRatchet,
  coreConsumerGraphs,
  describeBudgetGrowth,
  programmaticRouteGraphs,
} from "./verify-core-consumer-sizes-lib.mjs";

async function sizeLimitEntries() {
  return JSON.parse(
    await readFile(new URL("../.size-limit.json", import.meta.url), "utf8"),
  );
}

function ratchet(artifactResults) {
  return assertLiveSizeRatchet({
    artifactResults,
    graphResults: [],
    pinnedNodeVersion: "24.19.0",
    runningNodeVersion: "24.19.0",
  });
}

test("the drop-in and the programmatic route carry their budgets", async () => {
  const entries = await sizeLimitEntries();
  const limit = (name) => entries.find((entry) => entry.name === name)?.limit;
  assert.equal(limit("vanilla auto IIFE"), "45000 B");
  assert.equal(limit("vanilla auto IIFE raw"), "150000 B");
  assert.deepEqual(
    programmaticRouteGraphs.map(({ limitBytes, rawLimitBytes }) => [
      limitBytes,
      rawLimitBytes,
    ]),
    [[50_000, 175_000]],
  );
});

test("the core ceilings do not move", async () => {
  const entries = await sizeLimitEntries();
  assert.deepEqual(
    Object.fromEntries(
      entries
        .filter(({ name }) => name.startsWith("core "))
        .map(({ limit, name }) => [name, limit]),
    ),
    {
      "core application ESM": "14220 B",
      "core auto ESM": "26121 B",
      "core browser ESM": "27708 B",
      "core domain ESM": "10543 B",
      "core infrastructure ESM": "5789 B",
      "core reconciliation ESM": "7941 B",
    },
  );
  assert.deepEqual(
    coreConsumerGraphs.map(({ limitBytes }) => limitBytes),
    [32_388, 42_565, 32_835],
  );
});

test("budget axes leave the one-percent ratchet and core axes keep it", () => {
  assert.deepEqual([...SIZE_BUDGET_AXES].sort(), [
    "vanilla auto IIFE",
    "vanilla auto IIFE raw",
    "vanilla programmatic route",
    "vanilla programmatic route raw",
  ]);
  assert.doesNotThrow(() =>
    ratchet([
      { limitBytes: 45_000, measuredBytes: 39_565, name: "vanilla auto IIFE" },
    ]),
  );
  assert.throws(
    () =>
      ratchet([
        {
          limitBytes: 45_000,
          measuredBytes: 45_000,
          name: "vanilla auto IIFE",
        },
      ]),
    /vanilla auto IIFE/u,
  );
  assert.throws(
    () =>
      ratchet([
        { limitBytes: 27_383, measuredBytes: 27_000, name: "core browser ESM" },
      ]),
    /Tighten/u,
  );
});

test("each budget axis reports its size against the budget and the last release", () => {
  assert.deepEqual(
    Object.keys(RELEASED_SIZES).sort(),
    [...SIZE_BUDGET_AXES].sort(),
  );
  assert.equal(RELEASED_SIZES["vanilla auto IIFE"], 40_398);
  assert.equal(
    describeBudgetGrowth({
      limitBytes: 45_000,
      measuredBytes: 39_700,
      name: "vanilla auto IIFE",
    }),
    "vanilla auto IIFE: 39,700 of 45,000 bytes (5,300 left), -698 since the last release",
  );
  assert.equal(
    describeBudgetGrowth({
      limitBytes: 45_000,
      measuredBytes: 39_465,
      name: "vanilla auto IIFE",
    }),
    "vanilla auto IIFE: 39,465 of 45,000 bytes (5,535 left), -933 since the last release",
  );
});
