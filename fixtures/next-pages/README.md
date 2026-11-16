# Next.js Pages Router fixture

This is a production-mode OpenCookie fixture for the Next.js Pages Router. It
uses the workspace `@opencookie-dev/core`, `@opencookie-dev/next`, and
`@opencookie-dev/vanilla` packages rather than fixture-local consent logic.

The fixture was generated with `create-next-app` 16.3.2 on 2026-08-22. The
exact generator command, resolved framework versions, and accessed sources are
recorded in [`.scaffold.json`](./.scaffold.json).

From the repository root:

```sh
pnpm --filter @opencookie-fixtures/next-pages build
node --test --test-name-pattern="next-pages" scripts/e2e/next-fixtures.test.mjs
```

The production server accepts only the fixture hosts under
`next-pages.opencookie.test`. The shared test harness routes those names through
an isolated forward proxy, so local DNS changes are unnecessary.

The fixture demonstrates per-response CSP nonces, SSR-safe hydration,
cross-subdomain cookie storage, client-route resource discovery, withdrawal,
Consent Mode v2 calls, explicit `Sec-GPC` and synthetic GPC profiles, and a
one-second real-time expiry profile. Browser runtime configuration stays tied
to the original document nonce and privacy profile across Pages Router data
requests.

References:

- [Next.js Pages Router installation](https://nextjs.org/docs/pages/getting-started/installation)
- [Next.js Content Security Policy guide](https://nextjs.org/docs/app/guides/content-security-policy)
- [Next.js custom server guide](https://nextjs.org/docs/pages/guides/custom-server)
