# OpenCookie independent research

Research date: 2026-08-22

## Method and limits

This review used primary legislation, regulator and court publications, standards, browser documentation, maintained project repositories, issue trackers, developer questions, vendor support forums, and current pricing pages. Issue reports establish real integration pain, not universal product defects. Vendor pages establish documented behavior or pricing, not independent quality or legal compliance.

OpenCookie is a technical tool. This research is not legal advice, and no feature can by itself make a site compliant. Operators remain responsible for legal basis, catalogue accuracy, disclosures, jurisdiction rules, retention, and deployed behavior.

Prices are snapshots and may change. TCF is especially time-sensitive: v2.3 became mandatory for newly created TC Strings on 2026-03-01, while v2.4 was published on 2026-07-23 with a web CMP transition deadline of 2026-10-23. A static v2.2 implementation would already be stale.

The current W3C Global Privacy Control document is a Working Draft. It may change and is not endorsed as a W3C Recommendation. Its technical shape and jurisdiction mappings require a fresh check before release.

## Market map

| Tool or family | Model | Current evidence | Repeated friction |
| --- | --- | --- | --- |
| Klaro | Open source plus services | Active issue traffic in 2026 | SPA reconciliation, GTM ordering, accessibility naming, and a comparatively large full payload. |
| vanilla-cookieconsent | Open source | Active v3 issue traffic in 2026 | Focus timing, Astro transitions, GPC precedence, subdomain scope, proof logging, and dynamic scripts. |
| Osano CookieConsent | Open source counterpart to commercial CMP | Repository remains public; old accessibility repairs remain open | SSR import safety, framework lifecycle, enforcement left to callbacks, and incomplete backend/proof story. |
| Cookiebot and Usercentrics | Commercial SaaS | Current support and pricing | Hydration failures, heuristic blocking, scanner uncertainty, remote availability, session and domain pricing. |
| OneTrust | Commercial SaaS | Current integration traffic | CSP, persistence diagnostics, auto-blocking of framework and checkout code, opaque setup. |
| Didomi | Commercial SaaS | Current support material | Boot order and configuration states can suppress the notice. |
| iubenda | Commercial SaaS | Current support and 2026 pricing | Initialization ordering, synchronous boot cost, persistence configuration, metered proof storage. |
| Termly | Commercial SaaS | Current support and pricing | Performance, optimizer conflicts, JSX integration, preference reopening, unstable generated selectors. |
| consentmanager | Commercial SaaS and plugin | Current plugin and pricing | Automatic blocking can break payments; page-view, TCF, white-label, and self-hosting feature gates. |

## Cross-cutting findings

1. A banner is not enforcement. Several tools render consent UI while optional trackers still execute unless the operator adds correct callbacks or markup.
2. Heuristic auto-blocking creates a second failure mode: it can stop framework runtimes, checkout inputs, or payment buttons.
3. A tiny synchronous denied bootstrap and a deferred UI are different responsibilities. Bundling them together hurts FCP, CLS, and deploy safety.
4. Framework-neutral DOM mutation is brittle around SSR, hydration, body replacement, client routing, and View Transitions.
5. Browser storage is a fallible cache. Safari can delete script-writable state, cookies can have the wrong domain, and private or opaque contexts can reject writes.
6. Equal button geometry is necessary but insufficient. Information quality, action count, keyboard order, focus, target size, and withdrawal access also matter.
7. Consent receipts and interoperability strings can themselves be personal data. Proof should be minimal, versioned, access-controlled, and optional.
8. Scanning is evidence collection, not an exhaustive compliance oracle. Classification and live before/after browser assertions remain necessary.
9. Hosted pricing and remote delivery can make consent behavior depend on traffic, domains, page counts, billing, and cache state.
10. Standards change. Google signals, GPC effects, TCF protocols, and state-law mappings belong behind versioned ports rather than in the core aggregate.

## Regulatory engineering boundary

- Terminal access, subsequent personal-data processing, user choice, and outbound vendor signals are separate concepts.
- Consent is one possible GDPR lawful basis, not the universal basis for every processing operation.
- Optional terminal access begins blocked unless the operator explicitly and audibly classifies an exception.
- Rejection, granular choice, and withdrawal are first-class decisions, not UI side paths.
- The receipt proves what the configured tool observed. It does not prove that every undeclared script was blocked or that the operator's legal analysis was correct.
- GPC is preserved as a raw browser or HTTP signal. A configurable policy resolves its operational effect by jurisdiction and context.
- Full IAB CMP certification, legal text generation, and authoritative scanning are outside the core library.

