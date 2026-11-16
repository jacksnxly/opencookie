import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const minimumPatchedVersions = new Map([
  ["cookie", "0.7.0"],
  ["fast-uri", "3.1.9"],
  ["qs", "6.16.2"],
  ["srvx", "0.11.13"],
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

test("the lockfile excludes the audited vulnerable transitive versions", async () => {
  const lockfile = await readFile(
    new URL("../pnpm-lock.yaml", import.meta.url),
    "utf8",
  );
  const packagesStart = lockfile.indexOf("\npackages:\n");
  const snapshotsStart = lockfile.indexOf("\nsnapshots:\n");
  assert.ok(packagesStart >= 0, "lockfile packages section must exist");
  assert.ok(
    snapshotsStart > packagesStart,
    "lockfile snapshots must follow packages",
  );
  const packageResolutions = lockfile.slice(packagesStart, snapshotsStart);
  const violations = [];

  for (const [packageName, minimumVersion] of minimumPatchedVersions) {
    const pattern = new RegExp(
      `^  ${escapeRegExp(packageName)}@(\\d+\\.\\d+\\.\\d+):`,
      "gmu",
    );
    const versions = [...packageResolutions.matchAll(pattern)].map(
      (match) => match[1],
    );
    assert.ok(versions.length > 0, `${packageName} must remain audited`);
    for (const version of versions) {
      if (compareVersions(version, minimumVersion) < 0) {
        violations.push(
          `${packageName}@${version} is below patched version ${minimumVersion}`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "lockfile contains package resolutions below their audited patched floors",
  );
});
