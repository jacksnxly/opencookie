# Releasing

How maintainers publish OpenCookie to npm. Contributors don't need this file:
a changeset in your pull request is all a release needs from you.

## 1. Cut the candidate

- [ ] `pnpm verify` passed on `main` at the commit you are about to cut.
- [ ] Run `pnpm version-packages` to apply the pending changesets, review the
  version bumps and changelogs, and commit them. That commit is the
  candidate `C`.
- [ ] Pack every package that changes with `pnpm pack` (never `npm pack`: it
  leaves `workspace:^` specifiers in the manifest) into
  `artifacts/release-<version>-candidate-<C>/`.
- [ ] Write the candidate record `.release/candidate-<C>/candidate-manifest.json`.
  `.release/` is a local folder that git ignores, and it holds exactly one
  `candidate-*` folder at a time. `pnpm verify:candidate` checks the commit,
  tree, lockfile and drop-in fields against the repository
  (`scripts/verify-candidate-manifest-lib.mjs`); the package entries are the
  record you publish from:

  ```json
  {
    "candidate": { "commit": "<C>", "tree": "<git rev-parse C^{tree}>", "frozen": false },
    "toolchain": { "lockfile_sha256": "<sha256 of pnpm-lock.yaml>" },
    "artifacts": {
      "drop_in": {
        "file": "packages/adapters/vanilla/dist/auto.iife.js",
        "sha256": "<sha256 of the built file>",
        "integrity": "<sha384 SRI hash>",
        "gzip_bytes": 0,
        "raw_bytes": 0
      },
      "packages": {
        "<tarball file name>": { "integrity": "<sha512 from pnpm pack>", "bytes": 0, "sha256": "<sha256>" }
      }
    }
  }
  ```
- [ ] Generate the SBOM:
  `node scripts/generate-sbom.mjs artifacts/release-<version>-candidate-<C> .release/candidate-<C>/sbom.spdx.json`.

## 2. Gates on `C`

- [ ] Run the release tier in the pinned Playwright container, the same image
  CI uses, with the candidate record copied into that checkout's `.release/`:
  `node scripts/verify-tier.mjs release --skip cdn-performance`. It must end
  with `VERIFY release PARTIAL` and skip only `cdn-performance`.
- [ ] Run the timing-bound step on a quiet desktop machine:
  `node scripts/verify-tier.mjs release --only cdn-performance`.
- [ ] Review the release diff since the last tag and settle every finding.

## 3. Publish

- [ ] Log in once for this release with a session file outside the
  repository, so neither `~/.npmrc` nor a project `.npmrc` is used:
  `npm login --registry https://registry.npmjs.org/ --userconfig <session file>`.
  Never print, copy or commit that file.
- [ ] For each tarball, in dependency order (core, then vanilla, then the
  other adapters, then `opencookie`):
  `npm publish <tarball> --access public --tag latest --registry https://registry.npmjs.org/ --userconfig <session file>`.
- [ ] Right after the last publish, run `npm logout` with the same
  `--userconfig`, then delete the session file. Every other npm call uses
  `--userconfig /dev/null`.
- [ ] Never publish from a checkout with uncommitted changes, and never
  publish a tarball other than the recorded one.

## 4. Verify what was published

- [ ] Download each tarball back from the registry and confirm it is
  byte-identical to the recorded one. Check that `latest` points at the new
  versions.
- [ ] Install from a fresh cache and confirm the recorded integrities.
- [ ] jsDelivr serves the drop-in with the documented SRI hash.
- [ ] A site made by `npx opencookie@<version> init --yes` works in Chromium,
  Firefox and WebKit: reject keeps optional scripts unrequested, and accept
  loads them.

## 5. Close

- [ ] Tag `C` once per published package (`<package>@<version>`), push the
  tags, and create the GitHub release from the changelogs.
- [ ] Set `candidate.frozen` to `true` and rename the record folder to
  `released-candidate-<C>`. Keep it with the tarballs: it is the only record
  of what was published.
- [ ] Set `RELEASED_SIZES` in `scripts/verify-core-consumer-sizes-lib.mjs` to
  the published sizes.

OpenCookie is a technical tool, not legal advice.