## Source catalogue

### SRC-001: Regulation EU 2016/679, GDPR

- URL: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
- Publisher: European Union, EUR-Lex
- Accessed: 2026-08-22
- Evidence: Articles 6 and 7 separate lawful bases, require demonstrable and clearly requested consent, and require withdrawal to remain available as easily as consent was given.

### SRC-002: ePrivacy Directive consolidated text

- URL: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02002L0058-20091219
- Publisher: European Union, EUR-Lex
- Accessed: 2026-08-22
- Evidence: Article 5(3) covers storing information in or accessing information from terminal equipment, not only cookies or personal data, subject to narrow transmission and requested-service exceptions.

### SRC-003: Section 25 TDDDG

- URL: https://www.gesetze-im-internet.de/ttdsg/__25.html
- Publisher: German Federal Ministry of Justice and Federal Office of Justice
- Accessed: 2026-08-22
- Evidence: German law requires informed consent for terminal storage or access unless a transmission or strictly necessary requested-service exception applies.

### SRC-004: EDPB Guidelines 05/2020 on consent

- URL: https://www.edpb.europa.eu/documents/guideline/guidelines-052020-on-consent-under-regulation-2016679_en
- Publisher: European Data Protection Board
- Accessed: 2026-08-22
- Evidence: Consent requires real choice, purpose granularity, affirmative action, no detriment for refusal, comparable withdrawal, and renewed choice after material changes.

### SRC-005: EDPB Cookie Banner Taskforce report

- URL: https://www.edpb.europa.eu/documents/task-force-report/report-of-the-work-undertaken-by-the-cookie-banner-taskforce_en
- Publisher: European Data Protection Board
- Accessed: 2026-08-22
- Evidence: The report addresses pre-consent cookies, pre-ticked choices, missing reject paths, misleading presentation, strictly necessary classification, and accessible withdrawal while noting some national divergence.

### SRC-006: EDPB deceptive design guidelines

- URL: https://www.edpb.europa.eu/documents/guideline/guidelines-032022-on-deceptive-design-patterns-in-social-media-platform_en
- Publisher: European Data Protection Board
- Accessed: 2026-08-22
- Evidence: The EDPB identifies overloading, skipping, stirring, obstruction, fickle interfaces, and leaving users in the dark as deceptive patterns relevant as a broader design lens.

### SRC-007: German DSK guidance for telemedia providers

- URL: https://www.datenschutzkonferenz-online.de/media/oh/20221205_oh_Telemedien_2021_Version_1_1_Vorlage_104_DSK_final.pdf
- Publisher: German Data Protection Conference
- Accessed: 2026-08-22
- Evidence: The guidance separates terminal access from later processing, expects a comparable visible rejection path, discusses minimal consent proof, and links meaningful catalogue changes to renewed choice.

### SRC-008: CJEU Planet49 judgment

- URL: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62017CJ0673
- Publisher: Court of Justice of the European Union, EUR-Lex
- Accessed: 2026-08-22
- Evidence: A preselected checkbox is not valid consent, terminal access rules apply regardless of personal-data status, and disclosure includes duration and third-party access.

### SRC-009: German Federal Court Cookie Consent II judgment

- URL: https://www.bundesgerichtshof.de/SharedDocs/Entscheidungen/DE/Zivilsenate/I_ZS/2016/I_ZR___7-16A.pdf?__blob=publicationFile&v=1
- Publisher: German Federal Court of Justice
- Accessed: 2026-08-22
- Evidence: The court applied Planet49 nationally and rejected a preselected advertising and market-research cookie choice under the earlier German framework.

### SRC-010: CJEU IAB Europe judgment

- URL: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62022CJ0604
- Publisher: Court of Justice of the European Union, EUR-Lex
- Accessed: 2026-08-22
- Evidence: A TC String can be personal data when reasonably associated with an identifier, and controller responsibility depends on the particular processing operation.

### SRC-011: CNIL decision SAN-2025-004

