# opencookie

`opencookie` is the initializer for OpenCookie. Run it from an application
root:

```sh
npx opencookie init
```

For unattended local automation or CI fixture setup:

```sh
npx opencookie init --yes
```

For a plain HTML site that must make no CDN request at runtime:

```sh
npx opencookie init --yes --self-host
```

The initializer detects the package manager and framework. Framework projects
receive the matching adapter, `opencookie.config.ts`, a starter policy
catalogue, and an integration wired into the application entrypoint. Plain HTML
projects use a pinned, deferred CDN bootstrap by default and require no project
package installation. With `--self-host`, the initializer copies the exact
installed `@opencookie-dev/vanilla` browser bundle to
`vendor/opencookie/auto.iife.js`, computes its SHA-384 integrity token from the
copied bytes, and wires only same-origin runtime assets.

## Supported projects

| Project              | Detection evidence                                         | Adapter                                                 |
| -------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Plain HTML           | `index.html` with no supported framework manifest signal   | `@opencookie-dev/vanilla` CDN or same-origin IIFE build |
| React with Vite      | Direct `react` and `vite` dependency declarations          | `@opencookie-dev/react`                                 |
| Vue with Vite        | Direct `vue` and `vite` dependency declarations            | `@opencookie-dev/vue`                                   |
| Next.js App Router   | `next` plus an `app/page.*` entrypoint                     | `@opencookie-dev/next`                                  |
| Next.js Pages Router | `next` plus a `pages/index.*` or `pages/_app.*` entrypoint | `@opencookie-dev/next`                                  |
| Nuxt                 | A Nuxt 4 dependency declaration                            | `@opencookie-dev/nuxt`                                  |
| SvelteKit            | An `@sveltejs/kit` dependency declaration                  | `@opencookie-dev/svelte`                                |
| Astro                | An `astro` dependency declaration                          | `@opencookie-dev/astro` plus `@opencookie-dev/vanilla`  |

Next.js `src/app` and `src/pages` layouts are supported. A project with both
router entrypoints is refused because guessing which root to edit would be
unsafe. Nuxt 4 is accepted, and the generated store is registered as
`~~/opencookie-store`, the project root. Nuxt 3 reached upstream end of life on
2026-07-31 and is refused.

## Safety and idempotence

OpenCookie preflights every generated path before installing a dependency or
writing a file. If any target file exists with different content, initialization
stops and lists the conflicts. Existing files are never silently overwritten.
New files use exclusive creation. Existing entrypoints use a compare-and-swap
replacement guarded by the exact content observed during planning, a temporary
file, and an exclusive operation lock. One project-wide lock covers detection,
installation, and writes so concurrent initializers cannot both run a package
manager. Real-path checks reject reads and writes through symlinks that leave
the project root. A completed second run performs no installation and writes
nothing.

Package manager selection uses `packageManager` when declared and consistent
with an observed lockfile. Without that declaration, exactly one lockfile is
accepted. Multiple package-manager lockfiles are treated as ambiguous. With no
signal, npm is the reversible default.

OpenCookie only transforms scaffold shapes it can recognize exactly. It adds a
marker-delimited import and provider, plugin, module, or script reference to the
framework entrypoint. Unsupported custom renderers, ambiguous files, existing
unmarked module or integration arrays, and incomplete markers are refused before
installation. Candidate JavaScript, JSX, TypeScript, and TSX files are parsed
before matching, so examples inside comments, strings, templates, regular
expressions, and JSX text are never treated as executable scaffold code.
Generated policy content is a starter only. Every initializer path places the
Analytics purpose under a real `optional` presentation root. Framework projects
write that category into `opencookie.policy.ts`; the compact classic-script
product constructs the same single-purpose category from its captured
configuration. The visible interface starts as a fixed bottom bar with equally
weighted Reject all, Accept all, and Settings controls. Settings opens a
separate modal panel where the `optional` category choice selects Analytics
through the domain policy. Replace the starter with the categories, services,
purposes, resources, and disclosures the site actually uses.

Framework packages are headless bindings, so the generated integration also
mounts `@opencookie-dev/vanilla`. This ensures `init` produces a visible preference
banner instead of only installing a context provider.

The plain HTML script contains the bootstrap configuration it actually consumes:
`data-oc-policy-version`, `data-oc-storage-key`, `data-oc-purpose-id`,
`data-oc-purpose-label`, and `data-oc-purpose-description`. Edit the attributes
in `index.html` and `.opencookie/snippet.html` together. The classic script also
accepts a standard `nonce` attribute when the site enforces a nonce-based CSP.
The auto bootstrap currently supports one purpose and does not generate a
separate TypeScript configuration that the browser would ignore. Its
`optional` presentation root is part of the compact product rather than an
editable script attribute. Use the programmatic API for a different category
graph.

Generic programmatic policies remain backwards compatible with an empty
`presentationRootCategoryIds` list. That shape renders all purposes in one flat
section without a category choice. When roots are present, a valid purpose
outside the visited category graph remains available in a trailing ungrouped
section.

Both plain HTML modes also create `opencookie-demo.js` and mark it as an inert
Analytics resource. This makes the starter's pre-consent blocking observable:
the browser cannot request or execute that file until Analytics is granted. The
demo resource is only a starter. Remove it or replace it with the site's actual
optional resources when the policy is customised.

`--self-host` is deliberately limited to plain HTML projects. It does not fetch
the bundle from a URL or trust a copied digest. The ESM executable resolves the
installed vanilla package, reads the adjacent IIFE bytes, verifies that they
round-trip as UTF-8, and computes the integrity attribute from those same bytes.
The default CDN path remains available for sites that prefer version-pinned CDN
delivery.

The programmatic API accepts filesystem, compare-and-swap replacement, command,
confirmation, and output ports. Unit tests use only in-memory ports and never
modify real fixture applications or invoke a package manager.

## Official references

Accessed 2026-08-27:

- [npm `package.json`, including executable `bin` files](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin)
- [Node.js package entry points and module formats](https://nodejs.org/api/packages.html)
- [Node.js `import.meta.resolve`](https://nodejs.org/api/esm.html#importmetaresolvespecifier)
- [W3C Subresource Integrity](https://www.w3.org/TR/SRI/)
- [pnpm add](https://pnpm.io/cli/add)
- [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/)
- [Yarn add](https://yarnpkg.com/cli/add)
- [Bun add](https://bun.com/docs/pm/cli/add)
- [Vite templates for plain HTML, React, and Vue](https://vite.dev/guide/)
- [Next.js App Router](https://nextjs.org/docs/app)
- [Next.js Pages Router](https://nextjs.org/docs/pages)
- [Next.js project structure and optional `src` folder](https://nextjs.org/docs/pages/getting-started/project-structure)
- [Nuxt 3 configuration and project files](https://nuxt.com/docs/3.x/directory-structure/nuxt-config)
- [SvelteKit project structure](https://svelte.dev/docs/kit/project-structure)
- [Astro project structure](https://docs.astro.build/en/basics/project-structure/)
- [Oxc parser guide](https://oxc.rs/docs/guide/usage/parser.html)

OpenCookie is a technical tool, not legal advice. It does not guarantee that a
site, policy, consent flow, or deployment complies with any law or regulation.
