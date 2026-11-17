# @opencookie-dev/nuxt

## 0.2.1

### Patch Changes

- d47c091: Depend on `@nuxt/kit` and `@nuxt/schema` 4.6.4, which fix GHSA-mjrq-cffv-q4qc.

  Nuxt below 4.6.4 still installs the affected `@nuxt/schema` itself, so apps on an older Nuxt should update Nuxt to 4.6.4 as well.

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
  - @opencookie-dev/vue@0.2.0
