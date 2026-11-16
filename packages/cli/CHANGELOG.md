# opencookie

## 0.4.1

### Patch Changes

- Accept Next.js 15 as a peer of `@opencookie-dev/next`; every `pnpm verify` runs a fresh Next.js 15.5.9 App Router app beside both routers on 16.3.2.

  When `opencookie init` cannot install its packages, the error names every file init still has to create, including the record, and says to run init again.

  A generated starter policy or resource policy names each issue's code and path when it is invalid.

  The browser binding's mount accepts banner links and the launcher option, and refuses a link that could run script before anything mounts.

  The banner's choices come before its links in the DOM.

  The save-failure notice is drawn as a card.

  `googleConsentMode.command` is required, the default tokens live on `:where(.oc-root)`, and a presented category without a label shows its id.

  The soft and minimal templates give the banner links their own row below the choices under 52.5rem.

- Updated dependencies [1a221ff]
- Updated dependencies [e087b88]
- Updated dependencies [48793ab]
  - @opencookie-dev/vanilla@0.4.0
  - @opencookie-dev/core@0.2.4

## 0.4.0

### Minor Changes

- Playwright recordings, browser names, and `init` on an existing Next.js layout.

  - `findings session` and `findings check` read a later navigation in the same
    tab as a page, not as an embedded frame. Playwright records one page per
    tab, so every later navigation used to be imported as an `iframe` finding.
    This changes what such a recording imports.
  - `--browser` takes the browser's name with or without its version, so
    `--browser chromium` is accepted for a recording made in Chromium.
  - A recording with malformed request headers is still scanned.
  - `init` on a Next.js App Router layout it cannot rewrite says what to add by
    hand, and accepts the layout once `<OpenCookieRoot>` wraps the page inside
    `<body>`.
  - New projects are scaffolded with `@opencookie-dev/vanilla` 0.3.0 and its new
    default look.

### Patch Changes

- Updated dependencies
  - @opencookie-dev/vanilla@0.3.0

## 0.3.1

### Patch Changes

- Findings that match what a site really sends, and a doctor that agrees with the check.

  - `findings session --same-origin` imports a site's own requests too, so an
    analytics vendor's events through a first-party relay can be decided, and
    `findings check` fails when a relay decided as optional loads in a rejected
    recording. A site's own undecided requests never fail the check.
  - An import reports what is new and what is still unclassified, instead of the
    inventory's size.
  - The inventory keeps addresses without their query string or fragment, which
    can carry tokens. Existing inventories match as before.
  - A Playwright recording's later page loads are pages, not frames.
  - `doctor` counts a finding a decision already covers as classified, as
    `findings check` does, and finds a policy installed with `--out`, as JSON or
    as a module.

- Updated dependencies
  - @opencookie-dev/vanilla@0.2.5

## 0.3.0

### Minor Changes

- A stricter release check, and publications that keep what they carry.

  - **Breaking:** `findings check` now also exits non-zero when a recording holds
    a resource with no decision. Classify each one, necessary or optional, before
    using the check as a release gate.
  - `findings session` and `findings check` skip a cookie entry whose name is not
    an RFC 6265 cookie name and say so, such as the fragment WebKit's recorder
    makes by splitting a `Set-Cookie` header at the comma in its date.
  - `policy rollback` restores the plain-language terms and lawful bases the
    restored publication carried. Roll back again to repair an earlier rollback.
  - `policy publish` keeps the authored category order and accepts a reordering
    of the live policy under its version.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @opencookie-dev/core@0.2.3
  - @opencookie-dev/vanilla@0.2.4

## 0.2.3

### Patch Changes

- Checks for a custom integration and a varying path.

  - `opencookie policy install --out <file>.json` writes the live policy and its
    identity as JSON for a custom programmatic integration, and
    `opencookie doctor --bundle <file>` reports whether a built bundle carries the
    live publication's identity.
  - `opencookie findings classify --match <pattern>` records a pattern for a path
    segment that varies, such as a cache-busting hash, and `findings check`
    matches through it.
  - A file outside the project is named as refused, not unreadable.
  - `policy preview` and the published declaration show category labels and
    every language, and a term naming a category is refused with the place its
    heading belongs.

- Updated dependencies
- Updated dependencies
  - @opencookie-dev/core@0.2.2
  - @opencookie-dev/vanilla@0.2.3

## 0.2.2

### Patch Changes

- `opencookie init` pins the 0.2.2 drop-in and its integrity.
- Updated dependencies
- Updated dependencies
  - @opencookie-dev/core@0.2.1
  - @opencookie-dev/vanilla@0.2.2

## 0.2.1

### Patch Changes

- Fixes from an independent review of 0.2.0.

  - The CLI refuses unknown options, and reads `--cwd <dir>` and `--cwd=<dir>`
    alike. Before, a mistyped option was ignored, and `--cwd=<dir>` ran the
    command in the current directory.
  - A changed policy cannot be published under the version that is already live.
    `opencookie doctor` compares the installed policy's content, not only its
    version.
  - A date-only `--until` includes the whole day.
  - The CLI never writes consent evidence into a plain-HTML web root, and
    `opencookie doctor` reports evidence that is already there.
  - The operator console refuses a sign-in posted from another site, and does not
    carry an erased visitor's id into its redirect.
  - `opencookie evidence retain` names the earlier exports that still hold what it
    removed.

- Updated dependencies
  - @opencookie-dev/vanilla@0.2.1

## 0.2.0

### Minor Changes

- Fixes from an independent review of 0.1.0.

  - A withdrawal in one tab now reloads the site's other open tabs, on every entry
    point.
  - A privacy-signal restriction is shown as blocked, not as a grant.
  - The first-visit bar can be dismissed without deciding. It keeps focused
    content visible, and reflows at 200 and 400 per cent zoom.
  - The drop-in speaks German with `data-oc-locale="de"`, and the interface
    declares the language of its copy.
  - The drop-in starts once when loaded twice, and one bad resource declaration no
    longer removes the banner.
  - A failed granular save can be retried.
  - The CLI refuses a flag value that looks like a flag, an unsafe publication id,
    a policy the configuration cannot load, and an install on plain HTML that
    would change nothing.
  - The CLI also refuses to replace files it did not write, recovers a lock whose
    command stopped, and keeps each site's policy module its own.
  - The operator console refuses weak tokens and slows repeated guesses. It keeps
    exports of personal data inside the site's data directory, and names the
    exports that still hold an erased visitor.
  - **Breaking:** `@opencookie-dev/nuxt` and `opencookie init` support Nuxt 4 only.
    Nuxt 3 reached end of life on 2026-07-31.

### Patch Changes

- Updated dependencies
  - @opencookie-dev/core@0.2.0
  - @opencookie-dev/vanilla@0.2.0

## 0.1.1

### Patch Changes

- Depend on the published `@opencookie-dev/core` and `@opencookie-dev/vanilla` packages. `opencookie@0.1.0` declared the `@opencookie/*` scope, which was never published, so it cannot be installed; use 0.1.1 or later.