- URL: https://www.legifrance.gouv.fr/cnil/id/CNILTEXT000052182222
- Publisher: CNIL via Legifrance
- Accessed: 2026-08-22
- Evidence: CNIL found that making refusal harder and failing to explain personalized-advertising consequences invalidated the inspected choice flow; button parity alone did not cure information defects.

### SRC-012: Google Consent Mode overview

- URL: https://developers.google.com/tag-platform/security/concepts/consent-mode
- Publisher: Google for Developers
- Accessed: 2026-08-22
- Evidence: Basic mode prevents Google tags from loading before interaction, while advanced mode can load tags and transmit cookieless measurements under denied defaults.

### SRC-013: Google Consent Mode implementation guide

- URL: https://developers.google.com/tag-platform/security/guides/consent
- Publisher: Google for Developers
- Accessed: 2026-08-22
- Evidence: Consent Mode v2 has four dimensions, requires defaults before measurement commands, updates after decisions, and separate persistence because Consent Mode does not store the choice.

### SRC-014: IAB TCF v2.2 implementation guidelines

- URL: https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/TCF-Implementation-Guidelines.md
- Publisher: IAB Europe and IAB Tech Lab
- Accessed: 2026-08-22
- Evidence: Historical v2.2 guidance changed purpose text, retention disclosures, legal-basis rules, data categories, and event-driven access to consent state.

### SRC-015: IAB transition to TCF v2.3

- URL: https://iabeurope.eu/all-you-need-to-know-about-the-transition-to-tcf-v2-3/
- Publisher: IAB Europe
- Accessed: 2026-08-22
- Evidence: Newly created TC Strings had to comply with v2.3 from 2026-03-01, making a new v2.2-only implementation operationally stale.

### SRC-016: IAB TCF v2.4 confirmed timeline

- URL: https://iabeurope.eu/wp-content/uploads/TCF_V-CMP_comms_TCFpoliciesV5.0.bAndSpecificationsV2.4ConfirmationOf-theTimeline_160726_IABEurope.pdf
- Publisher: IAB Europe
- Accessed: 2026-08-22
- Evidence: TCF v2.4 was published on 2026-07-23 with web CMP adoption scheduled for 2026-10-23 and later mobile and CTV deadlines.

### SRC-017: IAB Europe TCF policies

- URL: https://iabeurope.eu/iab-europe-transparency-consent-framework-policies/
- Publisher: IAB Europe
- Accessed: 2026-08-22
- Evidence: Current policies require participant-specific disclosure and granular choice and state that framework participation does not replace each participant's own legal obligations.

### SRC-018: W3C Global Privacy Control Working Draft

- URL: https://www.w3.org/TR/gpc/
- Publisher: World Wide Web Consortium
- Accessed: 2026-08-22
- Evidence: The current Working Draft defines Sec-GPC and navigator.globalPrivacyControl for a do-not-sell-or-share preference whose legal effect depends on jurisdiction and context; it may change and is not W3C-endorsed as a Recommendation.

### SRC-019: California Department of Justice GPC guidance

- URL: https://oag.ca.gov/privacy/ccpa/gpc
- Publisher: California Department of Justice
- Accessed: 2026-08-22
- Evidence: Covered businesses that sell or share personal information online must treat a user-enabled GPC signal as a valid opt-out request under California law.

### SRC-020: California CCPA regulations Section 7025

- URL: https://cppa.ca.gov/regulations/pdf/20230329_final_regs_text.pdf
- Publisher: California Privacy Protection Agency
- Accessed: 2026-08-22
- Evidence: Recognized opt-out signals can use headers or JavaScript, cannot require extra identity data first, and are distinct from a cookie-consent banner.

### SRC-021: Colorado Universal Opt-Out Mechanism

- URL: https://coag.gov/opt-out/
- Publisher: Colorado Attorney General
- Accessed: 2026-08-22
- Evidence: Colorado recognizes GPC for applicable sale and targeted-advertising opt-outs while using state-specific scope and terminology.

### SRC-022: Tracking Prevention in WebKit

- URL: https://webkit.org/tracking-prevention/
- Publisher: WebKit
- Accessed: 2026-08-22
- Evidence: Safari blocks third-party cookies and can remove script-created cookies, local storage, IndexedDB, service-worker data, and related state after interaction-based limits.

### SRC-023: Full third-party cookie blocking in WebKit

- URL: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Publisher: WebKit
- Accessed: 2026-08-22
- Evidence: WebKit documents full third-party cookie blocking and the script-writable storage categories affected by its seven-day no-interaction behavior.

