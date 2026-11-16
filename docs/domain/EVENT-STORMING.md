# OpenCookie event-storming model

This event-storming pass turns the Phase 1 evidence into commands, events, policies, aggregates, read models, and hotspots. Event names are past tense. Application and integration events are kept separate from domain events.

## Actors and external systems

| Actor or system | Goal or role |
| --- | --- |
| Visitor | Make, inspect, revise, reject, or withdraw an explicit purpose-level decision. |
| Operator | Publish a valid policy catalogue, configure jurisdiction mappings, and declare service lifecycle behavior. |
| Browser runtime | Supply storage, time, DOM, navigation, and privacy-signal observations through adapters. |
| Framework adapter | Bind host rendering and lifecycle to the core application facade. |
| Google, dataLayer, or protocol consumer | Receive ordered translations of effective state. |
| Optional receipt sink | Accept canonical idempotent transition evidence without controlling consent effectiveness. |

## Aggregates

### ConsentRecord

Candidate fields:

- `recordId`, `schemaVersion`, and monotonic `revision`.
- Optional first-party `consentId`.
- `policyVersion`, `catalogueDigest`, and `decisionSurfaceDigest`.
- Complete purpose decisions. Service restrictions are stored separately by Terminal Enforcement.
- Decision method, locale, decision time, and expiry time.

Invariants:

1. Only explicit visitor action or validated migration creates a grant.
2. Every saved decision covers every optional purpose; omitted granular choices become denied.
3. Accept-all and reject-all operate over the same purpose set.
4. Withdrawal creates resolved denial and does not immediately re-prompt.
5. Unknown purpose IDs, malformed values, future times, invalid intervals, or mismatched identities fail closed.
6. A grant becomes effective only after configured local storage confirms write and readback.
7. Rejection and withdrawal become effective even if persistence fails and return a degraded diagnostic.
8. One revision emits one deterministic event batch; subscribers cannot interleave or reenter the active transition.

### PolicyCatalogue

Invariants:

1. Published snapshots are immutable and all identifiers are unique.
2. Category and purpose-dependency graphs are acyclic.
3. Every reference resolves and every optional resource names a decision requirement.
4. Required provider, purpose, operation, data-category, duration, and retention disclosures are complete.
5. Every declared exception includes a reason and never becomes a consent grant.
6. Every service declares start, stop, cleanup, and irreversible-effect capabilities honestly.
7. `CatalogueRevision` changes for every mutation. `PolicyVersion` changes only for consent-affecting semantics.
8. A policy-version bump with no affected purpose is invalid.

### PrivacyPolicy

This aggregate owns operator-supplied mappings from raw privacy observations and supplied context to restrictions. It cannot create or modify ConsentRecord.

## Event streams

### Stream A: first navigation

| Order | Type | Name | Owner | Notes |
| --- | --- | --- | --- | --- |
| 1 | Command | `EstablishDeniedDefaults` | Signal Broadcasting application service | Runs synchronously before optional tags. |
| 2 | Integration event | `DeniedSignalDefaultsEstablished` | Signal Broadcasting | Not a consent decision. |
| 3 | Command | `LoadPolicySnapshot` | Policy Catalogue | Returns one immutable snapshot. |
| 4 | Command | `ObservePrivacySignals` | Privacy Preference Resolution | Captures server and client raw state. |
| 5 | Domain event | `PrivacySignalObserved` | Privacy Preference Resolution | Includes origin and navigation context. |
| 6 | Command | `RestoreConsent` | Consent Decisioning | Reads through a defensive DecisionStore port. |
| 7 | Domain event | `ConsentRestored`, `ConsentInvalidated`, or `ConsentExpired` | Consent Decisioning | Missing state remains first visit rather than an error. |
| 8 | Policy | Resolve restrictions and effective access | Application | Privacy restrictions can only reduce access. |
| 9 | Read model | `ConsentSurfaceModel` | Presentation | Shows prompt only when evaluation requires it. |
| 10 | Integration event | `ConsentRuntimeReady` | Application | Emitted once after restoration or unresolved evaluation. |

### Stream B: accept-all or granular grant

