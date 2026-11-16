# @opencookie-dev/core

## 0.2.4

### Patch Changes

- Other open tabs adopt a stored decision in place, and reload only when it blocks or revokes something that may already have run there.

  A record this tab cannot verify, or a decision already in flight, still reloads the tab.

## 0.2.3

### Patch Changes

- Categories and their purposes keep the order a policy lists them in.

  - `definePolicy` keeps the authored order of `presentationRootCategoryIds`, a
    category's `categoryIds` and its `purposeIds`, so the panel and the
    declaration show them in that order instead of alphabetically.
  - The order stays out of the policy's identity: both digests hash every
    identifier list sorted, so every existing policy keeps its digests and a
    reordering re-asks nobody.

## 0.2.2

### Patch Changes

- Policies in several languages, labelled categories, and containers that serve
  several purposes.

  - A purpose can carry `translations`, each with a canonical `locale`, `label`
    and `disclosure`. A category can carry a `label`, its heading, and
    `translations` of it. They are part of the policy's identity, so one policy
    serves every language and a decision stays current whichever one a page
    shows. A policy without them keeps its exact digests.
  - `resolvePolicyText(policy, locale)` returns the text to show in a page's
    language. `diffPolicies` counts a changed or added translation as
    visitor-facing text.
  - An optional resource with several purposes can declare
    `purposeMatch: "any"`. It is allowed when any one purpose is permitted, each
    judged on its own, while a restriction on the resource or its service still
    blocks it. The compact auto product keeps the all-of rule.
  - A declared exception can carry a `label`, shown in place of its id.
  - `projectGoogleConsentModePurposeState` grants each Consent Mode signal while
    the purposes mapped to it are permitted.

## 0.2.1

### Patch Changes

- The runtime projection's new `permittedPurposeIds` lists the optional purposes
  the visitor's decision permits now, by the same rule that blocks resources.
  Bridges to vendors OpenCookie does not load itself read it through the
  `opencookie:change` event.

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
