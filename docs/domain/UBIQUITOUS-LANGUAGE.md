# OpenCookie ubiquitous language

This vocabulary is normative for source, tests, API documentation, diagnostics, and user-facing technical documentation. OpenCookie records and enforces configured choices. It does not determine legal obligations or guarantee compliance.

## Four separate planes

OpenCookie must keep these concepts distinct:

1. **Consent plane:** an explicit visitor decision about configured purposes.
2. **Terminal-access plane:** operator-declared storage, reads, scripts, pixels, frames, and similar browser operations.
3. **Privacy-restriction plane:** raw signals such as GPC and the operator policy that maps them to restrictions.
4. **Effective-access plane:** the reason-coded result of combining policy, consent, restrictions, dependencies, service preferences, and time.

A declared exception, lawful-basis label, framework default, or privacy signal cannot create consent. A privacy restriction may only reduce effective access.

## Consent Decisioning

| Term | Definition | Excludes |
| --- | --- | --- |
| Consent | An explicit affirmative visitor decision for one or more configured purposes. It records what OpenCookie observed, not a legal conclusion. | Declared exceptions, GPC effects, implied browsing, preselected defaults. |
| Decision | The persisted value `granted` or `denied` for one atomic purpose. | `unresolved`, which is an evaluation state rather than a visitor decision. |
| Decision method | The origin `accept-all`, `reject-all`, `granular`, `withdrawal`, or `imported`. | `gpc-derived`; GPC does not manufacture a consent decision. |
| ConsentRecord | The aggregate containing only explicit purpose decisions, provenance, policy identity, time, and revision. | Service restrictions, DOM state, vendor protocol strings, receipt delivery state. |
| ConsentId | An optional first-party identifier for correlating an explicit record where the operator needs it. | A mandatory identifier or a cross-site identity. |
| RecordId | A local unique identity for one aggregate instance. | Proof that a person has a particular real-world identity. |
| ConsentEvaluation | Derived status: `first-visit`, `active`, `expired`, `invalid`, `withdrawn`, or `requires-reconsent`. | A persisted grant or denial. |
| DecisionDiff | A deterministic set of purpose transitions between two aggregate revisions. | Downstream service side effects. |
| Withdrawal | An explicit transition that resolves every optional purpose to denied, re-blocks future access, and invokes declared cleanup. | A claim that already transmitted data has been erased. |
| ReconsentPlan | Affected purposes, carried decisions, reasons, and current policy identity after a material policy change. | A blanket prompt for cosmetic edits. |

## Policy Catalogue

| Term | Definition | Invariant |
| --- | --- | --- |
| Purpose | The atomic unit presented for visitor choice. | Every optional purpose receives an explicit decision when saved. |
| Category | A navigational grouping of purposes. | Category selection expands to purpose decisions; a category is not proof itself. |
| PurposeDependency | A directed prerequisite used by effective-access evaluation. | The graph is acyclic and never silently rewrites the stored choice. |
| Service | A declared runtime integration referencing purposes, a vendor, terminal operations, and processing activities. | It declares honest start, stop, cleanup, and irreversible-effect capabilities. |
| Vendor | The operator-declared provider responsible for a service. | A stable identifier and required disclosure metadata are present. |
| TerminalOperation | A declared write, read, script, pixel, frame, SDK, or equivalent terminal action. | Optional operations remain blocked until their requirements resolve allowed. |
| ProcessingActivity | Operator-supplied metadata about downstream processing, recipients, data categories, retention, and claimed lawful basis. | Metadata does not create consent or determine legality. |
| DeclaredException | The operator's reasoned classification that a terminal operation is permitted without consent. | It is never represented as a granted decision. |
| PolicySnapshot | One immutable published catalogue used for evaluation. | All identifiers and references validate before publication. |
| PolicyVersion | Identity of consent-affecting semantics. | It changes only when informed-choice semantics change. |
| CatalogueRevision | Identity of the complete catalogue, including non-semantic presentation changes. | It changes for every published catalogue mutation. |
| CatalogueDigest | Canonical digest of the complete immutable snapshot. | Equal snapshots yield equal digests. |
| DecisionSurfaceDigest | Canonical digest of fields capable of changing an informed choice. | Cosmetic-only fields are excluded by schema, not free-text judgment at runtime. |
| PolicyChangeSet | A reason-coded diff with old and new identities plus affected, added, and removed purposes. | A policy-version bump with no affected purpose is invalid. |

## Privacy Preference Resolution

| Term | Definition |
| --- | --- |
| PrivacySignalObservation | A raw server or browser signal plus source, value, observation time, and navigation context. |
| GPC observation | The raw `Sec-GPC` or `navigator.globalPrivacyControl` value. It is preserved before interpretation. |
| Jurisdiction policy | Explicit operator configuration that maps raw observations and supplied context to restrictions. OpenCookie does not infer jurisdiction as a legal conclusion. |
| ProcessingRestriction | A reason-coded result of a jurisdiction policy. It can restrict effective access but cannot change ConsentRecord. |
| Signal conflict | A disagreement between observations, such as server enabled and client absent, retained for diagnostics. Enabled dominates absent or false for the current navigation under the default resolver. |

## Terminal Enforcement and signals

| Term | Definition |
| --- | --- |
| EffectiveAccessPlan | Immutable, reason-coded resolution for every declared service and resource. |
| Allowed-by-explicit-consent | Access allowed because all required purpose decisions are granted and no restriction blocks it. |
| Allowed-by-declared-exception | Access allowed because the operator explicitly classified the operation as an exception. No consent grant is synthesized. |
| Block reason | One of `first-visit`, `denied`, `withdrawn`, `expired`, `policy-change`, `purpose-dependency`, `service-preference`, `privacy-signal`, or `invalid-policy`. |
| ServicePreference | An optional visitor restriction on one service. It may narrow a purpose grant but cannot broaden it. |
| ServicePreferenceRecord | Restriction state owned by Terminal Enforcement and stored separately from ConsentRecord. |
| Reconciliation | Idempotently making runtime resources match an EffectiveAccessPlan after initialization, route changes, DOM insertion, or decisions. |
| Signal broadcaster | An outbound adapter translating complete effective state into Google Consent Mode, dataLayer, or another protocol. |
| Denied defaults | Signals established synchronously before optional tag activity. They are outbound protocol state, not ConsentRecord decisions. |
| TCF adapter | A versioned optional anti-corruption adapter outside core domain logic. It is not proof of certification or compliance. |

## Evidence and presentation

| Term | Definition |
| --- | --- |
| ConsentReceipt | A canonical, versioned, privacy-minimal projection of one committed transition. |
| Receipt sink | An optional idempotent destination for receipts. The core does not require a network service. |
| Receipt outbox | Bounded local delivery state used to retry an optional sink without changing consent effectiveness. |
| Consent surface | The banner, preferences dialog, or headless presentation of the current decision model. |
| Decision parity | Accept-all and reject-all cover the same purposes and require equal action count, reachability, latency, geometry, and visual weight. |
| Reset for testing | An explicit diagnostic operation that clears local test state. It is not withdrawal and creates no visitor-decision receipt. |

## Terms to reject in reviews

- `Compliant`, `GDPR compliant`, or `legal consent` as a product guarantee.
- `Essential consent`, because an exception classification is not a grant.
- `GPC consent` or `GPC withdrawal`, because GPC is a restriction input.
- `Cookie state` when the operation also covers local storage, pixels, SDKs, or frames.
- `Policy version` for cosmetic-only catalogue changes; use `CatalogueRevision`.
- `Load script` as the whole service lifecycle; use start, reconcile, stop, and cleanup.
