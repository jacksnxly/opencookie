# @opencookie-dev/vanilla

## 0.4.0

### Minor Changes

- A tab that hears a decision before the stored write reaches it keeps adopting for up to two seconds. On the drop-in, `bootstrapOpenCookie()` and the framework bindings, a tab that reads a record it cannot take, such as one from another policy version, reloads at once. A tab mounted by `mountOpenCookie()` with its own client reloads when the two seconds end if it still holds a record it cannot take: a choice of its own that failed to store, or a record from another policy version; a choice of its own that is stored within the two seconds ends the wait without a reload. A store that stays unchanged, as another install's announcement leaves it, never reloads the tab.

- The banner root is appended after the page's content, so a skip link stays the first keyboard stop.

  The banner is a labelled region with tabindex -1, and it is still not modal.

  The banner itself has no focus outline; its controls keep their focus rings.

  On a first visit, when nothing is stored and the page has not focused anything, focus moves to the banner.

- Other open tabs adopt a stored decision in place, and reload only when it blocks or revokes something that may already have run there.

  A record this tab cannot verify still reloads it; the entry above gives the timing.

- Accept Next.js 15 as a peer of `@opencookie-dev/next`; every `pnpm verify` runs a fresh Next.js 15.5.9 App Router app beside both routers on 16.3.2.

  When `opencookie init` cannot install its packages, the error names every file init still has to create, including the record, and says to run init again.

  A generated starter policy or resource policy names each issue's code and path when it is invalid.

  The browser binding's mount accepts banner links and the launcher option, and refuses a link that could run script before anything mounts.

  The banner's choices come before its links in the DOM.

  The save-failure notice is drawn as a card.

  `googleConsentMode.command` is required, the default tokens live on `:where(.oc-root)`, and a presented category without a label shows its id.

  The soft and minimal templates give the banner links their own row below the choices under 52.5rem.

### Patch Changes

- Updated dependencies [e087b88]
  - @opencookie-dev/core@0.2.4

## 0.3.0

### Minor Changes

- A new default look, a stylesheet that yields to the site, and four options on the programmatic bootstrap.

  - The default banner is a quiet card: rounded, softly shadowed, in the page's
    own type, with the text across the width, the site's legal links at the
    bottom left and three equally wide choices at the bottom right. Reject and
    accept are identical at every width; settings is the outlined choice and
    gains the class `oc-btn--quiet`. The settings panel draws its checkboxes as
    switches. **An upgrade changes how the default banner looks.** A site that
    restyles it under `.oc-root` keeps its own design.
  - The stylesheet is now the first element of `<head>` and its root rule has no
    specificity, so a plain site rule of equal weight wins. New tokens:
    `--oc-radius`, `--oc-border` and `--oc-shadow`.
  - `links` shows the site's legal links in the banner. An address must be
    `http`, `https`, a path on the site or a fragment.
  - `globalPrivacyControl: { purposeIds }` reads the browser's Global Privacy
    Control signal and restricts those purposes. An id the policy does not have
    is refused before anything mounts.
  - `receipt` hands each consent receipt to the site.
  - `VANILLA_COPY_DE_DU` is the informal German copy.
  - Under `launcher: false` the launcher returns when the page's own settings
    link goes away without a reload.
  - A category whose only purpose has the same label is shown once.
  - The `soft` and `minimal` templates size the choices by the grid, so reject
    and accept no longer differ in width with longer labels.

## 0.2.5

### Patch Changes

- The banner belongs to the page, and a template kit to start a design from.

  - The dark palette follows the page's own `color-scheme` instead of the
    visitor's OS, so a light-only page keeps a light banner. A page that declares
    `color-scheme: light dark` or `dark` gets the dark palette.
  - The bar's close control is plain text again, and the settings title no
    longer draws a focus ring after a mouse click.
  - Two templates, `soft` and `minimal`, ship as CSS files under
    `@opencookie-dev/vanilla/templates/*`. They only restyle, scoped to
    `.oc-root`, and your own rules still win. The class names a site may style
    are documented and kept stable.
  - Deleting a declared cookie no longer writes domains a browser refuses, such
    as a top-level label or part of an IP address, which Firefox logged as a
    console error on every withdrawal.

## 0.2.4

### Patch Changes

- A page with its own settings link can leave out the floating launcher.

  - `launcher: false` on `bootstrapOpenCookie()`, `bootstrapOpenCookieFromHead()`
    and `mountOpenCookie()` omits the launcher while the page carries a
    `data-oc-open-preferences` element, and a decision in the banner moves focus
    to that element. A page without one keeps the launcher.
  - Categories and their purposes are shown in the policy's order.

- Updated dependencies
  - @opencookie-dev/core@0.2.3

## 0.2.3

### Patch Changes

- The programmatic route for a real site: `<head>`, several languages, a tag
  manager's container, and exceptions.

  - `bootstrapOpenCookieFromHead()` sends the denied Consent Mode default in the
    calling task, before a tag manager's inline snippet, and mounts once the
    document is parsed. The drop-in sends its default from `<head>` too; define
    `gtag` before its tag.
  - The panel shows a policy's translations in the copy's language and each
    category's label, and records the language the visitor decided in.
  - `declaredExceptions` lists what runs whatever the visitor chooses, with an
    optional `label`, under "Not controlled by these choices".
  - `data-oc-category="analytics advertising" data-oc-match="any"` loads a
    container when any one of its purposes is permitted. `googleConsentMode`
    takes `purposeMapping` in place of `mapping`. Turning off one of a started
    container's purposes reloads the tab, and a `purpose=` prefix in
    `data-oc-stores` deletes that purpose's storage while the container stays
    allowed.
  - `installedPolicy` takes the JSON `opencookie policy install --out <file>.json`
    writes, and refuses to mount when its digests do not match.

- Updated dependencies
  - @opencookie-dev/core@0.2.2

## 0.2.2

### Patch Changes

- Withdrawal in the visitor's own tab, and three ways for a site to work with
  the banner.

  - Once a decision made in this tab is stored and turns off a script the page
    ran, the tab reloads, because a script that ran cannot be unloaded. A
    hand-wired `mountOpenCookie` reloads when its stored decision blocks a
    resource the last one allowed. A first Reject all, a grant and a revoked
    frame do not reload.
  - A blocked script or frame can declare what it stores with
    `data-oc-stores="cookie:_ga local:ph_*"`. Whenever the resource is blocked,
    OpenCookie deletes those cookies and Web Storage entries where script can
    reach them.
  - Any element with `data-oc-open-preferences`, such as a footer "Cookie
    settings" link, opens the choices on every entry point, including the
    drop-in.
  - Every entry point dispatches `opencookie:change` on `document` with the
    permitted and revoked purposes, so a bridge can stop a vendor it started,
    for example PostHog.

- Updated dependencies
  - @opencookie-dev/core@0.2.1

## 0.2.1

### Patch Changes

- Fixes from an independent review of 0.2.0.

  - A tab no longer reloads itself later after the visitor's own denial or
    withdrawal.
  - Two installations on one origin no longer reload each other's tabs. A tab
    reloads only when its own stored decision changed.
  - A page re-checks its stored decision on `pageshow` only when it is restored
    from the back-forward cache, not after every load. Before, a stored
    decision that changed in the first half second after a load reloaded the
    page.

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
