# OpenCookie context map

OpenCookie uses seven bounded contexts. Consent Decisioning is the core domain. Policy Catalogue, Privacy Preference Resolution, Terminal Enforcement, and Consent Evidence are supporting domains. Signal Broadcasting and Presentation are generic domains. Framework packages are adapters, not bounded contexts.

## Context responsibilities

| Bounded context               | Owns                                                                                                                                                       | Must not own                                                                                  | Research drivers                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Consent Decisioning           | ConsentRecord, explicit decisions, withdrawal, expiry, decision diff, reconsent evaluation, consent events.                                                | GPC interpretation, DOM, storage implementation, vendor protocol encoding, legal conclusions. | PP-09, PP-11, PP-13, PP-14, PP-15, PP-27. |
| Policy Catalogue              | Immutable policy snapshots, purposes, categories, services, vendors, terminal operations, disclosures, versions, digests, policy diffs.                    | Visitor decisions or runtime activation.                                                      | PP-13, PP-16, PP-28.                      |
| Privacy Preference Resolution | Raw privacy-signal observations and operator-configured mappings to processing restrictions.                                                               | Consent grants, automatic legal jurisdiction determination, universal compliance switches.    | PP-25, PP-27.                             |
| Terminal Enforcement          | Effective access plans, service-level restriction state, resource blocking, service lifecycle, storage cleanup declarations, route and DOM reconciliation. | Changing recorded purpose-consent choices.                                                    | PP-01, PP-02, PP-05, PP-08, PP-23, PP-29. |
| Signal Broadcasting           | Ordered translation of complete effective state to Google Consent Mode, dataLayer, and optional protocols.                                                 | Owning consent or policy state.                                                               | PP-03, PP-25, PP-26.                      |
| Consent Evidence              | Canonical receipts, idempotency, optional outbox, and sink delivery.                                                                                       | Mandatory remote storage, required identity, changing ConsentRecord.                          | PP-12, PP-24.                             |
| Presentation                  | Accessible interaction state, localized projections, equal choices, focus behavior, and semantic styling slots.                                            | Domain decisions, policy interpretation, vendor activation.                                   | PP-06, PP-17, PP-18, PP-19, PP-22.        |

## Relationships

```text
Operator configuration
        |
        v
Policy Catalogue -- PolicySnapshot ----------------> Consent Decisioning
        |                                                   |
        | ResourcePolicy                                    | ConsentTransition
        v                                                   v
Terminal Enforcement <---- ProcessingRestriction --- Privacy Preference Resolution
        ^                                                   ^
        |                                                   |
        +------------- EffectiveAccessPlan -----------------+
        |
        +----> Signal Broadcasting
        +----> Consent Evidence

Presentation ---- commands and queries ----> application facade
Browser or HTTP GPC ---- anti-corruption adapter ----> Privacy Preference Resolution
Google, dataLayer, TCF ---- versioned anti-corruption adapters <---- Signal Broadcasting
```

No bounded-context domain module imports another bounded-context internal module. Application code also reaches each domain context only through that context's `index.ts` entrypoint. Immutable published-language contracts cross boundaries through application ports. This preserves the distinction between explicit consent, configured terminal operations, external restrictions, and effective runtime behavior.

## Published language

| Producer                      | Contract                                                | Consumers                                                                  | Stability rule                                                             |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Policy Catalogue              | `PolicySnapshot`, `PolicyChangeSet`, `ResourcePolicy`   | Consent Decisioning, Terminal Enforcement, Presentation.                   | Immutable, schema-versioned, canonical digests.                            |
| Consent Decisioning           | `ConsentSnapshot`, `ConsentTransition`, `ReconsentPlan` | Terminal Enforcement, Signal Broadcasting, Consent Evidence, Presentation. | One aggregate revision yields one ordered transition batch.                |
| Privacy Preference Resolution | `ProcessingRestrictionSet`                              | Terminal Enforcement, Signal Broadcasting, Presentation.                   | Restrictions can only narrow access and include reason codes.              |
| Terminal Enforcement          | `EffectiveAccessPlan`, `EnforcementTransition`          | Signal Broadcasting, Consent Evidence, diagnostics.                        | Complete snapshot, deterministic ordering, idempotent transition identity. |
| Consent Evidence              | `ReceiptDeliveryStatus`                                 | Diagnostics and operator tooling.                                          | Never feeds back into consent effectiveness.                               |

## Conformist and anti-corruption relationships

- Presentation conforms to the application facade's command and query contracts. It never reconstructs domain decisions from UI state.
- Framework adapters conform to `@opencookie-dev/core` public application contracts. They cannot import another framework package or core internals.
- Browser storage, DOM, clocks, identifiers, broadcasters, and sinks implement outbound ports owned by the application layer.
- Google Consent Mode, dataLayer, TCF, and future vendor protocols use anti-corruption adapters so their fields and version churn do not enter the Consent Decisioning model.
- Server and client GPC inputs use anti-corruption adapters that preserve raw observations before the operator jurisdiction policy resolves restrictions.
- Scanner findings, when supported, enter through a provenance-bearing import boundary. They never become authoritative Policy Catalogue truth automatically.

## Layer and package rules

Dependencies point inward:

```text
domain/shared                         -> no OpenCookie layer
domain/<bounded-context>              -> domain/shared only
application                           -> public domain contracts and application ports
infrastructure                        -> application ports and public domain value contracts
presentation                          -> application facade only
framework and runtime packages        -> @opencookie-dev/core public API only
```

Additional fitness rules:

1. Domain and application code cannot reference browser globals, framework packages, CSS, locales, storage implementations, or vendor globals.
2. No context imports another context's internal files.
3. Application code imports a domain context only through its named `index.ts` entrypoint.
4. Cross-context data is immutable and exported through a named contracts entrypoint.
5. Framework packages cannot import each other or any `src/**` path from another package.
6. Consent domain code cannot contain Google field names, a TCF encoder, GPC jurisdiction rules, receipt sinks, or DOM types.
7. Adapters contain lifecycle glue only. Domain logic duplicated outside core is an architecture violation.

## Framework placement

`@opencookie-dev/vanilla`, React, Vue, Svelte, Next, Nuxt, and Astro packages adapt host lifecycle and rendering to one core application facade. The unscoped CLI modifies consumer projects but does not own consent rules. A future backend receipt service implements Consent Evidence ports outside `@opencookie-dev/core`.
