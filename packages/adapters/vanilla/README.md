# @opencookie-dev/vanilla

The no-framework browser adapter for OpenCookie. It provides an accessible, themeable consent interface plus declarative script and iframe enforcement.

## One-line CDN setup

The auto IIFE contains the core client, persistent local storage, and the accessible interface. Add one deferred classic script. No inline JavaScript or build step is required:

```html
<script
  defer
  src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js"
  integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS"
  crossorigin="anonymous"
></script>
```

The exact version and SHA-384 integrity token bind the browser to the verified packed IIFE. Keep the `integrity` value synchronized whenever the version or bundle bytes change, and retain `crossorigin="anonymous"` so the browser can enforce SRI across origins.

The drop-in is held to a size budget, not to its last measurement. The release verifier runs three paired enabled-versus-blocked cold mobile comparisons with 4x CPU and throttled networking through a bounded five-second Long-Task-free window. The controlled fixture rejects every enabled Long Task and every candidate script contribution lasting 50 ms or longer, and enabled mean whole-page Total Blocking Time must remain strictly below 20 ms. A p75 field INP of at most 200 ms is the post-deployment target, not a pre-deployment claim or release blocker while no field dataset exists.

The 0.4.0 release measures 40,398 gzip bytes and 132,569 raw bytes under the pinned toolchain. The active budgets are 45,000 gzip bytes and 150,000 raw bytes. The drop-in carries its `sourceMappingURL` comment. The closed settings dialog stays connected for stable native-dialog identity but has no dormant controls; its contents are built only when Settings opens, and cancelled drafts are discarded before it reopens. Policy construction rejects raw or canonical hidden controls, all join controls, browser-proven blank or layout-control identifier characters, and normalized duplicate references before rendering. Runtime snapshots preserve that invariant, and Google Consent Mode mappings are detached through dense own-data capture before any OpenCookie effect. General Unicode confusables and font-dependent private-use or unassigned characters remain outside this bounded policy. If client initialization, preceding cleanup, or initial resource reconciliation rejects, readiness preserves that rejection while the surviving runtime installs its route and expiry observers exactly once. At live expiry, browser resource reconciliation must complete before configured broadcast-port callbacks receive the expired projection. A rejected reconciliation, including one with an `undefined` reason, leaves both checkpoints pending, so a later `refresh()` re-blocks first and then broadcasts the same transition.

The conservative starter catalogue contains one optional analytics purpose under a fixed `optional` presentation root. Settings renders both the category choice and the Analytics purpose choice. Replace the starter with the site's real purposes and disclosures before production use. These optional attributes configure the starter without inline code:

```html
<script
  defer
  nonce="server-generated-nonce"
  data-oc-policy-version="privacy-notice-2"
  data-oc-storage-key="site.consent"
  data-oc-purpose-id="analytics"
  data-oc-purpose-label="Analytics"
  data-oc-purpose-description="Understand aggregate site usage."
  data-oc-locale="de"
  integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS"
  crossorigin="anonymous"
  src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js"
></script>
```

The CDN path publishes a complete compact catalogue: the selected purpose and disclosure plus the fixed `optional` presentation root, `site-operator` provider and recipient, `aggregate-measurement` operation, `180-days` retention, and `usage-event` data category references. The root is part of the compact product and is not another script attribute. Replace the purpose and disclosure before production use. For a site-specific catalogue or category graph, use the programmatic `policyDefinition` option described below. The script nonce is copied to OpenCookie's generated style element. Pin the package version, update the policy version when the decision surface changes, and test the actual production Content Security Policy.

Local storage is scoped to one origin. When sibling applications intentionally share one policy identity, opt into cookie storage and declare both the narrow cookie domain and its registrable-domain boundary:

```html
<script
  defer
  data-oc-storage="cookie"
  data-oc-storage-key="site_consent"
  data-oc-cookie-domain="apps.example.com"
  data-oc-registrable-domain="example.com"
  integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS"
  crossorigin="anonymous"
  src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js"
></script>
```

Both boundary attributes are required for shared scope. Omitting them with cookie storage creates a host-only cookie. OpenCookie validates that the configured cookie domain contains the current hostname and is not above the declared boundary. The browser still decides whether the declared boundary is a public suffix. Derive it with a maintained Public Suffix List implementation rather than splitting labels. Use the narrowest domain that contains the intended applications. This script-readable cookie stores consent decisions, not authentication secrets.

Browser storage failures are visible consent states. The default local-storage path re-probes a blocked `window.localStorage` getter until it resolves once, then retains that storage handle so later method failures cannot be mistaken for missing data. It requires a successful current-value read before writing and immediate readback afterward. The cookie path also verifies every assignment because browsers may ignore a cookie write without throwing. Until persistence is confirmed, a new grant remains pending, additional optional resources remain blocked, and the interface exposes a `role="alert"` message with `Try saving again`.

