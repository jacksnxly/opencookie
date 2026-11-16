import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// What a public checkout must look like: the files a contributor expects, no
// maintainer-local working state, and package manifests that lead back here.

const root = fileURLToPath(new URL("../", import.meta.url));

// Where the documentation is served. Every link to the docs uses it.
const docsSite = "https://docs.opencookie.dev";

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file !== "" && existsSync(path.join(root, file)));
}

function isText(file) {
  return !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|tgz|gz|zip|pdf)$/iu.test(
    file,
  );
}

test("the community files a contributor looks for are present", () => {
  for (const file of [
    "README.md",
    "LICENSE",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "RELEASING.md",
    "AGENTS.md",
    ".editorconfig",
    ".gitattributes",
    ".github/CODEOWNERS",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/dependabot.yml",
  ]) {
    assert.ok(existsSync(path.join(root, file)), `${file} is missing`);
  }
});

test("CLAUDE.md only points at AGENTS.md, the one agent guide", () => {
  assert.equal(
    readFileSync(path.join(root, "CLAUDE.md"), "utf8"),
    "@AGENTS.md\n",
  );
  const guide = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(
    guide.split("\n").length <= 120,
    "AGENTS.md stays a short guide, not a work log",
  );
});

test("no maintainer-local working state is tracked", () => {
  // Root dot-directories hold local tool state, except these two.
  const shared = new Set([".github", ".changeset"]);
  const local = trackedFiles().filter((file) => {
    const top = file.split("/")[0];
    return file.includes("/") && top.startsWith(".") && !shared.has(top);
  });
  assert.deepEqual(local, []);
});

test("no tracked file names a home directory", () => {
  const offenders = trackedFiles()
    .filter(isText)
    .filter((file) =>
      /(?:^|[\s"'`(=])\/(?:Users|home)\/[A-Za-z][\w.-]*\//u.test(
        readFileSync(path.join(root, file), "utf8"),
      ),
    );
  assert.deepEqual(offenders, []);
});

test("no tracked file cites a decision record that is not published", () => {
  const offenders = trackedFiles()
    .filter(isText)
    .filter((file) => file !== "scripts/repository-hygiene.test.mjs")
    .filter((file) =>
      /\bADR-\d+/u.test(readFileSync(path.join(root, file), "utf8")),
    );
  assert.deepEqual(offenders, []);
});

test("every published package leads back to its source, docs and issues", () => {
  const manifests = trackedFiles().filter((file) =>
    /^packages\/(?:[^/]+\/)*package\.json$/u.test(file),
  );
  const published = manifests
    .map((file) => ({
      file,
      manifest: JSON.parse(readFileSync(path.join(root, file), "utf8")),
    }))
    .filter(({ manifest }) => manifest.private !== true);
  assert.ok(published.length >= 9, "all nine packages are checked");
  for (const { file, manifest } of published) {
    assert.equal(manifest.license, "MIT", `${file} license`);
    assert.equal(manifest.repository?.type, "git", `${file} repository.type`);
    assert.match(
      manifest.repository?.url ?? "",
      /^git\+https:\/\/github\.com\/[\w.-]+\/opencookie\.git$/u,
      `${file} repository.url`,
    );
    assert.equal(
      manifest.repository?.directory,
      path.posix.dirname(file),
      `${file} repository.directory`,
    );
    assert.equal(manifest.homepage, docsSite, `${file} homepage`);
    assert.match(
      manifest.bugs?.url ?? "",
      /^https:\/\/github\.com\/[\w.-]+\/opencookie\/issues$/u,
      `${file} bugs.url`,
    );
  }
});

test("the docs site's canonical address and every link to it agree", () => {
  const astroConfig = readFileSync(
    path.join(root, "apps/docs/astro.config.mjs"),
    "utf8",
  );
  assert.equal(astroConfig.match(/^\s*site: "([^"]+)",$/mu)?.[1], docsSite);
  const contactLinks = readFileSync(
    path.join(root, ".github/ISSUE_TEMPLATE/config.yml"),
    "utf8",
  );
  assert.ok(
    contactLinks.includes(`  - name: Documentation\n    url: ${docsSite}\n`),
    "the issue chooser links to the docs site",
  );
});

test("no accepted advisory names a dependency a published package ships", () => {
  const workspace = readFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "utf8",
  );
  const accepted = [
    ...workspace.matchAll(/^ {4}# (@?[\w./-]+): .*\n {4}- (GHSA-[\w-]+)$/gmu),
  ].map(([, name, id]) => ({ id, name }));
  assert.ok(
    accepted.length > 0,
    "the accepted advisories are listed with their package",
  );
  const shipped = trackedFiles()
    .filter((file) => /^packages\/(?:[^/]+\/)*package\.json$/u.test(file))
    .map((file) => JSON.parse(readFileSync(path.join(root, file), "utf8")))
    .filter((manifest) => manifest.private !== true)
    .flatMap((manifest) =>
      Object.keys(manifest.dependencies ?? {}).map(
        (name) => `${manifest.name} -> ${name}`,
      ),
    );
  for (const { id, name } of accepted) {
    assert.deepEqual(
      shipped.filter((entry) => entry.endsWith(` -> ${name}`)),
      [],
      `${id} (${name})`,
    );
  }
});
