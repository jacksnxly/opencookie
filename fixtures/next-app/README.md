# Next.js App Router fixture

This is a production-mode OpenCookie fixture for the Next.js App Router. It
uses the workspace `@opencookie-dev/core`, `@opencookie-dev/next`, and
`@opencookie-dev/vanilla` packages rather than fixture-local consent logic.

The fixture was generated with `create-next-app` 16.3.2 on 2026-08-22. The
exact generator command, resolved framework versions, and accessed sources are
recorded in [`.scaffold.json`](./.scaffold.json).

From the repository root:

```sh
pnpm --filter @opencookie-fixtures/next-app build
node --test --test-name-pattern="next-app" scripts/e2e/next-fixtures.test.mjs
```

The production server accepts only the fixture hosts under
`next-app.opencookie.test`. The shared test harness routes those names through
an isolated forward proxy, so local DNS changes are unnecessary.

The fixture demonstrates per-response CSP nonces, SSR-safe hydration,
cross-subdomain cookie storage, client-route resource discovery, withdrawal,
Consent Mode v2 calls, explicit `Sec-GPC` and synthetic GPC profiles, and a
one-second real-time expiry profile.

References:

- [Next.js App Router installation](https://nextjs.org/docs/app/getting-started/installation)
- [Next.js Content Security Policy guide](https://nextjs.org/docs/app/guides/content-security-policy)
- [Next.js custom server guide](https://nextjs.org/docs/pages/guides/custom-server)
