# Contributing to OpenCookie

Thanks for helping. This guide covers the setup, the checks every change must
pass, and how a pull request gets merged. By taking part you agree to follow
the [code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs:** open an issue with the bug template. A page or a few lines that
  reproduce it are the most useful thing you can give.
- **Features and new integrations:** open an issue first, so we can agree on
  the shape before you write code.
- **Security issues:** never in a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js `24.19.0` (see `.node-version`) and pnpm `11.22.0`, the
version pinned in `package.json`.

```sh
git clone https://github.com/jacksnxly/opencookie.git
cd opencookie
pnpm install
pnpm verify:fast
```

`pnpm verify:fast` runs types, lint, formatting, code generation, a package
build and the unit tests in a few minutes. Run it before every push.

## Repository layout

| Path | What it holds |
| --- | --- |
| `packages/core` | The consent domain, its application services and browser infrastructure. No runtime dependencies. |
| `packages/adapters/*` | `vanilla` (the banner, drop-in script and browser runtime) and the thin React, Vue, Svelte, Next.js, Nuxt and Astro bindings. |
| `packages/cli` | The `opencookie` initializer and operator CLI. |
| `apps/docs` | The documentation site (Astro Starlight). Every code sample in it is type-checked and executed. |
| `fixtures/*` | One real application per supported stack, used by the browser tests. |
| `tests/e2e` | Playwright contract tests that run against every fixture. |
| `scripts` | Build, verification and release tooling, with its own tests. |
| `docs` | Domain model, research and tooling notes. |

## How a change is made

1. **Write the failing test first.** A behaviour change starts with a test that
   fails for the reason the change fixes. Unit tests use Vitest; browser
   behaviour is proved in `tests/e2e`.
2. **Make it pass** with the smallest change that does.
3. **Run the checks.** `pnpm verify:fast` locally. Vitest does not type-check,
   so run `pnpm typecheck` too after editing a test.
4. **Add a changeset** for anything a user of a published package would notice:
   `pnpm changeset`. Pick the packages and the semver level, and describe the
   change from the user's side.
5. **Open a pull request.** CI runs the merge gate, `pnpm verify`, in the
   pinned Playwright container.

### The merge gate

`pnpm verify` adds domain coverage, incremental mutation testing, architecture
and public-API contracts, size budgets, package checks, Subresource Integrity,
packed installs of every stack, and a browser matrix across Chromium, Firefox
and WebKit. It needs Linux browsers and takes a while, so CI runs it on every
pull request. To run part of the browser matrix locally:

```sh
pnpm e2e --tier=change --project=plain-cdn-chromium-desktop
```

### Rules that keep OpenCookie trustworthy

- **Fail closed.** Missing, unknown, failed or uncertain consent state keeps
  optional processing blocked, and nothing looks saved before it is.
- **Nothing optional before consent, and reject as easy as accept.**
- **Dependencies point inward:** domain, then application, then
  infrastructure, then framework adapters. `@opencookie-dev/core` keeps zero
  runtime dependencies, and adapters never duplicate domain decisions.
  `pnpm verify:arch` enforces this.
- **Public APIs are explicit.** A change to an exported type updates the API
  report with `pnpm api:update`, and the reviewer reads that diff.
- **Thresholds only go up.** Coverage, mutation score, size budgets and the
  browser matrix (zero failed, flaky or skipped runs) are never lowered to make
  a change pass. Fix the code instead.
- **No legal claims.** Documentation says what OpenCookie does, never that it
  makes a site compliant.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `fix(vanilla): keep the bar closed after a stored rejection`.
- Keep each commit focused. A pull request should do one thing.
- Fill in the pull request template, including how you tested the change.
- A maintainer reviews every pull request. Once CI is green and the review
  is settled, a maintainer merges it.

## Documentation

The docs site lives in `apps/docs`. `pnpm --filter @opencookie-dev/docs verify`
type-checks and runs every displayed sample, builds the site and checks its
links. Prettier formats only JavaScript, TypeScript, JSON and YAML, so format
Markdown and MDX by hand.

## Releases

Maintainers cut releases as described in [RELEASING.md](RELEASING.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