Private browsing and cross-site cookie policies vary by browser and deployment. Verify persistence across a reload and verify state loss after the private session ends in the actual target browser. Playwright WebKit is useful automated coverage but is not branded Safari. The built-in stores are browser-local and do not provide a durable server audit trail; pass a custom `DecisionStore` when that is a product requirement.

The auto entry discovers declarative scripts and iframes already present in the document, adds them to its optional resource policy, and watches for later SPA insertions that reuse a declared resource ID. Every resource needs a lowercase `data-oc-resource` and a lowercase `data-oc-category` matching a configured purpose. Despite the attribute name, `data-oc-category` identifies the purpose that gates the resource, not a presentation category. The resource remains blocked until that purpose is granted, starts immediately after a grant, and is re-blocked after withdrawal. A script that ran cannot be unloaded, so a tab that ran one reloads once a decision that turns it off is stored. What a resource declares it stores with `data-oc-stores`, such as `cookie:_ga local:ph_*`, is deleted whenever it is blocked, where script can reach it. Any element with `data-oc-open-preferences` opens the choices, and `opencookie:change` on `document` reports the purposes the visitor permits, for bridges to vendors OpenCookie does not load itself. A declaration with an unknown purpose or an invalid identifier is refused and reported on the console, and it stays blocked, together with every element that shares its identifier. The interface and the other resources still work.

## Install

```sh
pnpm add @opencookie-dev/core @opencookie-dev/vanilla
```

Mount the interface after creating an `OpenCookie` client:

```ts
import { mountOpenCookie } from "@opencookie-dev/vanilla";

const mounted = mountOpenCookie({
  client,
  nonce: window.__CSP_NONCE__,
});

await mounted.ready;
```

For a complete programmatic starter, use `bootstrapOpenCookie()` instead. It returns both the client and the mounted interface while keeping normal ESM and CommonJS imports side-effect-free. To customize its decision surface, pass a complete core `PolicyDefinition` through `policyDefinition`. Purpose labels and disclosures come directly from that validated, digest-bound policy, so the stored decision surface and rendered explanation cannot silently diverge. Pass a caller-owned core `DecisionStore` through `store` for cookie or server-bridged persistence. The `store` and `storage` options are mutually exclusive.

To run a policy published with the `opencookie` CLI, install it as JSON with `opencookie policy install --out <file>.json`, import that file, and pass it as `installedPolicy` instead of `policyDefinition`, `policyVersion` and `catalogueRevision`, which it cannot be combined with. The bootstrap derives the catalogue and decision-surface digests from its `policy` again and throws before mounting when either differs from the one recorded at install, so a file edited or replaced afterwards never runs and every declared resource stays inert. Because the runtime reads the recorded digests, a minified bundle keeps them, and `opencookie doctor --bundle <file>` reports which publication's identity the built file carries. `InstalledOpenCookiePolicy` types the option; its `policy` is typed loosely so an imported JSON file can be passed as it is.

A page with its own `data-oc-open-preferences` entry point can pass `launcher: false` to `bootstrapOpenCookie()` or `mountOpenCookie()` to leave out the floating launcher, so it covers nothing. It is omitted only while the page carries such an element, and a decision made in the banner moves focus there. A page without one keeps the launcher, so the choices stay reachable.

The programmatic route is measured from a committed page that bootstraps a three-purpose German policy with Consent Mode, bundled with vanilla and core for the browser. Its budget is 50,000 gzip bytes and 175,000 raw bytes. The 0.4.0 release measures 45,145 gzip bytes and 154,401 raw bytes. A site's own policy text adds to that.

From a script in `<head>`, before the body exists, call `bootstrapOpenCookieFromHead()` with the same options. It sends the denied Google Consent Mode default in the calling task, so a tag manager's inline snippet later in `<head>` finds it set, and resolves with the bootstrapped client and interface once the document is parsed. `bootstrapOpenCookie()` still requires a body.

`googleConsentMode.command` is required: pass the function that forwards each call to Google's tag, usually `command: (...args) => gtag(...args)`, with `gtag` defined first. When `googleConsentMode` is configured, its four mapping arrays are captured before any OpenCookie effect. Vanilla reads each top-level mapping field once, requires dense own data entries, detaches the captured arrays from later caller mutation, and permits at most 10,000 entries across the complete mapping. Sparse, accessor-backed, revoked, or oversized mappings reject. Caller-owned collection methods are ignored. The lower-level core projector retains its structural mapping compatibility and does not apply this vanilla boundary budget.

Category-backed sections render an operable category checkbox alongside their directly owned purpose choices. Direct section membership is only display ownership; activating a category expands that exact category and its descendants once, then completes required purpose dependencies in one domain batch. Deselecting it removes the same expansion and prunes unsupported dependents in one batch. All category checked and indeterminate states are derived together in one shared policy-DAG pass. A custom policy with no `presentationRootCategoryIds` renders every purpose in one flat section without a category checkbox. With roots, valid purposes outside the visited graph remain available in a trailing ungrouped section with individual purpose choices. The panel names a category by its `label`, or by its id when it has none, so give every category you present a label.

