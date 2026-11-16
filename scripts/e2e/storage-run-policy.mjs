import path from "node:path";

import { createStoragePlaywrightProjects } from "./storage-project-matrix.mjs";

/** Produces the deterministic, zero-retry storage-resilience configuration. */
export function createStorageE2ERunPolicy(repositoryRoot) {
  const artifactRoot = path.join(
    repositoryRoot,
    "artifacts/playwright-storage",
  );
  return {
    forbidOnly: true,
    fullyParallel: true,
    outputDir: path.join(artifactRoot, "test-results"),
    projects: createStoragePlaywrightProjects(),
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
      "tests/e2e/storage/snapshots/{arg}-{projectName}{ext}",
    ),
    testDir: path.join(repositoryRoot, "tests/e2e/storage"),
    testMatch: "**/*.spec.ts",
    use: Object.freeze({
      bypassCSP: false,
      screenshot: "on",
      trace: "on",
      video: "on",
    }),
    webServer: Object.freeze({
      command: "node scripts/e2e/serve-fixtures.mjs",
      cwd: repositoryRoot,
      env: Object.freeze({
        OC_E2E_FIXTURES: "plain-cdn,react-vite",
      }),
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
