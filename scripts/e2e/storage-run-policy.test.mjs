import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { createStorageE2ERunPolicy } from "./storage-run-policy.mjs";

const repositoryRoot = "/workspace/opencookie";

describe("storage-resilience Playwright run policy", () => {
  it("runs the exact desktop matrix once with zero retries", () => {
    const policy = createStorageE2ERunPolicy(repositoryRoot);

    assert.equal(policy.forbidOnly, true);
    assert.equal(policy.fullyParallel, true);
    assert.equal(policy.repeatEach, 1);
    assert.equal(policy.retries, 0);
    assert.equal(policy.projects.length, 3);
    assert.equal(
      policy.testDir,
      path.join(repositoryRoot, "tests/e2e/storage"),
    );
    assert.equal(policy.testMatch, "**/*.spec.ts");
  });

  it("owns separate complete artifacts and only the two storage fixtures", () => {
    const policy = createStorageE2ERunPolicy(repositoryRoot);
    const artifactRoot = path.join(
      repositoryRoot,
      "artifacts/playwright-storage",
    );

    assert.equal(policy.outputDir, path.join(artifactRoot, "test-results"));
    assert.deepEqual(policy.use, {
      bypassCSP: false,
      screenshot: "on",
      trace: "on",
      video: "on",
    });
    assert.deepEqual(policy.reporter, [
      [
        "html",
        { open: "never", outputFolder: path.join(artifactRoot, "html-report") },
      ],
      ["json", { outputFile: path.join(artifactRoot, "results.json") }],
      ["junit", { outputFile: path.join(artifactRoot, "results.xml") }],
    ]);
    assert.deepEqual(policy.webServer, {
      command: "node scripts/e2e/serve-fixtures.mjs",
      cwd: repositoryRoot,
      env: { OC_E2E_FIXTURES: "plain-cdn,react-vite" },
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      wait: { stdout: /OpenCookie E2E environment ready/u },
    });
  });
});
