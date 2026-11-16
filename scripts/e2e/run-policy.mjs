import path from "node:path";

import { createPlaywrightProjects } from "./project-matrix.mjs";

/**
 * Produces the deterministic, zero-retry G6 Playwright configuration of one
 * tier. Every test runs once; a run keeps its trace and video only when it
 * fails.
 */
export function createE2ERunPolicy(repositoryRoot, { tier = "release" } = {}) {
  const artifactRoot = path.join(repositoryRoot, "artifacts/playwright");
  return {
    forbidOnly: true,
    fullyParallel: true,
    outputDir: path.join(artifactRoot, "test-results"),
    projects: createPlaywrightProjects({ tier }),
    repeatEach: 1,
    reporter: Object.freeze([
      Object.freeze([
        "html",
        Object.freeze({
          open: "never",
          outputFolder: path.join(artifactRoot, "html-report"),
        }),
      ]),
      Object.freeze([
        "json",
        Object.freeze({
          outputFile: path.join(artifactRoot, "results.json"),
        }),
      ]),
      Object.freeze([
        "junit",
        Object.freeze({
          outputFile: path.join(artifactRoot, "results.xml"),
        }),
      ]),
    ]),
    retries: 0,
    snapshotPathTemplate: path.join(
      repositoryRoot,
      "tests/e2e/snapshots/{arg}-{projectName}{ext}",
    ),
    testDir: path.join(repositoryRoot, "tests/e2e/contracts"),
    testMatch: "**/*.spec.ts",
    use: Object.freeze({
      bypassCSP: false,
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      video: "retain-on-failure",
    }),
    webServer: Object.freeze({
      command: "node scripts/e2e/serve-fixtures.mjs",
      cwd: repositoryRoot,
      gracefulShutdown: Object.freeze({ signal: "SIGTERM", timeout: 5_000 }),
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      wait: Object.freeze({
        stdout: /OpenCookie E2E environment ready/u,
      }),
    }),
  };
}
