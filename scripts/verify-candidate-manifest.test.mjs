import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCandidateManifest,
  manifestDigest,
  selectCandidateDirectory,
} from "./verify-candidate-manifest-lib.mjs";

const REPO = {
  commitExists: () => true,
  fileDigest: (path) =>
    path === "pnpm-lock.yaml" ? "lock-digest" : "bundle-digest",
  fileExists: () => true,
  treeOf: () => "tree-hash",
};

function manifest(overrides = {}) {
  return {
    artifacts: {
      drop_in: {
        file: "packages/adapters/vanilla/dist/auto.iife.js",
        integrity: "sha384-token",
        sha256: "bundle-digest",
      },
      packages: {},
    },
    candidate: { commit: "abc123", tree: "tree-hash" },
    contract: {
      committed_matches_pin: true,
      file: "RELEASING.md",
      pinned_sha256: "contract-digest",
    },
    toolchain: { lockfile_sha256: "lock-digest" },
    ...overrides,
  };
}

test("accepts a manifest that matches the repository", () => {
  const issues = checkCandidateManifest(manifest(), REPO);
  assert.deepEqual(issues, []);
});

test("rejects a manifest naming a commit the repository does not have", () => {
  const issues = checkCandidateManifest(manifest(), {
    ...REPO,
    commitExists: () => false,
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /commit/iu);
});

test("rejects a tree that is not the one that commit carries", () => {
  const issues = checkCandidateManifest(manifest(), {
    ...REPO,
    treeOf: () => "another-tree",
  });
  assert.match(issues[0], /tree/iu);
});

test("accepts a manifest that does not carry a contract section", () => {
  const { contract, ...withoutContract } = manifest();
  assert.ok(contract);
  const issues = checkCandidateManifest(withoutContract, REPO);
  assert.deepEqual(issues, []);
});

test("rejects a lockfile that changed under the candidate", () => {
  const issues = checkCandidateManifest(manifest(), {
    ...REPO,
    fileDigest: (path) =>
      path === "pnpm-lock.yaml" ? "moved" : "bundle-digest",
  });
  assert.match(issues[0], /lockfile/iu);
});

// An artifact that is present but different is a changed candidate. One that is
// absent cannot be checked, and saying so is not the same as passing.
test("rejects a drop-in whose bytes differ from the manifest", () => {
  const issues = checkCandidateManifest(manifest(), {
    ...REPO,
    fileDigest: (path) => (path === "pnpm-lock.yaml" ? "lock-digest" : "other"),
  });
  assert.match(issues[0], /drop-in|auto\.iife/iu);
});

test("reports an absent artifact as unchecked rather than verified", () => {
  const issues = checkCandidateManifest(manifest(), {
    ...REPO,
    fileExists: (path) =>
      path !== "packages/adapters/vanilla/dist/auto.iife.js",
  });
  assert.equal(issues.length, 0);
});

test("digests a manifest by its exact bytes", () => {
  assert.equal(manifestDigest("{}\n").length, 64);
  assert.notEqual(manifestDigest("{}\n"), manifestDigest("{} \n"));
});

test("one candidate directory is the one that is verified", () => {
  const chosen = selectCandidateDirectory([
    "candidate-abc1234",
    "superseded-candidate-f0c1097e",
    "notes.md",
  ]);

  assert.deepEqual(chosen, { name: "candidate-abc1234", ok: true });
});

test("a repository offering two candidates is refused, not guessed at", () => {
  const chosen = selectCandidateDirectory([
    "candidate-abc1234",
    "candidate-f0c1097e",
  ]);

  assert.equal(chosen.ok, false);
  assert.match(chosen.message, /More than one candidate/u);
  assert.match(chosen.message, /candidate-abc1234, candidate-f0c1097e/u);
});

test("no candidate at all is refused rather than reported as passing", () => {
  const chosen = selectCandidateDirectory(["notes.md"]);

  assert.equal(chosen.ok, false);
  assert.match(chosen.message, /No candidate directory/u);
});
