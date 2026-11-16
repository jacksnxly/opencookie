# Agent guide

Instructions for coding agents working in this repository. Humans should read
[CONTRIBUTING.md](CONTRIBUTING.md); everything there applies to agents too.

## What this is

OpenCookie is an MIT-licensed, self-hosted consent-management toolkit for
first-party websites. It is a pnpm monorepo: `packages/core` (the consent
domain), `packages/adapters/*` (the vanilla runtime and banner, plus thin
framework bindings), `packages/cli` (the `opencookie` initializer and operator
CLI), `apps/docs` (the documentation site), `fixtures/*` (one real app per
stack) and `tests/e2e` (Playwright contracts).

## Commands

| Command | When |
| --- | --- |
| `pnpm install` | once, with Node.js 24.19.0 and pnpm 11.22.0 |
| `pnpm verify:fast` | after every change: types, lint, format, codegen, build, unit tests |
| `pnpm typecheck` | after editing tests; Vitest does not type-check |
| `pnpm test -- <path>` | one unit test file |
| `pnpm e2e --tier=change --project=plain-cdn-chromium-desktop` | one browser project |
| `pnpm api:update` | after changing an exported type; commit the report diff |
| `pnpm changeset` | for any change a package user would notice |
| `pnpm verify` | the merge gate; CI runs it in the pinned Playwright container |

## How to work

- Write a failing test first, and confirm it fails for the reason you expect.
  Then make it pass with the smallest change.
- Keep each commit to one step and use Conventional Commits
  (`fix(core): …`, `feat(vanilla): …`, `test: …`, `docs: …`).
- Prettier formats only JavaScript, TypeScript, JSON and YAML. Never run it
  on Markdown or MDX: it breaks the docs build.
- Preserve unrelated changes in the working tree.

## Product rules

These are the contract the tests enforce. Do not weaken them.

- **Fail closed.** Missing, unknown, failed or uncertain consent state keeps
  optional processing blocked. Nothing looks saved, active or recorded before
  it is: a grant counts only after the stored record is read back.
- **Nothing optional before consent**, blocked again on withdrawal, and
  rejecting is as easy as accepting.
- **Privacy signals only restrict.** Global Privacy Control or a declared
  exception can never create consent.
- **No legal claims.** OpenCookie is a technical tool, not legal advice.
  Documentation never promises compliance.

## Architecture rules

- Dependencies point inward: domain, then application, then infrastructure,
  then framework adapters. `pnpm verify:arch` enforces it.
- `@opencookie-dev/core` has zero runtime dependencies.
- Framework adapters are thin bindings. They never duplicate a domain
  decision.
- Public APIs are explicit, typed and tree-shakeable, and every change to them
  shows up in the API report.
- Coverage, mutation score, size budgets and the browser matrix (zero failed,
  flaky or skipped runs) never go down to make a change pass. Fix the code.

## Safety

- Never publish to npm, push tags, create releases, change CI secrets or
  deploy. Maintainers do that, as described in [RELEASING.md](RELEASING.md).
- Never commit credentials, `.npmrc` files or `.env` files.
- Never add code under a license incompatible with MIT, and record the source
  of anything you port.
