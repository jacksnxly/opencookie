# Package verification

`pnpm verify:packages` proves the release shape of every non-private package without publishing to an external registry. It builds the workspace, creates one npm tarball per public package, runs package metadata and type-resolution checks against those exact tarballs, publishes the same tarballs to a disposable loopback Verdaccio instance, and runs ESM, CommonJS, and plain-script consumers. Verdaccio may read external runtime dependencies from the official npm registry, but neither `@opencookie-dev/*` nor the exact unscoped `opencookie` package is ever proxied.

The verifier deliberately fails when no public packages exist. During package implementation, keep its self-tests green with `pnpm test:scripts`; run the live gate after release package manifests are non-private.

## Pinned tools

All three tools are exact dev dependency pins. Their runtime engine ranges fit the repository's supported Node versions.

| Package                 | Version  | License | Node engine |
| ----------------------- | -------- | ------- | ----------- |
| `publint`               | `0.3.24` | MIT     | `>=18`      |
| `@arethetypeswrong/cli` | `0.18.5` | MIT     | `>=20`      |
| `verdaccio`             | `6.10.0` | MIT     | `>=22`      |

The package metadata above comes from the exact registry records linked below, not an unpinned latest tag.

## Verification sequence

1. Discover every `packages/**/package.json` whose `private` field is not `true`, then sort those packages in internal dependency order.
2. Validate `config/verdaccio.package-verification.json` before building. The configuration must bind to literal `127.0.0.1`, omit authentication, keep `@opencookie-dev/*` and exact `opencookie` names local, use only the official npm uplink for external dependency reads, disable uplink tarball caching, allow anonymous local publication, and use disposable relative storage.
3. Run the workspace build once.
4. Copy each package to a temporary staging directory. In the staged copy only, replace internal `workspace:` dependency ranges with the corresponding release versions and remove any `publishConfig.registry` override.
5. Run `npm pack` with lifecycle scripts disabled. Require exactly one regular `.tgz` file inside the dedicated tarball directory.
6. Run `publint <tarball> --strict` against each exact tarball. Run ATTW with the `node16` profile for dual ESM and CJS packages and the `esm-only` profile for packages that intentionally expose only ESM.
7. Start the locally installed Verdaccio executable on a dynamically reserved `127.0.0.1` port. Publish the exact checked tarballs in dependency order.
8. Install exact package versions into three isolated consumers from that registry. The ESM consumer imports every package that promises an `import` export. The CommonJS consumer requires every package that promises a `require` export. The plain-script consumer evaluates declared browser bundles and requires `@opencookie-dev/vanilla` to create the `OpenCookie` global.

Framework peer packages are never installed implicitly because the consumer uses npm's legacy peer mode. Required external peers must already be installed in the workspace; the scratch consumers link those exact local installations after the OpenCookie packages have been installed from Verdaccio. Regular runtime dependencies, such as `@nuxt/kit`, are fetched through Verdaccio's official npm read-only uplink.

## Safety invariants

- Registry URLs must exactly match `http://127.0.0.1:<port>/`. Hostnames, wildcard binds, credentials, paths, queries, fragments, TLS endpoints, and non-loopback addresses are rejected.
- Every `npm publish` and `npm install` receives the validated registry through command arguments, an isolated user configuration, and its environment. Staged manifests cannot override the registry.
- npm requires a registry-scoped token before it will send a publish request. The verifier generates a random, disposable token scoped only to the ephemeral loopback URL and writes it only to the temporary npm configuration. Verdaccio remains authentication-free and grants local publication through `$all`; the token is never logged or reused.
- `@opencookie-dev/*` and exact `opencookie` have ordered first-match rules with no proxy, so unpublished OpenCookie names cannot fall through to npm. The only uplink is the exact `https://registry.npmjs.org/` URL, used for external dependency reads with tarball caching disabled. Verdaccio has no authentication plugin or persistent storage outside the verifier's temporary directory.
- npm lifecycle scripts, audit calls, funding calls, and provenance publication are disabled.
- Registry shutdown and exact temporary-directory removal run in `finally` paths on both success and failure.
- The verifier does not call `npm login`, `npm adduser`, or any remote publish command.

## Official sources

Accessed 2026-08-22:

- [publint 0.3.24 registry metadata](https://registry.npmjs.org/publint/0.3.24)
- [publint CLI, tarball input, and strict mode](https://publint.dev/docs/cli)
- [@arethetypeswrong/cli 0.18.5 registry metadata](https://registry.npmjs.org/@arethetypeswrong%2fcli/0.18.5)
- [Are the Types Wrong CLI, packed tarballs, pnpm guidance, and profiles](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/packages/cli/README.md)
- [Are the Types Wrong CLI 0.18.5 changelog](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/packages/cli/CHANGELOG.md)
- [Verdaccio 6.10.0 registry metadata](https://registry.npmjs.org/verdaccio/6.10.0)
- [Verdaccio CLI and listen option](https://www.verdaccio.org/docs/cli/)
- [Verdaccio configuration](https://www.verdaccio.org/docs/configuration/)
- [Verdaccio authentication and anonymous access](https://www.verdaccio.org/docs/authentication/)
- [Verdaccio package access, publication, and proxy rules](https://www.verdaccio.org/docs/packages/)
- [Verdaccio uplinks](https://www.verdaccio.org/docs/uplinks/)
- [npm pack](https://docs.npmjs.com/cli/commands/npm-pack/)
- [npm publish](https://docs.npmjs.com/cli/commands/npm-publish/)
- [npm install](https://docs.npmjs.com/cli/commands/npm-install/)
