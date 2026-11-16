# @opencookie-dev/core

The framework-independent domain and application core for OpenCookie. It owns policy validation, consent decisions, re-consent planning, effective resource access, persistence, privacy signals, and the headless external store.

`@opencookie-dev/core` has no runtime dependencies. Importing it performs no browser or storage access, so the same module can be used during server rendering and in the browser.

## Install

```sh
pnpm add @opencookie-dev/core
```

Most applications should start with the `opencookie` CLI and a framework adapter. Use the core package directly when you need a headless integration or a custom infrastructure adapter.

The primary facade is `createOpenCookie(options)`. Construction is deterministic and SSR-safe. Call `initialize()` only after the host runtime is ready, then subscribe through `getSnapshot`, `getServerSnapshot`, and `subscribe`.

`definePolicy()` requires each optional purpose to include a nonblank disclosure and nonempty provider, operation, retention, recipient, and data-category reference lists. Every referenced identifier must resolve against the same catalogue. Policy identifiers are canonicalized with NFKC, lowercase, and final NFKC recomposition. Raw or canonical controls, default-ignorable code points, join controls, U+2028, U+2029, U+2800, and U+FFF9 through U+FFFC reject. Normalized duplicate category children, category purposes, and presentation roots reject at the duplicate entry path. Labels and disclosures may contain meaningful visible joiners, but wholly invisible copy rejects as blank. Invalid definitions return field-specific issue codes and paths instead of publishing an incomplete decision surface. Presentation reachability is not policy validity: a valid purpose may sit outside the graph reached from `presentationRootCategoryIds` and remains part of the consent decision surface.

`UnreachablePurposeIssue` remains exported as a deprecated compatibility type,
but `definePolicy()` no longer emits it. Use the trailing ungrouped presentation
section rather than treating a valid purpose outside the root graph as invalid.

Advanced adapters can import `normalizePolicyIdentifier()` from
`@opencookie-dev/core/domain` to apply the same identifier rule at an input
boundary. It returns the canonical identifier or an empty string when the
value is invalid.

## Public entries

The package exposes six explicit public entries:

