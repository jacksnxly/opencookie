# OpenCookie evidence-backed pain points

Research date: 2026-08-22

Severity reflects likely impact if the failure reaches production:

- Critical: optional disclosure before choice, core application failure, or checkout failure.
- High: consent correctness, persistence, SSR, accessibility, audit, or operator-control failure.
- Medium: material integration, configuration, testing, localization, or maintainability cost.
- Low: bounded inconvenience without a meaningful correctness or access impact.

### PP-01: Consent UI can render while optional resources already disclose data

- Severity: Critical
- Evidence: SRC-002, SRC-003, SRC-005, SRC-038, SRC-041
- Design response: Declare optional scripts, iframes, and storage operations inert before boot; activate them only from the effective decision and expose observable enforcement diagnostics.
- Traceability: REQ-BLOCK-BEFORE-CONSENT; TEST-NO-PRECONSENT-LOAD

### PP-02: Heuristic auto-blocking can break frameworks and payment flows

- Severity: Critical
- Evidence: SRC-040, SRC-043, SRC-047
- Design response: Use explicit declarative blocking, make first-party runtime and configured essential services structurally unblockable, and test reject-all through real application and checkout fixtures.
- Traceability: REQ-DECLARATIVE-BLOCKING; TEST-ESSENTIAL-APP-SURVIVES-REJECT

### PP-03: Consent signals and ready events can be emitted in the wrong order

- Severity: Critical
- Evidence: SRC-013, SRC-030, SRC-044
- Design response: Make broadcasting transactional: denied defaults, restored or new decision, all four consent updates, service activation, then one ready event.
- Traceability: REQ-ATOMIC-SIGNAL-ORDER; TEST-CONSENT-MODE-ORDER

### PP-04: Browser-only CMP imports cause SSR and hydration failures

- Severity: High
- Evidence: SRC-037, SRC-039
- Design response: Keep all package imports side-effect free and server-safe, render into a stable host, and give each SSR framework a lifecycle-owned adapter.
- Traceability: REQ-SSR-SAFE-IMPORTS; TEST-SSR-HYDRATION-MATCH

### PP-05: SPA routes and body replacement strand newly inserted or preserved nodes

- Severity: High
- Evidence: SRC-029, SRC-033, SRC-036
- Design response: Provide idempotent mount, reconcile, discover, and unmount operations plus an optional MutationObserver and explicit framework route hooks.
- Traceability: REQ-IDEMPOTENT-RECONCILIATION; TEST-SPA-DYNAMIC-DISCOVERY

### PP-06: Large synchronous payloads and unstable mounting hurt FCP and visual stability

- Severity: High
- Evidence: SRC-031, SRC-045, SRC-059
- Design response: Separate a tiny synchronous denied-state bootstrap from deferred presentation, reserve stable layout, and enforce bundle, FCP, CLS, and no-FOUC budgets.
- Traceability: REQ-SPLIT-BOOTSTRAP; TEST-CLS-AND-FOUC; TEST-SIZE-BUDGETS

### PP-07: Strict CSP can suppress a banner or break activated scripts

- Severity: High
- Evidence: SRC-024, SRC-025, SRC-042
- Design response: Accept a fresh SSR nonce, propagate the element nonce property during activation, support self-hosted assets, and require strict-CSP fixtures without unsafe-inline or unsafe-eval.
- Traceability: REQ-CSP-NONCE; TEST-CSP-NONCE-PROPERTY

### PP-08: Third-party iframes cannot reliably share first-party consent state

- Severity: High
- Evidence: SRC-023, SRC-029
- Design response: Keep the first-party page in control, render fixed-size accessible placeholders, activate only after consent, and use explicit postMessage integration only for cooperating frames.
- Traceability: REQ-IFRAME-PLACEHOLDER; TEST-IFRAME-FIRST-PARTY-CONTROL

### PP-09: Safari may delete script-writable consent state and trigger re-prompts

- Severity: High
- Evidence: SRC-022, SRC-023
- Design response: Treat missing storage as a normal first-visit state, keep decisions idempotent, expose expiry reasons, and test loss and return in real WebKit.
- Traceability: REQ-FALLIBLE-STORAGE; TEST-SAFARI-STATE-LOSS

### PP-10: Cookie domain defaults can leak or isolate decisions across subdomains

- Severity: High
- Evidence: SRC-034
- Design response: Model host-only and registrable-domain scope explicitly, validate domain configuration, and test both isolation and intended sharing on real subdomains.
- Traceability: REQ-COOKIE-SCOPE; TEST-SUBDOMAIN-SCOPE