For selective re-consent, pass a current-inclusive `policyHistory` containing the current snapshot and the previous verified snapshots whose records remain supported. OpenCookie captures and verifies the list, derives the affected purposes, carries unaffected decisions forward, and keeps the historical record unchanged until the visitor decides again. Omitted `policyHistory` defaults to the current snapshot. An explicit malformed value, including JavaScript `null`, fails closed. The current-only auto bundle cannot receive trusted history. On an identity mismatch, prior grants become unresolved and prompt again, denials remain denied, and a valid withdrawal remains withdrawn.

Both `bootstrapOpenCookie()` and the classic-script auto bundle monitor the active record's expiry while the page remains open. They call the headless client's verified refresh path at the deadline and on relevant page lifecycle events. The client publishes an expired snapshot whose effective access is already blocked, then the browser runtime re-blocks declared resources before broadcasting that projection.

If a restored record's latest transition is ahead of the current wall clock, the browser products use that transition as a logical epoch floor and advance it with elapsed `performance.now()` time. The same clock drives the client and its expiry scheduler, so a corrected-back system clock cannot make decision controls inert or freeze expiry at the restored timestamp. Ordinary wall-clock timestamps remain unchanged. A nonbrowser DOM shim without the standard Performance API falls back to its injected wall clock and must advance that clock in tests.

A custom headless composition must schedule `client.refresh()` itself. It must also use one injected epoch clock for both the client and scheduler. After initialization, raise that clock to the restored record's `withdrawnAt` or `decidedAt` when it is ahead of wall time, then advance the floor with a monotonic duration source. Clamping every read to the record timestamp without advancing the floor will pause expiry until wall time catches up.

Optional scripts must be inert in the original HTML:

```html
<script
  type="text/plain"
  data-oc-resource="analytics-script"
  data-oc-category="analytics"
  data-src="https://cdn.example.test/analytics.js"
></script>
```

Optional iframes use a non-navigable template. This prevents browsers from restoring a previously allowed child-frame navigation from session history before expired consent can be evaluated. OpenCookie creates the iframe only after access is allowed:

```html
<template
  data-oc-iframe
  title="Product video"
  data-oc-resource="product-video"
  data-oc-category="analytics"
  data-src="https://video.example.test/embed/42"
></template>
```

Global and iframe attributes on the template, except `id` and `hidden`, are copied to the active iframe. A legacy source-less `<iframe data-src>` declaration remains supported, but its reload-history cleanup depends on `pagehide`; use the template form for lifecycle-independent blocking.

The auto bootstrap wires these declarations itself. Programmatic integrations can create controllers with `createBlockedScriptController` and `createBlockedIframeController`, then pass them to the core access reconciler.

Customize the UI with `VanillaOpenCookieMountOptions.copy` and the `--oc-*` CSS custom properties. The tokens are declared on `:where(.oc-root)`, which has no specificity, so a rule you write for `.oc-root` wins. Component rules keep a single class, and the stylesheet is inserted first in `<head>`, so a site rule of equal weight wins by coming later. Text on an `--oc-accent` background uses `--oc-paper`; test every custom accent and paper pair for contrast. Pass a CSP nonce when the page uses a nonce-based `style-src` policy.

A programmatic client whose resource policy contains `declared-exception` entries retains each required `exceptionReason` in its runtime snapshot. `mountOpenCookie()` renders those entries as noninteractive resource disclosures under the configurable `copy.notControlled` heading. The declarative bootstrap creates optional resources only. Declaring an exception records operator configuration; it does not validate necessity or legal basis, so review the deployed classification and wording for the site and jurisdiction.

OpenCookie is a technical tool, not legal advice or a compliance guarantee. The deploying site remains responsible for its policy, catalogue, disclosures, wording, retention, and jurisdiction analysis.

## Official references

Accessed 2026-08-22:

- [HTML classic scripts and external `src`](https://html.spec.whatwg.org/multipage/scripting.html#the-script-element)
- [HTML custom data attributes](https://html.spec.whatwg.org/multipage/dom.html#embedding-custom-non-visible-data-with-the-data-*-attributes)
- [Document `currentScript`](https://html.spec.whatwg.org/multipage/dom.html#dom-document-currentscript)
- [MDN `Document.cookie`](https://developer.mozilla.org/en-US/docs/Web/API/Document/cookie)
- [MDN secure cookie scope](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies)
- [IETF cookie domain and Public Suffix List guidance](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis/)
- [tsdown multiple output configurations](https://tsdown.dev/options/config-file#building-multiple-outputs)
- [tsdown IIFE output](https://tsdown.dev/options/output-format)
