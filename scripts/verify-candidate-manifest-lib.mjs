import { createHash } from "node:crypto";

/** The digest of a manifest is the digest of its exact bytes, not of a reparse. */
export function manifestDigest(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Checks a candidate manifest against the repository it claims to describe.
 *
 * It answers one question: is this still the same candidate? Anything it cannot
 * see, such as an artifact that has not been built here, is left unchecked and
 * said so elsewhere; silence is never reported as agreement.
 */
export function checkCandidateManifest(manifest, repository) {
  const issues = [];
  const commit = manifest?.candidate?.commit;
  const tree = manifest?.candidate?.tree;

  if (typeof commit !== "string" || !repository.commitExists(commit)) {
    issues.push(
      `The manifest names commit ${String(commit)}, which this repository does not have.`,
    );
    return issues;
  }
  if (repository.treeOf(commit) !== tree) {
    issues.push(
      `The manifest records tree ${String(tree)}, but commit ${commit} carries ${repository.treeOf(commit)}.`,
    );
  }

  const lockfile = manifest?.toolchain?.lockfile_sha256;
  if (repository.fileDigest("pnpm-lock.yaml") !== lockfile) {
    issues.push("The lockfile has changed since the manifest was written.");
  }

  const dropIn = manifest?.artifacts?.drop_in;
  if (dropIn !== undefined && repository.fileExists(dropIn.file)) {
    if (repository.fileDigest(dropIn.file) !== dropIn.sha256) {
      issues.push(
        `The drop-in at ${dropIn.file} no longer matches the manifest, so this is a different candidate.`,
      );
    }
  }

  return issues;
}

/**
 * Chooses the one candidate a repository is offering.
 *
 * Sorting directory names and taking the last one reads as "the newest" but a
 * commit hash carries no order, so it was only ever luck. A repository that is
 * offering two candidates has not decided which one it means, and saying so is
 * the only answer that cannot be wrong.
 */
export function selectCandidateDirectory(names) {
  const candidates = [...names].filter((name) => name.startsWith("candidate-"));
  if (candidates.length === 0) {
    return {
      message: "No candidate directory was found under .release.",
      ok: false,
    };
  }
  if (candidates.length > 1) {
    return {
      message: `More than one candidate is offered: ${[...candidates].sort().join(", ")}. A candidate is one commit, so move the superseded ones aside before verifying.`,
      ok: false,
    };
  }
  return { name: candidates[0], ok: true };
}