### PP-11: Browser consent storage can disappear, conflict, or reject writes

- Severity: High
- Evidence: SRC-022, SRC-061
- Design response: Validate a closed record schema, inspect duplicate cookies defensively, verify grant write-readback, preserve fail-closed rejection, and emit machine-readable invalidation reasons.
- Traceability: REQ-DEFENSIVE-STORAGE; TEST-STORAGE-FAIL-CLOSED

### PP-12: Lightweight OSS often lacks privacy-minimal proof of consent

- Severity: High
- Evidence: SRC-001, SRC-007, SRC-035, SRC-050
- Design response: Define a canonical versioned receipt and an optional sink port with idempotency, minimization, bounded retry, and no remote dependency in core.
- Traceability: REQ-CONSENT-RECEIPT; TEST-CONSENT-PROOF-MINIMAL

### PP-13: Policy or catalogue changes need selective and explainable re-consent

- Severity: High
- Evidence: SRC-004, SRC-007, SRC-008, SRC-014
- Design response: Bind decisions to policy version and catalogue digest, compute meaningful diffs, re-prompt for purpose, service, retention, or processing changes, and ignore cosmetic edits.
- Traceability: REQ-POLICY-SUPERSESSION; TEST-POLICY-DIFF-REPROMPT

### PP-14: Withdrawal and preference reopening are often hidden or fragile

- Severity: High
- Evidence: SRC-001, SRC-004, SRC-005, SRC-058
- Design response: Ship a durable first-party preference control and explicit showPreferences, withdraw, and reset APIs whose availability does not depend on remote banner state.
- Traceability: REQ-CONTINUOUS-PREFERENCES; TEST-WITHDRAWAL-PARITY

### PP-15: Accept and reject paths frequently use unequal cost or visual weight

- Severity: High
- Evidence: SRC-005, SRC-006, SRC-007, SRC-011
- Design response: Show accept-all and reject-all together with equal action count, geometry, keyboard reachability, latency, and visual weight; test granular save separately.
- Traceability: REQ-DECISION-PARITY; TEST-DECISION-PARITY

### PP-16: Button parity does not fix vague or misleading information

- Severity: High
- Evidence: SRC-006, SRC-008, SRC-011
- Design response: Make purpose, provider, data category, duration, retention, dependencies, and decision consequences first-class catalogue content with plain, localizable presentation.
- Traceability: REQ-INFORMED-CATALOGUE; TEST-DISCLOSURE-COMPLETENESS

### PP-17: Consent dialogs ship focus escapes, missing names, and semantic defects

- Severity: High
- Evidence: SRC-026, SRC-027, SRC-032
- Design response: Implement the modal as a focus state machine with inert background, stable accessible naming, Tab wrapping, Escape, restoration, and manual plus automated checks.
- Traceability: REQ-ACCESSIBLE-DIALOG; TEST-DIALOG-KEYBOARD

### PP-18: Target size, contrast, motion, and color preferences are easily missed

- Severity: Medium
- Evidence: SRC-026, SRC-028
- Design response: Define accessible token floors, CSS-only reduced-motion and color preferences, forced-colors support, and computed geometry and contrast assertions.
- Traceability: REQ-USER-PREFERENCE-CSS; TEST-A11Y-VISUAL-MODES

### PP-19: Headless control and deterministic test state are underspecified

- Severity: Medium
- Evidence: SRC-054, SRC-055, SRC-056
- Design response: Expose typed show, decide, withdraw, inspect, subscribe, and reset-for-testing APIs with stable selectors and a localhost-safe storage mode.
- Traceability: REQ-HEADLESS-API; TEST-PROGRAMMATIC-STATE-CONTROL

### PP-20: Framework adapter sprawl duplicates lifecycle and domain logic

- Severity: High
- Evidence: SRC-029, SRC-033, SRC-037, SRC-039, SRC-056
- Design response: Keep one domain and application core; adapters only own framework rendering, injection, and lifecycle and are blocked from importing each other.
- Traceability: REQ-THIN-ADAPTERS; TEST-ARCH-ADAPTER-BOUNDARIES

### PP-21: Bundle size and synchronous boot cost are rarely release gates