| Order | Type | Name | Rule |
| --- | --- | --- | --- |
| 1 | Command | `RecordDecision` | Validates current immutable policy and complete selection. |
| 2 | Domain event candidate | `ConsentGranted` or `ConsentChanged` | Contains a deterministic purpose diff. |
| 3 | Policy | Confirm persistence | Candidate state is written and read back before a grant commits. |
| 4 | Domain event | `ConsentRecordCreated`, `ConsentGranted`, or `ConsentChanged` | One committed revision. |
| 5 | Command | `PublishSignalUpdate` | Sends the complete effective snapshot as one serialized transition. |
| 6 | Command | `ReconcileDeclaredResources` | Starts only newly allowed services and resources. |
| 7 | Integration event | `EffectiveAccessPlanChanged` | Contains stable reason-coded differences. |
| 8 | Policy | Create receipt | Projects the committed transition into a minimal canonical receipt. |
| 9 | Integration event | `ReceiptCreated` | Optional delivery cannot reverse the grant after local confirmation. |

If write-readback fails, optional access remains blocked and the command returns `grant-persistence-unconfirmed`.

### Stream C: reject-all

1. Visitor issues `RecordRejectAll`.
2. ConsentRecord resolves every optional purpose to denied.
3. `ConsentDenied` commits in memory immediately.
4. Denied outbound signals publish before any service reconciliation.
5. Terminal Enforcement stops and blocks optional services.
6. Persistence is attempted; failure is diagnostic rather than permission to run.
7. `ReceiptCreated` records normal or degraded persistence status.

### Stream D: withdrawal

1. Visitor issues `WithdrawConsent` through a continuously available preference surface or headless API.
2. ConsentRecord computes the granted-to-denied diff.
3. New resource discovery is blocked immediately.
4. Outbound effective signals update to denied.
5. Declared service stop and cleanup operations run idempotently.
6. `ConsentWithdrawn` commits and a minimal receipt is projected.
7. Diagnostics disclose declared irreversible effects rather than claiming past requests were undone.

### Stream E: policy publication and reconsent

1. Operator issues `PublishPolicy` with a candidate catalogue.
2. PolicyCatalogue validates graphs, references, disclosures, revisions, and digests.
3. `PolicyPublished` and, when semantics changed, `PolicyVersionSuperseded` occur.
4. Application captures a bounded, current-inclusive history of identity-verified PolicySnapshots.
5. `ReconcilePolicy` matches the existing ConsentRecord to that history and derives the `PolicyChangeSet` with affected, added, and removed purposes plus reason codes.
6. Unaffected decisions carry forward. Existing denials remain denied. Affected grants become unresolved and blocked.
7. `ReconsentRequired` identifies only affected purposes.
8. Cosmetic revisions produce `CatalogueRevisionPublished` without a prompt.

Material changes include new optional purposes or providers, changed purpose meaning or dependencies, changed terminal operations or processing activities, broader scope, or changed provider, recipient, data-category, duration, retention, or meaningful localized disclosure. Free-text changes default to material unless the schema records an editorial-only field and reason.

### Stream F: GPC observation

1. Server or browser adapter issues `ObservePrivacySignal` with raw state.
2. `PrivacySignalObserved` preserves source and context.
3. Enabled dominates absent or false for the current navigation under the default resolver.
4. Operator-supplied jurisdiction policy produces `PrivacyRestrictionsResolved`.
5. Restrictions overlay EffectiveAccessPlan and can only narrow it.
6. ConsentRecord remains unchanged.
7. Removing a transient restriction recomputes access from the unchanged explicit decision.

## Commands and owners

