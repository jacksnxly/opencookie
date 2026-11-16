import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const RELEASE_CONDITION =
  "if: github.event_name == 'workflow_dispatch' || startsWith(github.ref, 'refs/tags/')";

test("one workflow runs the change tier on pull requests and pushes to main", async () => {
  await assert.rejects(
    access(new URL("../.github/workflows/e2e.yml", import.meta.url)),
    { code: "ENOENT" },
  );
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(workflow, /^ {2}pull_request:$/mu);
  assert.match(workflow, /branches: \[main\]/u);
  assert.match(workflow, /run: pnpm verify$/mu);
  assert.match(workflow, /contents: read/u);
});

test("the release jobs run only on a release tag or by hand", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.equal(workflow.split(RELEASE_CONDITION).length - 1, 2);
  assert.match(workflow, /browser: \[chromium, firefox, webkit\]/u);
  assert.match(
    workflow,
    /pnpm e2e --tier=release --skip-build "--project=\*-\$\{\{ matrix\.browser \}\}-\*"/u,
  );
  assert.match(
    workflow,
    /node scripts\/verify-tier\.mjs release --skip browser --skip cdn-performance --skip candidate/u,
  );
});

test("the incremental mutation cache survives between runs", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(
    workflow,
    /actions\/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6\.1\.0/u,
  );
  assert.match(workflow, /path: reports\/stryker-incremental\.json/u);
});

test("every job runs in the pinned Playwright image with pinned actions", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  assert.match(
    workflow,
    /mcr[.]microsoft[.]com\/playwright:v1[.]62[.]1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e/u,
  );
  assert.match(workflow, /node-version: 24[.]19[.]0/u);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u,
  );
  assert.match(
    workflow,
    /pnpm\/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86/u,
  );
  for (const [, reference] of workflow.matchAll(/uses: [^@\s]+@(\S+)/gu)) {
    assert.match(reference, /^[0-9a-f]{40}$/u, reference);
  }
});

test("every job container runs under an init process that reaps orphans", async () => {
  // GitHub starts job containers with `tail -f /dev/null` as PID 1. Without
  // --init, killed test children stay zombies and still answer kill(pid, 0).
  const workflow = await readFile(workflowUrl, "utf8");
  const containers = workflow.match(/^ {4}container:$/gmu) ?? [];
  const options = workflow.match(/^ {6}options: .*$/gmu) ?? [];
  assert.ok(containers.length >= 3, "the workflow runs its jobs in containers");
  assert.equal(options.length, containers.length);
  for (const line of options) assert.match(line, /(?:^|\s)--init(?:\s|$)/u);
});
