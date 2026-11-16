import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  SCRIPT_TEST_EXCLUSIONS,
  listScriptTests,
} from "./run-script-tests.mjs";
import { VERIFY_TIERS, selectTierSteps } from "./verify-tier-lib.mjs";

const FAST = ["typecheck", "lint", "format", "codegen", "build", "unit"];
const CHANGE = [
  ...FAST,
  "coverage",
  "architecture",
  "scripts",
  "pain-points",
  "docs",
  "mutation",
  "packages",
  "cdn-sri",
  "packed-dx",
  "browser",
  "clean-tree",
];

function stepIds(tier) {
  return VERIFY_TIERS[tier].map(({ id }) => id);
}

function commandOf(tier, id) {
  const step = VERIFY_TIERS[tier].find((candidate) => candidate.id === id);
  assert.ok(step, `${tier} has no ${id} step`);
  return [step.command, ...step.args].join(" ");
}

async function readJson(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );
}

test("the fast tier is the static and unit checks", () => {
  assert.deepEqual(stepIds("fast"), FAST);
});

test("the change tier adds the merge gates and the change browser matrix", () => {
  assert.deepEqual(stepIds("change"), CHANGE);
});

test("the release tier adds performance and the candidate record", () => {
  assert.deepEqual(stepIds("release"), [
    ...CHANGE.slice(0, -1),
    "cdn-performance",
    "candidate",
    "clean-tree",
  ]);
});

test("every tier builds the packages before the unit tests on a fresh checkout", () => {
  for (const tier of ["fast", "change", "release"]) {
    assert.equal(commandOf(tier, "build"), "pnpm build:packages");
  }
});

test("mutation runs incrementally per change and in full at release", () => {
  assert.equal(commandOf("change", "mutation"), "pnpm test:mutation");
  assert.equal(commandOf("release", "mutation"), "pnpm test:mutation:full");
});

test("each tier runs its own browser matrix on the build it made", () => {
  assert.equal(
    commandOf("change", "browser"),
    "pnpm e2e --tier=change --skip-build",
  );
  assert.equal(
    commandOf("release", "browser"),
    "pnpm e2e --tier=release --skip-build",
  );
});

test("--only and --skip select steps and name the ones left out", () => {
  const skipped = selectTierSteps("release", { skip: ["cdn-performance"] });
  assert.equal(
    skipped.steps.some(({ id }) => id === "cdn-performance"),
    false,
  );
  assert.deepEqual(skipped.skipped, ["cdn-performance"]);
  const only = selectTierSteps("release", { only: ["cdn-performance"] });
  assert.deepEqual(
    only.steps.map(({ id }) => id),
    ["cdn-performance"],
  );
  assert.equal(only.skipped.length, VERIFY_TIERS.release.length - 1);
  assert.throws(
    () => selectTierSteps("release", { skip: ["no-such-step"] }),
    /no-such-step/u,
  );
  assert.throws(() => selectTierSteps("nightly"), /nightly/u);
});

test("package scripts expose the three tiers and none of the retired gates", async () => {
  const { scripts } = await readJson("package.json");
  assert.equal(scripts["verify:fast"], "node scripts/verify-tier.mjs fast");
  assert.equal(scripts.verify, "node scripts/verify-tier.mjs change");
  assert.equal(
    scripts["verify:release"],
    "node scripts/verify-tier.mjs release",
  );
  assert.equal(scripts["test:scripts"], "node scripts/run-script-tests.mjs");
  assert.equal(
    scripts["build:packages"],
    'pnpm --filter "./packages/**" --if-present run build',
  );
  assert.equal(scripts["test:mutation"], "stryker run --incremental");
  assert.equal(
    scripts["test:mutation:full"],
    "stryker run --incremental --force",
  );
  for (const retired of [
    "verify:all",
    "verify:objective-pin",
    "verify:research",
    "verify:tdd",
    "test:all-verifier",
    "test:phase7-verifier",
    "test:evidence-verifier",
    "phase7:clean-room",
  ]) {
    assert.equal(scripts[retired], undefined, retired);
  }
});

test("the mutation bar holds and its incremental cache stays out of the tree", async () => {
  const stryker = await readJson("stryker.config.json");
  assert.deepEqual(stryker.thresholds, { break: 85, high: 85, low: 85 });
  const ignored = await readFile(
    new URL("../.gitignore", import.meta.url),
    "utf8",
  );
  assert.match(ignored, /^reports\/$/mu);
});

test("the scripts step runs every script test but the Mac-only Safari harness", async () => {
  assert.deepEqual(SCRIPT_TEST_EXCLUSIONS, [
    "scripts/e2e/native-safari-storage-harness.test.mjs",
  ]);
  const listed = await listScriptTests();
  assert.ok(listed.includes("scripts/verify-tier.test.mjs"));
  assert.ok(listed.includes("scripts/e2e/run-policy.test.mjs"));
  assert.ok(
    !listed.includes("scripts/e2e/native-safari-storage-harness.test.mjs"),
  );
  assert.ok(
    listed.every(
      (file) => file.startsWith("scripts/") && file.endsWith(".test.mjs"),
    ),
  );
});

test("the retired 1.0 proof apparatus is gone", async () => {
  for (const retired of [
    "scripts/phase7",
    "scripts/verify-all.mjs",
    "scripts/verify-objective-pin.mjs",
    "scripts/verify-research.mjs",
    "scripts/verify-tdd.mjs",
    "scripts/verify-evidence-index.mjs",
    "config/tdd-history-exceptions.json",
  ]) {
    await assert.rejects(
      access(new URL(`../${retired}`, import.meta.url)),
      { code: "ENOENT" },
      retired,
    );
  }
});
