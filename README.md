# OpenCookie

[![npm](https://img.shields.io/npm/v/@opencookie-dev/vanilla?label=%40opencookie-dev%2Fvanilla)](https://www.npmjs.com/package/@opencookie-dev/vanilla)
[![CI](https://github.com/jacksnxly/opencookie/actions/workflows/ci.yml/badge.svg)](https://github.com/jacksnxly/opencookie/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Open-source cookie consent for first-party websites. OpenCookie is a
self-hosted alternative to Cookiebot and Usercentrics: you install it from npm
or serve one script from your own origin, and no third-party service sits
between your visitors and their choice.

- **Nothing optional runs before consent.** Scripts, iframes and storage
  declared as optional stay inert until the visitor allows them. Withdrawing
  consent blocks them again and deletes the storage they declared.
- **Fail closed.** Missing, unreadable or unconfirmed consent keeps optional
  processing blocked. A choice counts only once it is stored and read back.
- **An honest banner.** Reject is as easy as accept, choices are per category
  and per purpose, and a settings link lets visitors change their mind. Copy
  ships in English and German. The banner uses your site's own type, and
  every part of it can be restyled.
- **Signals.** Google Consent Mode v2 defaults are set before any Google tag
  loads, and Global Privacy Control is honoured.
- **Every tab agrees.** A choice made in one tab is adopted in place by the
  site's other open tabs. A tab reloads only when the new choice blocks
  something that may already have run there.
- **Small.** The drop-in script is about 40 KB gzip, with no network call of
  its own.
- **Proof of consent.** Each decision can produce a receipt that you store,
  query, export and delete.
- **An operator CLI.** `opencookie` scans pages and recordings for what they
  load, helps you classify it, and publishes a versioned policy and cookie
  declaration with rollback.

OpenCookie is a technical tool, not legal advice, a certified consent-management
platform, or a compliance guarantee. You remain responsible for your policy,
lawful basis, jurisdiction analysis, vendor behaviour and retention.

## Quick start

From the root of an existing application:

```sh
npx --yes opencookie@0.4.2 init --yes
```

The initializer detects your framework and package manager, installs the
matching packages, writes a starter policy and wires your entrypoint. It
refuses scaffold shapes it does not recognise instead of guessing. For a plain
HTML site, add `--self-host` to copy the drop-in next to your pages.

Use Node.js `>=22.12.0` for the initializer. The release proof ran under
Node.js `24.19.0` and pnpm `11.22.0`.

The [installation guide](apps/docs/src/content/docs/getting-started/index.mdx)
has the exact commands for every supported stack, and the
[blocking recipe](apps/docs/src/content/docs/recipes/pre-consent-blocking.mdx)
shows how to mark a resource as optional.

## Packages

| Your application | Packages |
| --- | --- |
| Plain HTML or a classic script | `@opencookie-dev/vanilla` |
| React with Vite | `@opencookie-dev/core`, `@opencookie-dev/react`, `@opencookie-dev/vanilla` |
| Vue with Vite | `@opencookie-dev/core`, `@opencookie-dev/vue`, `@opencookie-dev/vanilla` |
| SvelteKit | `@opencookie-dev/core`, `@opencookie-dev/svelte`, `@opencookie-dev/vanilla` |
| Next.js App Router or Pages Router | `@opencookie-dev/core`, `@opencookie-dev/next`, `@opencookie-dev/vanilla` |
| Nuxt | `@opencookie-dev/core`, `@opencookie-dev/nuxt`, `@opencookie-dev/vanilla` |
| Astro | `@opencookie-dev/core`, `@opencookie-dev/astro`, `@opencookie-dev/vanilla` |
| Initializer and operator CLI | `opencookie` |

`@opencookie-dev/core` holds the consent domain and has no runtime
dependencies. The framework packages are thin bindings over it. Each package's
changes are in its `CHANGELOG.md`.

## Status and roadmap

OpenCookie is pre-1.0 and runs in production on a few first-party sites. Next
on the roadmap:

1. A consent-log endpoint in `opencookie serve`, so receipts need no custom code.
2. A scheduled crawler and an open vendor and cookie database that pre-fills
   classifications.
3. More bundled languages and region rules.
4. A WordPress plugin and a Google Tag Manager template.

IAB TCF, mobile SDKs, A/B testing and consent analytics are out of scope for
1.0.

## Contributing

Bug reports, fixes and new integrations are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for the setup and the checks a change has to
pass, and the [code of conduct](CODE_OF_CONDUCT.md). Report security issues
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
