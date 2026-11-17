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
    /mcr[.]microsoft[.]com\/playwright:v\d+[.]\d+[.]\d+-noble@sha256:[0-9a-f]{64}/u,
  );
  assert.match(workflow, /node-version: 24[.]19[.]0/u);
  // Dependabot moves the pins; the test only requires that they are pins.
  const actions = [...workflow.matchAll(/uses: ([^@\s]+)@(\S+)/gu)];
  const names = new Set(actions.map(([, name]) => name));
  assert.ok(names.has("actions/checkout"), "checks out with actions/checkout");
  assert.ok(names.has("pnpm/action-setup"), "installs pnpm with its action");
  for (const [, name, reference] of actions) {
    assert.match(reference, /^[0-9a-f]{40}$/u, `${name}@${reference}`);
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

test("pull requests fail on a vulnerable dependency they add", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const job = /^ {2}dependency-review:\n((?: {4}.*\n|\n)*)/mu.exec(
    workflow,
  )?.[1];
  assert.ok(job, "ci.yml has a dependency-review job");
  assert.match(job, /^ {4}if: github\.event_name == 'pull_request'$/mu);
  assert.match(
    job,
    /uses: actions\/dependency-review-action@[0-9a-f]{40} # v5[.]/u,
  );
  // The default fails on every severity; nothing may lower or mute that.
  assert.doesNotMatch(job, /fail-on-severity|warn-only|vulnerability-check/u);
  // It skips exactly the advisories pnpm-workspace.yaml accepts, with reasons.
  const workspace = await readFile(
    new URL("../pnpm-workspace.yaml", import.meta.url),
    "utf8",
  );
  const accepted = [...workspace.matchAll(/^ {4}- (GHSA-[\w-]+)$/gmu)]
    .map(([, id]) => id)
    .sort();
  const allowed = (/^ {10}allow-ghsas: (.*)$/mu.exec(job)?.[1] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(allowed, accepted);
});

test("CI runs the browsers of the Playwright version the workspace installs", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const version = manifest.devDependencies["@playwright/test"];
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  const image = new RegExp(
    `^ {6}image: mcr[.]microsoft[.]com/playwright:v${version.replaceAll(".", "[.]")}-noble@sha256:[0-9a-f]{64}$`,
    "u",
  );
  const images = workflow.match(/^ {6}image: .*$/gmu) ?? [];
  assert.ok(images.length >= 3, "every job names its container image");
  for (const line of images) assert.match(line, image);
  const catalogue = await readFile(
    new URL("e2e/dx-catalogue.mjs", import.meta.url),
    "utf8",
  );
  const pins = [...catalogue.matchAll(/"@playwright\/test@([^"]+)"/gu)];
  assert.ok(pins.length > 0, "the DX catalogue installs @playwright/test");
  for (const [, pin] of pins) assert.equal(pin, version);
});