| Command | Owner | Result |
| --- | --- | --- |
| `InitializeConsent` | Application | Ready snapshot or reason-coded failure. |
| `RestoreConsent` | Consent Decisioning | ConsentEvaluation and optional restored transition. |
| `RecordAcceptAll` | Consent Decisioning | Complete granted purpose map. |
| `RecordRejectAll` | Consent Decisioning | Complete denied purpose map. |
| `RecordGranularDecision` | Consent Decisioning | Complete map with omissions denied. |
| `WithdrawConsent` | Consent Decisioning | Denied revision and purpose diff. |
| `EvaluateConsent` | Consent Decisioning | Pure evaluation at an injected instant. |
| `PublishPolicy` | Policy Catalogue | Immutable validated snapshot; operator previews may derive a change set. |
| `ReconcilePolicy` | Application | Identity-matched, runtime-derived ConsentPolicyReconciliation and effective-state change. |
| `ObservePrivacySignal` | Privacy Preference Resolution | Raw observation and restrictions. |
| `ResolveEffectiveAccess` | Application domain service | Complete reason-coded EffectiveAccessPlan. |
| `ReconcileDeclaredResources` | Terminal Enforcement | Idempotent start, stop, cleanup, and block operations. |
| `ReopenPreferences` | Presentation application service | Current ConsentSurfaceModel. |
| `InspectConsent` | Application query | Read-only diagnostics without hidden identity. |
| `SubscribeToTransitions` | Application | Ordered, non-reentrant immutable stream. |
| `ResetConsentForTesting` | Test facility | Clears fixture state without creating a visitor receipt. |
| `FlushReceiptOutbox` | Consent Evidence | Bounded idempotent delivery attempt. |

## Domain events by context

| Context | Domain events |
| --- | --- |
| Policy Catalogue | `PolicyPublished`, `PolicyVersionSuperseded`, `CatalogueRevisionPublished`. |
| Consent Decisioning | `ConsentRecordCreated`, `ConsentGranted`, `ConsentDenied`, `ConsentChanged`, `ConsentWithdrawn`, `ConsentExpired`, `ConsentInvalidated`, `ReconsentRequired`, `ConsentRestored`. |
| Privacy Preference Resolution | `PrivacySignalObserved`, `PrivacyRestrictionsResolved`, `PrivacySignalConflictDetected`. |

`DeniedSignalDefaultsEstablished`, `SignalUpdatePublished`, `EffectiveAccessPlanChanged`, `ServiceStarted`, `ServiceStopped`, `ReceiptCreated`, `ReceiptDeliveryDeferred`, `ReceiptDelivered`, and `ConsentRuntimeReady` are application or integration events, not Consent Decisioning events.

## Ports revealed by the storms

Inbound ports: `ConsentCommands`, `ConsentQueries`, `ConsentSubscriptions`, `PolicyCommands`, `RuntimeLifecycle`, and `PrivacySignalInput`.

Outbound ports: `Clock`, `IdGenerator`, `DecisionStore`, `ReceiptSink`, `ReceiptOutbox`, `SignalBroadcaster`, `ServiceController`, `BlockedResourceRegistry`, `DeclaredStorageCleaner`, and `DiagnosticSink`.

DecisionStore returns structured parse, duplicate, write, readback, and conflict results instead of reducing all failures to `null`. Broadcasters consume an immutable complete snapshot and transition ID. A broadcaster failure blocks dependent optional activation.

## Hotspots resolved by ADR

| Hotspot | Resolution | Trace |
| --- | --- | --- |
| Does an essential classification count as consent? | No. It can yield allowed-by-declared-exception but never a grant. | TEST-ESSENTIAL-IS-NOT-GRANT. |
| Is Category the atomic decision? | No. Purpose is atomic; categories are presentation groups. | TEST-ACCEPT-ALL-PURPOSE-SET. |
| Does every catalogue edit re-prompt? | No. PolicyVersion and CatalogueRevision are separate. | TEST-POLICY-DIFF-REPROMPT. |
| Can a failed browser write permit a grant? | No. Grants require readback; denial remains effective on failure. | TEST-GRANT-REQUIRES-READBACK. |
| Does receipt delivery control consent? | No. Receipt is a projection with optional delivery. | TEST-CONSENT-PROOF-MINIMAL. |
| Can contexts import one another's internals? | No. They exchange immutable published-language contracts through application ports. | TEST-ARCH-CONTEXT-BOUNDARIES. |
| Does GPC become reject-all? | No. It remains a raw signal resolved to a restrictive overlay. | TEST-GPC-DOES-NOT-MUTATE-CONSENT. |