| Import                            | Purpose                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@opencookie-dev/core`                | Root-only headless client, policy construction, snapshots, and localStorage default                                      |
| `@opencookie-dev/core/domain`         | Advanced pure domain operations for policy projection, category selection, dependency closure, and access               |
| `@opencookie-dev/core/application`    | Low-level transitions, persistence ports, and runtime orchestration, excluding the headless client and policy reconciler |
| `@opencookie-dev/core/reconciliation` | Verified policy-history reconciliation contracts and reconciler                                                          |
| `@opencookie-dev/core/infrastructure` | Optional cookie storage, signal, and access-enforcement adapters                                                         |
| `@opencookie-dev/core/auto`           | Dedicated compact single-purpose composition with a fixed `optional` presentation root                                   |

Each entry has ESM, CommonJS, and type declarations. There is no catch-all low-level entry. Import only the layer you need instead of relying on an internal file path.

## Category presentation and selection

`projectPolicySections()` turns the presentation-root category DAG into deterministic sections. `PolicySection.purposeIds` records direct, single-owner display membership: a purpose shared by a diamond is rendered in the first visited category only. It is not the transitive purpose set selected by that category. Valid purposes outside the visited graph appear in one trailing ungrouped section; a policy with no presentation roots produces one flat section containing every purpose. Flat and trailing sections have `categoryId: null` and keep their individual purpose choices without inventing a category control.

Use `expandCategorySelection()` to compute one activated category's exact transitive purpose set. The result is transient rather than copied onto every presentation section. `resolveCategorySelectionStates()` derives checked and indeterminate state for every category in one memoized pass over the policy DAG. Apply the resulting selection through one `resolvePurposeSelection()` batch operation: `complete` adds required purpose dependencies after a grant, while `supported` prunes dependents whose prerequisites were removed after a denial.

The compact `@opencookie-dev/core/auto` composition exposes the same behavior for its fixed single-purpose `optional` root without importing the generic domain entry into the classic-script product. Custom category graphs use the generic policy API.

The release verifier measures both individual entries and representative complete consumer graphs as self-contained, minified browser bundles with canonical gzip accounting. Current individual measurements and ratcheted caps are:

| Entry          | Measured gzip |   Hard limit |
| -------------- | ------------: | -----------: |
| root           |  27,700 bytes | 27,708 bytes |
| domain         |   10,527 bytes |  10,543 bytes |
| application    |  14,190 bytes | 14,220 bytes |
| reconciliation |   7,925 bytes |  7,941 bytes |
| infrastructure |   5,773 bytes |  5,789 bytes |
| auto           |  26,113 bytes | 26,121 bytes |

The current graphs are 32,380 bytes for root plus infrastructure, 42,557 bytes for root plus domain plus infrastructure, and 32,807 bytes for domain plus application plus infrastructure. Their hard caps are 32,388, 42,565, and 32,835 bytes respectively. The first two moved in 0.2.4 by the measured cost of cross-tab adoption.

## Policy history and selective re-consent

The root-only headless client accepts an optional, current-inclusive `policyHistory` of one to 32 verified `PolicySnapshot` values. Include the current snapshot and each previous snapshot whose stored records the application still recognizes. Omitting the option defaults to the current snapshot only.

OpenCookie captures the list once during construction, detaches it from later mutation, verifies every snapshot identity, and derives the policy change set itself. It never trusts a caller-authored list of affected purposes. A missing matching historical snapshot, duplicate identity, malformed list, forged digest, or inconsistent version change fails closed. With valid history, unaffected decisions carry forward, affected grants and new purposes become unresolved, and existing denials remain denied. The stored historical record remains unchanged until the visitor makes a new decision.

Import `createPolicyReconciler` from `@opencookie-dev/core/reconciliation` when a host needs the same pure reconciliation result outside the client. Its input is the current snapshot, retained historical snapshots, stored record, and current time. It does not accept a caller-authored change set.

## Persistence adapter contract

A custom `DecisionStore` receives the complete expected durable record for `compareAndSet`, not only its revision. It must compare the record identity, revision, and complete content before replacing it. `clearIfCurrent` applies the same exact precondition before cleanup and reports `conflict` when another writer has replaced the record. The unconditional `clear` operation exists for explicit testing resets, not ambiguous transition recovery.

Store methods are non-reentrant persistence operations. An adapter must not call and await a command on the same `OpenCookie` instance while `read`, `compareAndSet`, `clearIfCurrent`, or `clear` is pending. Runtime command completion may itself be waiting for that store operation, so such a callback cycle cannot settle. Complete any store promise first, then start follow-up client work outside the adapter method.

The built-in Web Storage and cookie adapters implement optimistic exact-precondition checks followed by mutation and immediate readback. Browser storage does not provide a cross-context transaction across those steps. A second tab can still write between the check and mutation. A check-delete race can discard that concurrent decision, which leaves consent missing and re-prompts instead of restoring a grant. The adapter reports an unconfirmed readback when a race is observable and does not claim linearizable cross-tab persistence. Cookie storage only accepts and emits the site-wide `/` path. A non-root path is rejected before any write because a page cannot reliably inspect or clear cookies outside its visible path. Use a server-backed custom store with a real conditional operation when that guarantee is required.

## Time and receipt contract

Domain and persisted epoch-millisecond timestamps must be safe integers. Invalid decision, expiry, withdrawal, receipt, and GPC observation times fail closed before they can affect persistence or runtime publication. Direct `resolveGpcSignal` input is captured as at most 10,000 dense own data-property observations. Caller-owned collection methods, iterators, and array species are ignored; sparse, accessor-backed, revoked, non-array, and oversized collections fail closed.

Restoring a valid persisted state advances the client's logical clock to at least the record's latest transition time. A corrected-back wall clock therefore cannot make every replacement decision older than the restored record. The framework-neutral client does not own an elapsed-time source or an expiry timer. A custom host that schedules restored expiry must keep its injected epoch clock advancing from that restored floor with a monotonic duration source, then use the same clock to schedule `refresh()`.

Consent receipts use schema version 2. A fresh decision uses its decision time for both `decidedAt` and `occurredAt`. Retrying an unchanged decision after an unconfirmed persistence attempt retains the original `decidedAt` and uses the retry command time as `occurredAt`. A withdrawal retains the original decision time and uses `withdrawnAt` as its occurrence time. Every receipt requires `occurredAt >= decidedAt`; its idempotency key remains `<transitionId>:<revision>`.

OpenCookie is a technical tool, not legal advice.