### SRC-024: Content Security Policy Level 3

- URL: https://www.w3.org/TR/CSP3/
- Publisher: World Wide Web Consortium
- Accessed: 2026-08-22
- Evidence: Nonce sources authorize matching scripts, require fresh cryptographically strong values per policy, and interact with strict-dynamic trust propagation.

### SRC-025: HTML nonce attributes

- URL: https://html.spec.whatwg.org/multipage/urls-and-fetching.html#nonce-attributes
- Publisher: WHATWG
- Accessed: 2026-08-22
- Evidence: Browsers keep nonce state in an internal slot exposed through the element nonce property, so generic attribute cloning is insufficient for script activation.

### SRC-026: Web Content Accessibility Guidelines 2.2

- URL: https://www.w3.org/TR/WCAG22/
- Publisher: World Wide Web Consortium
- Accessed: 2026-08-22
- Evidence: Relevant AA criteria address keyboard operation, traps, contrast, focus visibility and obscuring, accessible names, and minimum target size subject to exceptions.

### SRC-027: ARIA modal dialog pattern

- URL: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- Publisher: W3C Web Accessibility Initiative
- Accessed: 2026-08-22
- Evidence: A modal moves focus inside, contains Tab navigation, supports Escape, restores focus, and exposes dialog semantics and an accessible name.

### SRC-028: Media Queries Level 5

- URL: https://www.w3.org/TR/mediaqueries-5/
- Publisher: World Wide Web Consortium
- Accessed: 2026-08-22
- Evidence: The specification defines reduced-motion, color-scheme, contrast, and forced-colors-related user preferences suitable for CSS-only adaptation.

### SRC-029: Klaro Next.js route reconciliation issue

- URL: https://github.com/kiprotect/klaro/issues/552
- Publisher: Klaro GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: A reported Next.js client navigation inserts a gated iframe after initialization and repeated setup attempts do not reliably reprocess it.

### SRC-030: Klaro GTM ordering race

- URL: https://github.com/kiprotect/klaro/issues/564
- Publisher: Klaro GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: A reported custom acceptance event can precede Google consent-state updates, allowing tag consumers to observe the wrong phase.

### SRC-031: Klaro project payload documentation

- URL: https://github.com/kiprotect/klaro/blob/master/README.md
- Publisher: Klaro project
- Accessed: 2026-08-22
- Evidence: The project reports roughly 57 kB minified and gzipped for its full build with styles and translations, motivating independently enforced size budgets.

### SRC-032: vanilla-cookieconsent focus trap issue

- URL: https://github.com/orestbida/cookieconsent/issues/828
- Publisher: vanilla-cookieconsent GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: A deterministic cross-browser report shows Shift+Tab escaping a newly opened preferences modal because delayed focus lands on a non-tabbable container.

### SRC-033: vanilla-cookieconsent Astro View Transitions issue

- URL: https://github.com/orestbida/cookieconsent/issues/814
- Publisher: vanilla-cookieconsent GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: Astro body replacement can remove the banner or preserve controls with dead listeners, exposing lifecycle coupling to ambient DOM ownership.

### SRC-034: vanilla-cookieconsent cookie domain issue

- URL: https://github.com/orestbida/cookieconsent/issues/793
- Publisher: vanilla-cookieconsent GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: The report requests host-only cookie support because setting Domain can unintentionally share consent state across subdomains.

### SRC-035: vanilla-cookieconsent proof logging discussion

- URL: https://github.com/orestbida/cookieconsent/discussions/616
- Publisher: vanilla-cookieconsent GitHub discussions
- Accessed: 2026-08-22
- Evidence: Operators ask how to retain proof of consent and host the required API, illustrating the missing receipt story in lightweight UI libraries.

### SRC-036: vanilla-cookieconsent dynamic script issue

- URL: https://github.com/orestbida/cookieconsent/issues/101
- Publisher: vanilla-cookieconsent GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: Consent-tagged scripts introduced by dynamic content are not automatically activated, requiring a discover and reconcile lifecycle.

### SRC-037: Osano CookieConsent Next.js SSR question

- URL: https://stackoverflow.com/questions/67484131/how-to-do-you-implement-osano-cookieconsent-in-nextjs
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: Importing the package in Next.js raises window-is-not-defined and leads users to a client-only dynamic-import workaround with SSR disabled.