- Severity: High
- Evidence: SRC-031, SRC-045
- Design response: Enforce core and vanilla gzip budgets, separate locale and CSS payloads, keep zero runtime dependencies in core, and measure a no-CMP fixture baseline.
- Traceability: REQ-SIZE-BUDGETS; TEST-SIZE-BUDGETS; TEST-WEB-VITALS-BASELINE

### PP-22: Missing locale or theme contracts can suppress UI or break overrides

- Severity: Medium
- Evidence: SRC-046, SRC-056, SRC-060
- Design response: Validate locale completeness, fall back deterministically, publish semantic slots and CSS custom properties, and execute every documented typed integration sample.
- Traceability: REQ-I18N-THEME-CONTRACT; TEST-LOCALE-FALLBACK; TEST-THEME-SLOTS

### PP-23: Cookie scanners are incomplete and can create false confidence

- Severity: High
- Evidence: SRC-002, SRC-041
- Design response: Keep scanning outside core, import findings with provenance and uncertainty, require operator classification, and verify every declared service through real before-and-after network checks.
- Traceability: REQ-SCAN-PROVENANCE; TEST-CATALOGUE-NETWORK-COVERAGE

### PP-24: Hosted pricing and remote delivery can disable essential consent behavior

- Severity: High
- Evidence: SRC-048, SRC-049, SRC-051, SRC-052, SRC-057
- Design response: Make runtime, UI, configuration, and blocking self-hosted and usage-neutral; hosted proof or scanning remains an optional replaceable service.
- Traceability: REQ-NO-REMOTE-RUNTIME; TEST-OFFLINE-RUNTIME

### PP-25: GPC precedence differs from an explicit site decision and from EU consent

- Severity: High
- Evidence: SRC-018, SRC-019, SRC-020, SRC-021, SRC-053
- Design response: Preserve GPC as a raw server and client signal, resolve effect through a configurable jurisdiction policy, record the reason, and never map it blindly to every consent category.
- Traceability: REQ-GPC-POLICY; TEST-GPC-SERVER-CLIENT

### PP-26: TCF versions and policies change faster than hard-coded integrations

- Severity: High
- Evidence: SRC-014, SRC-015, SRC-016, SRC-017
- Design response: Keep TCF outside core behind a versioned optional port, treat v2.2 as legacy compatibility, track active v2.3 and the v2.4 transition, and avoid certification claims.
- Traceability: REQ-VERSIONED-TCF-PORT; TEST-TCF-PROTOCOL-VERSION

### PP-27: Operators conflate terminal consent with every downstream lawful basis

- Severity: High
- Evidence: SRC-001, SRC-002, SRC-003, SRC-010
- Design response: Model terminal operations, processing purposes, lawful-basis metadata, decisions, and outbound signals separately without pretending the library determines legal basis.
- Traceability: REQ-LEGAL-SEPARATION; TEST-DOMAIN-LEGAL-SEPARATION

### PP-28: Provider, duration, retention, and data-category metadata drifts from reality

- Severity: High
- Evidence: SRC-007, SRC-008, SRC-014, SRC-041
- Design response: Use a typed versioned policy catalogue, validate required disclosure fields, record its digest with each decision, and surface unknown or stale scan mappings.
- Traceability: REQ-VERSIONED-POLICY-CATALOGUE; TEST-CATALOGUE-SCHEMA

### PP-29: Vendor SDK lifecycle cannot be reduced to one-time script insertion

- Severity: High
- Evidence: SRC-036, SRC-038, SRC-062
- Design response: Give each service idempotent start, update, and stop lifecycles, re-block future discovery immediately, clear operator-declared storage where possible, and disclose irreversible effects.
- Traceability: REQ-SERVICE-LIFECYCLE; TEST-WITHDRAWAL-REBLOCKS

### PP-30: Local setup and automation need stable diagnostics instead of hidden suppression

- Severity: Medium
- Evidence: SRC-046, SRC-054, SRC-055
- Design response: Provide `opencookie doctor`, stable test selectors, explicit automation policy, local fixture domains, reason-coded banner suppression, and idempotent noninteractive init.
- Traceability: REQ-DIAGNOSTIC-DX; TEST-DX-DOCTOR; TEST-DX-INIT-IDEMPOTENT

## Traceability table

