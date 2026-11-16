import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runStorageE2E } from "./run-storage-e2e.mjs";

const BUILD_COMMANDS = [
  ["pnpm", ["--filter", "@opencookie-dev/core", "build"]],
  ["pnpm", ["--filter", "@opencookie-dev/vanilla", "build"]],
  ["pnpm", ["--filter", "@opencookie-dev/react", "build"]],
  ["pnpm", ["--filter", "@opencookie-fixtures/plain-cdn", "build"]],
  ["pnpm", ["--filter", "@opencookie-fixtures/react-vite", "build"]],
];

describe("storage-resilience E2E command orchestrator", () => {
  it("builds the five required targets serially before the standalone suite", async () => {
    const calls = [];
    const exitCode = await runStorageE2E({
      run: (command, args) => {
        calls.push([command, args]);
        return Promise.resolve(0);
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls.slice(0, 5), BUILD_COMMANDS);
    assert.deepEqual(calls[5], [
      "pnpm",
      ["exec", "playwright", "test", "--config=playwright.storage.config.ts"],
    ]);
    assert.equal(calls[6][0], process.execPath);
    assert.match(calls[6][1].join(" "), /verify-storage-results[.]mjs/u);
    assert.equal(calls[6][1].length, 1);
  });

  it("stops immediately when a serial build fails", async () => {
    const calls = [];
    const exitCode = await runStorageE2E({
      run: (command, args) => {
        calls.push([command, args]);
        return Promise.resolve(calls.length === 3 ? 17 : 0);
      },
    });

    assert.equal(exitCode, 17);
    assert.deepEqual(calls, BUILD_COMMANDS.slice(0, 3));
  });

  it("rejects attempts to override repeat or retry accounting", async () => {
    await assert.rejects(
      runStorageE2E({ args: ["--repeat-each=2"], run: async () => 0 }),
      /repeatEach=1/u,
    );
    await assert.rejects(
      runStorageE2E({ args: ["--retries=1"], run: async () => 0 }),
      /retries=0/u,
    );
    await assert.rejects(
      runStorageE2E({
        args: ["--project=storage-chromium"],
        run: async () => 0,
      }),
      /all three storage projects/u,
    );
    await assert.rejects(
      runStorageE2E({ args: ["--reporter=line"], run: async () => 0 }),
      /accepts no Playwright arguments/u,
    );
  });
});