### SRC-038: Consent UI that does not block trackers

- URL: https://stackoverflow.com/questions/58992414/gdpr-cookie-compliance-javascript-callbacks
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: A developer expected a popup to block cookies but all trackers still loaded because enforcement was delegated to custom callbacks.

### SRC-039: Cookiebot Next.js hydration failure

- URL: https://stackoverflow.com/questions/78394478/cookiebot-script-causes-hydration-error-in-nextjs
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: Cookiebot inserts a node before hydration and causes a server-client mismatch and client-render fallback in the unanswered state.

### SRC-040: Cookiebot auto-blocking breaks Next.js runtime

- URL: https://stackoverflow.com/questions/66701347/nextjs-cookiebot-cookiebot-script-with-data-blockingmode-auto-is-preventing-t
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: Heuristic auto-blocking catches framework runtime scripts and prevents the application from loading before a decision.

### SRC-041: Usercentrics scanner completeness caveat

- URL: https://support.usercentrics.com/hc/en-us/articles/17254585584412-Why-does-the-scan-indicate-negative-results-eventhough-the-Usercentrics-Cookiebot-CMP-has-been-installed
- Publisher: Usercentrics support
- Accessed: 2026-08-22
- Evidence: The support article acknowledges that audit results may be incomplete, carry no accuracy right, and cannot by themselves establish compliance.

### SRC-042: OneTrust CSP failure

- URL: https://stackoverflow.com/questions/67331585/onetrust-not-working-error-message-in-console
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: A production banner disappears because the site's Content Security Policy blocks the remotely served CMP script.

### SRC-043: OneTrust auto-blocking breaks Angular runtime

- URL: https://stackoverflow.com/questions/66803381/integrating-onetrust-cookie-consent-banner-with-angular-9
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: Auto-blocking catches required Zone.js code and leaves the application broken until acceptance plus a refresh.

### SRC-044: iubenda consent event race

- URL: https://github.com/iubenda/gtm-cookie-solution/issues/7
- Publisher: iubenda GTM integration issue tracker
- Accessed: 2026-08-22
- Evidence: A custom event can run before the integration establishes actual consent state because initialization occurs too late.

### SRC-045: Termly performance report

- URL: https://wordpress.org/support/topic/page-speed-performance-gets-reduced-based-of-this-termly-plugin/
- Publisher: WordPress support forum
- Accessed: 2026-08-22
- Evidence: A user reports materially lower PageSpeed results with the plugin, and the vendor recommends replacing the plugin with manual script installation.

### SRC-046: Didomi notice suppression troubleshooting

- URL: https://support.didomi.io/my-consent-notice-is-not-showing-or-is-incorrect-on-my-website
- Publisher: Didomi support
- Accessed: 2026-08-22
- Evidence: Missing embeds, targeting, partner-purpose links, publication state, local overrides, or translations can each suppress or alter the notice.

### SRC-047: consentmanager payment integration failure

- URL: https://wordpress.org/support/topic/front-end-issue-with-payment-plugins/
- Publisher: WordPress support forum
- Accessed: 2026-08-22
- Evidence: Automatic blocking is reported to break payment inputs and payment-provider buttons, turning a consent mechanism into a checkout outage.

### SRC-048: Usercentrics pricing

- URL: https://usercentrics.com/pricing/
- Publisher: Usercentrics
- Accessed: 2026-08-22
- Evidence: Plans are metered by sessions, domains, regulations, languages, and features, with cross-domain sharing, TCF, and branding controls gated by tier.

### SRC-049: Cookiebot pricing

- URL: https://www.cookiebot.com/us/pricing/
- Publisher: Cookiebot
- Accessed: 2026-08-22
- Evidence: Pricing depends on scanned subpage count and separately billed domains, creating coupling between scanning results and operating cost.

### SRC-050: Osano CookieConsent open-source scope

- URL: https://github.com/osano/cookieconsent
- Publisher: Osano CookieConsent project
- Accessed: 2026-08-22
- Evidence: The project explains that open-source users must supply GeoIP, service callbacks, script loading, and database logging that hosted products can provide.

### SRC-051: iubenda pricing and deactivation history