| Pain point | Requirement or ADR | Test |
| --- | --- | --- |
| PP-01 | REQ-BLOCK-BEFORE-CONSENT | TEST-NO-PRECONSENT-LOAD |
| PP-02 | REQ-DECLARATIVE-BLOCKING | TEST-ESSENTIAL-APP-SURVIVES-REJECT |
| PP-03 | REQ-ATOMIC-SIGNAL-ORDER | TEST-CONSENT-MODE-ORDER |
| PP-04 | REQ-SSR-SAFE-IMPORTS | TEST-SSR-HYDRATION-MATCH |
| PP-05 | REQ-IDEMPOTENT-RECONCILIATION | TEST-SPA-DYNAMIC-DISCOVERY |
| PP-06 | REQ-SPLIT-BOOTSTRAP | TEST-CLS-AND-FOUC |
| PP-07 | REQ-CSP-NONCE | TEST-CSP-NONCE-PROPERTY |
| PP-08 | REQ-IFRAME-PLACEHOLDER | TEST-IFRAME-FIRST-PARTY-CONTROL |
| PP-09 | REQ-FALLIBLE-STORAGE | TEST-SAFARI-STATE-LOSS |
| PP-10 | REQ-COOKIE-SCOPE | TEST-SUBDOMAIN-SCOPE |
| PP-11 | REQ-DEFENSIVE-STORAGE | TEST-STORAGE-FAIL-CLOSED |
| PP-12 | REQ-CONSENT-RECEIPT | TEST-CONSENT-PROOF-MINIMAL |
| PP-13 | REQ-POLICY-SUPERSESSION | TEST-POLICY-DIFF-REPROMPT |
| PP-14 | REQ-CONTINUOUS-PREFERENCES | TEST-WITHDRAWAL-PARITY |
| PP-15 | REQ-DECISION-PARITY | TEST-DECISION-PARITY |
| PP-16 | REQ-INFORMED-CATALOGUE | TEST-DISCLOSURE-COMPLETENESS |
| PP-17 | REQ-ACCESSIBLE-DIALOG | TEST-DIALOG-KEYBOARD |
| PP-18 | REQ-USER-PREFERENCE-CSS | TEST-A11Y-VISUAL-MODES |
| PP-19 | REQ-HEADLESS-API | TEST-PROGRAMMATIC-STATE-CONTROL |
| PP-20 | REQ-THIN-ADAPTERS | TEST-ARCH-ADAPTER-BOUNDARIES |
| PP-21 | REQ-SIZE-BUDGETS | TEST-WEB-VITALS-BASELINE |
| PP-22 | REQ-I18N-THEME-CONTRACT | TEST-LOCALE-FALLBACK |
| PP-23 | REQ-SCAN-PROVENANCE | TEST-CATALOGUE-NETWORK-COVERAGE |
| PP-24 | REQ-NO-REMOTE-RUNTIME | TEST-OFFLINE-RUNTIME |
| PP-25 | REQ-GPC-POLICY | TEST-GPC-SERVER-CLIENT |
| PP-26 | REQ-VERSIONED-TCF-PORT | TEST-TCF-PROTOCOL-VERSION |
| PP-27 | REQ-LEGAL-SEPARATION | TEST-DOMAIN-LEGAL-SEPARATION |
| PP-28 | REQ-VERSIONED-POLICY-CATALOGUE | TEST-CATALOGUE-SCHEMA |
| PP-29 | REQ-SERVICE-LIFECYCLE | TEST-WITHDRAWAL-REBLOCKS |
| PP-30 | REQ-DIAGNOSTIC-DX | TEST-DX-INIT-IDEMPOTENT |

## Non-goals

- Legal determination or a compliance guarantee. OpenCookie represents configured decisions and effects; it cannot decide whether an operator's purpose, lawful basis, exception, wording, retention, or jurisdiction analysis is correct.
- An authoritative cookie scanner. Discovery is probabilistic and route, browser, state, and session dependent. OpenCookie may import versioned findings, but operator classification and live network verification remain required.
- A hosted SaaS control plane, metered remote banner, or mandatory proof backend. Runtime behavior remains local and self-hosted. Optional remote adapters must be replaceable.
- A certified IAB CMP or bundled Global Vendor List operation. A versioned TCF port may interoperate with an operator-selected implementation, but certification, registration, policy text, and transition operation remain outside core.
- A universal US-compliance switch. GPC and state signals are preserved and mapped through explicit operator policy because applicability, terms, and exceptions differ.
- Automatic deletion of all vendor data after withdrawal. OpenCookie can stop and re-block declared clients and clear declared browser storage, but cannot reverse data already received by a third party.
- Copying another product's presentation. OpenCookie uses its own visual and interaction design and avoids any vendor's copy, branding, geometry, structure, and trade dress.
