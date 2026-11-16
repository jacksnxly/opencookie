import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { runE2E } from "./run-e2e.mjs";

function recorder(exitCodeOf = () => 0) {
  const calls = [];
  return {
    calls,
    run: (command, args, options) => {
      calls.push({ args, command, env: options?.env });
      return Promise.resolve(exitCodeOf(calls.length));
    },
  };
}

function isPlaywright({ args, command }) {
  return (
    command === "pnpm" && args.slice(0, 3).join(" ") === "exec playwright test"
  );
}

describe("E2E command orchestrator", () => {
  it("builds fixtures and preflights browser contracts before Playwright", async () => {
    const { calls, run } = recorder();
    const exitCode = await runE2E({
      args: ["--repeat-each=3", "--project=*-chromium-*"],
      env: { PATH: "/usr/bin" },
      run,
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls[0], {
      args: ["build"],
      command: "pnpm",
      env: undefined,
    });
    assert.equal(calls[1].command, process.execPath);
    assert.match(
      calls[1].args.join(" "),
      /contract-title-bindings[.]test[.]mjs/u,
    );
    assert.match(calls[1].args.join(" "), /cookie-root-path[.]test[.]mjs/u);
    assert.deepEqual(calls[1].args.slice(0, 1), ["--test"]);
    assert.deepEqual(calls[2], {
      args: [
        "exec",
        "playwright",
        "test",
        "--repeat-each=3",
        "--project=*-chromium-*",
      ],
      command: "pnpm",
      env: { OPENCOOKIE_E2E_TIER: "change", PATH: "/usr/bin" },
    });
    assert.equal(calls[3].command, process.execPath);
    assert.match(calls[3].args[0], /verify-results[.]mjs$/u);
    assert.deepEqual(calls[3].args.slice(1), [
      "--tier",
      "change",
      "--project-pattern",
      "*-chromium-*",
      "--expected-repeats",
      "3",
    ]);
    assert.equal(calls.length, 4);
  });

  it("runs a tier on the existing build and keeps its own flags from Playwright", async () => {
    const { calls, run } = recorder();
    const exitCode = await runE2E({
      args: ["--tier=release", "--skip-build", "--project=*-firefox-*"],
      env: { OPENCOOKIE_E2E_TIER: "change" },
      run,
    });

    assert.equal(exitCode, 0);
    assert.equal(calls.length, 3);
    assert.equal(
      calls.some(({ args }) => args.includes("build")),
      false,
    );
    assert.equal(calls[0].command, process.execPath);
    assert.match(
      calls[0].args.join(" "),
      /contract-title-bindings[.]test[.]mjs/u,
    );
    assert.deepEqual(calls[1], {
      args: ["exec", "playwright", "test", "--project=*-firefox-*"],
      command: "pnpm",
      env: { OPENCOOKIE_E2E_TIER: "release" },
    });
    assert.deepEqual(calls[2].args.slice(1), [
      "--tier",
      "release",
      "--project-pattern",
      "*-firefox-*",
      "--expected-repeats",
      "1",
    ]);
  });

  it("reads the flags as pnpm forwards them, after a leading -- or with a spaced tier", async () => {
    const { calls, run } = recorder();
    await runE2E({
      args: ["--", "--skip-build", "--tier", "release"],
      env: {},
      run,
    });

    const playwright = calls.find(isPlaywright);
    assert.deepEqual(playwright.args, ["exec", "playwright", "test"]);
    assert.equal(playwright.env.OPENCOOKIE_E2E_TIER, "release");
    assert.deepEqual(calls.at(-1).args.slice(1), [
      "--tier",
      "release",
      "--expected-repeats",
      "1",
    ]);
  });

  it("rejects an unknown, empty, missing, or repeated tier before running anything", async () => {
    for (const args of [
      ["--tier=nightly"],
      ["--tier="],
      ["--tier"],
      ["--tier=change", "--tier=release"],
    ]) {
      const { calls, run } = recorder();
      await assert.rejects(runE2E({ args, env: {}, run }), TypeError);
      assert.deepEqual(calls, [], args.join(" "));
    }
  });

  it("does not continue after a failing production build", async () => {
    const { calls, run } = recorder(() => 7);
    const exitCode = await runE2E({ args: [], env: {}, run });

    assert.equal(exitCode, 7);
    assert.deepEqual(calls, [
      { args: ["build"], command: "pnpm", env: undefined },
    ]);
  });

  it("does not start Playwright after a failing browser preflight", async () => {
    for (const args of [[], ["--skip-build"]]) {
      const preflightCall = args.length === 0 ? 2 : 1;
      const { calls, run } = recorder((call) =>
        call === preflightCall ? 9 : 0,
      );
      const exitCode = await runE2E({ args, env: {}, run });

      assert.equal(exitCode, 9);
      assert.equal(calls.length, preflightCall);
      assert.equal(calls.at(-1).command, process.execPath);
      assert.match(
        calls.at(-1).args.join(" "),
        /cookie-root-path[.]test[.]mjs/u,
      );
      assert.match(
        calls.at(-1).args.join(" "),
        /contract-title-bindings[.]test[.]mjs/u,
      );
      assert.equal(calls.some(isPlaywright), false);
    }
  });

  it("exposes the repository-prescribed e2e and test:e2e commands", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );

    // The verify tiers pass --tier and --skip-build through `pnpm e2e`.
    assert.equal(manifest.scripts?.e2e, "node scripts/e2e/run-e2e.mjs");
    assert.equal(
      manifest.scripts?.["test:e2e"],
      "node scripts/e2e/run-e2e.mjs",
    );
  });
});