- URL: https://www.iubenda.com/en/blog/introducing-new-and-simplified-pricing-structure/
- Publisher: iubenda
- Accessed: 2026-08-22
- Evidence: The vendor describes extra-usage charging and notes that earlier plan limits could deactivate cookie blocking, while consent storage remains separately priced.

### SRC-052: consentmanager self-hosting feature matrix

- URL: https://www.consentmanager.net/en/features/
- Publisher: consentmanager
- Accessed: 2026-08-22
- Evidence: Serving the CMP through a customer's own domain is reserved for an enterprise tier, illustrating remote-runtime and first-party-hosting lock-in.

### SRC-053: vanilla-cookieconsent GPC precedence request

- URL: https://github.com/orestbida/cookieconsent/issues/811
- Publisher: vanilla-cookieconsent GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: The issue requests native GPC handling and a defined precedence between a browser signal and an explicit site decision.

### SRC-054: vanilla-cookieconsent automation behavior issue

- URL: https://github.com/orestbida/cookieconsent/issues/635
- Publisher: vanilla-cookieconsent GitHub issue tracker
- Accessed: 2026-08-22
- Evidence: Programmatic modal calls fail or behave differently in a framework service, while bot and WebDriver suppression complicate deterministic E2E testing.

### SRC-055: OneTrust local testing friction

- URL: https://stackoverflow.com/questions/74653743/how-to-test-onetrust-cookie-banners-in-localhost
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: Local testing requires hosts-file and TLS proxy changes to mimic a configured production-style domain.

### SRC-056: Termly JSX integration friction

- URL: https://stackoverflow.com/questions/75503853/how-to-get-script-from-termly-to-run-in-jsx-on-nextjs
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: Vendor HTML does not map cleanly into JSX and a working TypeScript example requires suppressing a type error.

### SRC-057: consentmanager pricing

- URL: https://www.consentmanager.net/en/pricing/
- Publisher: consentmanager
- Accessed: 2026-08-22
- Evidence: Plans use page-view limits and gate TCF, white-label behavior, and overage terms behind higher tiers.

### SRC-058: Termly preference reopening support

- URL: https://support.termly.io/hc/en-us/articles/30710488101265-Why-is-my-cookie-preference-button-not-working
- Publisher: Termly support
- Accessed: 2026-08-22
- Evidence: Reopening preferences depends on the banner snippet remaining present and correctly wired, making user control fragile when remote UI setup changes.

### SRC-059: Cookiebot Next.js App Router hydration and flash report

- URL: https://stackoverflow.com/questions/77539217/how-to-make-usercentrics-cookiebot-work-with-next-js-v14-app-router
- Publisher: Stack Overflow
- Accessed: 2026-08-22
- Evidence: A reported App Router integration produces React hydration error 418, flashes the banner before it disappears, and disrupts client navigation across attempted script-loading variants.

### SRC-060: Termly stable styling attributes

- URL: https://support.termly.io/hc/en-us/articles/49692200680465-Styling-the-consent-banner-data-termly-attributes
- Publisher: Termly support
- Accessed: 2026-08-22
- Evidence: Termly warns that generated class names can change without notice and directs custom styling to a separate data-termly attribute contract.

### SRC-061: HTTP State Management Mechanism

- URL: https://www.rfc-editor.org/rfc/rfc6265.html
- Publisher: Internet Engineering Task Force
- Accessed: 2026-08-22
- Evidence: RFC 6265 permits same-name cookies with different Path or Domain attributes, warns servers not to rely on their serialization order, and allows user agents to ignore Set-Cookie in defined circumstances.

### SRC-062: HubSpot and OneTrust React lifecycle report

- URL: https://community.hubspot.com/t5/APIs-Integrations/hubspot-and-onetrust-in-react/td-p/114537
- Publisher: HubSpot Community
- Accessed: 2026-08-22
- Evidence: A reported integration sends HubSpot tracking before consent, while a do-not-track wrapper intended to defer it loses the first landing-page event after consent, exposing the need for explicit SDK lifecycle transitions.

## Research conclusion

The opportunity is not another decorative banner. The defensible product is a small, typed, self-hosted consent domain with deterministic blocking and signal order, explicit lifecycle adapters, a clean-room accessible UI, privacy-minimal proof ports, and unusually strong fixture-based tests. Scanner certainty, legal determination, hosted control planes, and certified advertising-framework operation remain separate products or operator responsibilities.
