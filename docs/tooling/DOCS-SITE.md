# Documentation site tooling

Accessed 2026-08-22.

## Versions

- Astro `7.2.4` is the current npm `latest` release, verified through the [official npm registry metadata](https://registry.npmjs.org/astro/7.2.4).
- `@astrojs/starlight` `0.41.7` is the current npm `latest` release, verified through the [official npm registry metadata](https://registry.npmjs.org/@astrojs%2fstarlight/0.41.7).
- The site uses the exact versions above. It does not use a floating range.

## Primary implementation sources

- [Starlight manual setup](https://starlight.astro.build/manual-setup/) documents the integration, `docsLoader`, `docsSchema`, and file-routed content structure.
- [Starlight configuration reference](https://starlight.astro.build/reference/configuration/) documents the title, description, sidebar, custom CSS, logo, head, and credit options used by the site.
- [Starlight CSS and styling guide](https://starlight.astro.build/guides/css-and-tailwind/) documents custom CSS and theme token overrides.
- [Starlight customization guide](https://starlight.astro.build/guides/customization/) documents component and visual customization while retaining Starlight navigation.
- [Starlight sidebar guide](https://starlight.astro.build/guides/sidebar/) documents explicit sidebar groups and internal slugs.
- [Astro content collections](https://docs.astro.build/en/guides/content-collections/) documents build-time content loaders and schema validation.
- [Astro CLI reference](https://docs.astro.build/en/reference/cli-reference/#astro-check) documents the `astro check` validation used before every build.
- [Nuxt 3 guide](https://nuxt.com/docs/3.x/guide) states that Nuxt 3 reached end of life on 31 July 2026 and no longer receives bug fixes or security patches. The quick start repeats this upstream caveat.
- [Google Consent Mode overview](https://developers.google.com/tag-platform/security/concepts/consent-mode) distinguishes Basic mode, where tags remain blocked until interaction, from Advanced mode, where tags load and may send cookieless measurements under denied defaults.

## Deterministic documentation contract

Every displayed code example is referenced with `RunnableSample`. Its source lives in `apps/docs/samples`, declares a realistic `docs:consumer-path`, and exports `run()`. The verifier rejects unsupported code renderers, extracts only the user-visible region into a clean consumer tree, typechecks that extracted module independently, typechecks the complete harness, executes every sample, and rejects unreferenced sample files. HTML markup is extracted at its consumer path and exercised by its DOM harness.

The API index is generated from the committed API Extractor snapshots by `scripts/verify-docs-generate-api.mjs`. A stale generated page fails verification.

After the static build, `scripts/verify-docs.mjs` crawls built `href` and `src` attributes. Missing local routes, assets, or fragments fail the gate. External links are preserved but are not fetched during the local build.

The playground uses browser-local state and makes no external request. The repository includes no deploy or DNS operation.

## Lockfile scope

`apps/docs/pnpm-lock.yaml` exists for isolated clean-room verification with `pnpm --ignore-workspace --dir apps/docs install --frozen-lockfile`. Inside the full monorepo, pnpm ignores that nested lock and the workspace root `pnpm-lock.yaml` remains authoritative. Any integration that adds this app must regenerate the root lockfile so it contains the `apps/docs` importer.
