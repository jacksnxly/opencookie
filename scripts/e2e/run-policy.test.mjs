import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";

import { createPlaywrightProjects } from "./project-matrix.mjs";
import { createE2ERunPolicy } from "./run-policy.mjs";

const repositoryRoot = "/workspace/opencookie";

function names(projects) {
  return projects.map(({ name }) => name);
}

describe("Playwright run policy", () => {
  it("disables retries and runs every test of the release matrix once by default", () => {
    const policy = createE2ERunPolicy(repositoryRoot);

    assert.equal(policy.forbidOnly, true);
    assert.equal(policy.fullyParallel, true);
    assert.equal(policy.retries, 0);
    assert.equal(policy.repeatEach, 1);
    assert.equal(policy.projects.length, 48);
    assert.deepEqual(
      names(policy.projects),
      names(createPlaywrightProjects({ tier: "release" })),
    );
    assert.equal(Object.isExtensible(policy), true);
  });

  it("changes nothing but the projects between the change and release tiers", () => {
    const change = createE2ERunPolicy(repositoryRoot, { tier: "change" });
    const release = createE2ERunPolicy(repositoryRoot, { tier: "release" });

    assert.deepEqual(
      names(change.projects),
      names(createPlaywrightProjects({ tier: "change" })),
    );
    assert.equal(change.projects.length, 20);
    assert.deepEqual(
      { ...change, projects: undefined },
      { ...release, projects: undefined },
    );
    assert.throws(
      () => createE2ERunPolicy(repositoryRoot, { tier: "nightly" }),
      /nightly/u,
    );
  });

  it("keeps trace and video for failed runs only, with no CSP bypass", () => {
    const policy = createE2ERunPolicy(repositoryRoot);

    assert.deepEqual(policy.use, {
      bypassCSP: false,
      screenshot: "only-on-failure",
      trace: "retain-on-failure",
      video: "retain-on-failure",
    });
    assert.equal(
      policy.outputDir,
      path.join(repositoryRoot, "artifacts/playwright/test-results"),
    );
    assert.equal(
      policy.snapshotPathTemplate,
      path.join(repositoryRoot, "tests/e2e/snapshots/{arg}-{projectName}{ext}"),
    );
    assert.deepEqual(policy.reporter, [
      [
        "html",
        {
          open: "never",
          outputFolder: path.join(
            repositoryRoot,
            "artifacts/playwright/html-report",
          ),
        },
      ],
      [
        "json",
        {
          outputFile: path.join(
            repositoryRoot,
            "artifacts/playwright/results.json",
          ),
        },
      ],
      [
        "junit",
        {
          outputFile: path.join(
            repositoryRoot,
            "artifacts/playwright/results.xml",
          ),
        },
      ],
    ]);
  });

  it("points only at the shared black-box contract directory", () => {
    const policy = createE2ERunPolicy(repositoryRoot);

    assert.equal(
      policy.testDir,
      path.join(repositoryRoot, "tests/e2e/contracts"),
    );
    assert.equal(policy.testMatch, "**/*.spec.ts");
  });

  it("owns the production fixture environment with graceful shutdown", () => {
    const policy = createE2ERunPolicy(repositoryRoot);

    assert.deepEqual(policy.webServer, {
      command: "node scripts/e2e/serve-fixtures.mjs",
      cwd: repositoryRoot,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      reuseExistingServer: false,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 120_000,
      wait: { stdout: /OpenCookie E2E environment ready/u },
    });
  });
});
