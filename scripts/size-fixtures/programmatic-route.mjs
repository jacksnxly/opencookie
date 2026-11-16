import {
  bootstrapOpenCookieFromHead,
  VANILLA_COPY_DE,
} from "@opencookie-dev/vanilla";

// A generic page on the programmatic route, bundled as a site bundles it for
// one language: a three-purpose policy, the German copy, Google Consent Mode
// and a declared exception. Its bundled size is the route's measured size.
// Extend it when the route gains a feature a site would use.

const purpose = (id, label, disclosure, dataCategoryId) => ({
  dataCategoryIds: [dataCategoryId],
  disclosure,
  id,
  label,
  operationIds: ["process"],
  providerIds: ["site-operator"],
  recipientIds: ["site-operator"],
  retentionIds: ["thirteen-months"],
});

globalThis.dataLayer ??= [];

void bootstrapOpenCookieFromHead({
  copy: VANILLA_COPY_DE,
  declaredExceptions: [
    { exceptionReason: "Hält die Anmeldung aufrecht.", id: "session" },
  ],
  googleConsentMode: {
    command: (...call) => {
      globalThis.dataLayer.push(call);
    },
    mapping: {
      adStorageResourceIds: ["advertising-tag"],
      analyticsStorageResourceIds: ["analytics-tag"],
    },
    mode: "basic",
  },
  policyDefinition: {
    categories: [
      {
        id: "optional",
        purposeIds: ["analytics", "advertising", "personalization"],
      },
    ],
    dataCategories: [
      { id: "ad-interaction" },
      { id: "preference" },
      { id: "usage-event" },
    ],
    operations: [{ id: "process" }],
    presentationRootCategoryIds: ["optional"],
    providers: [{ id: "site-operator" }],
    purposes: [
      purpose(
        "analytics",
        "Statistik",
        "Misst die Nutzung der Seiten in zusammengefasster Form.",
        "usage-event",
      ),
      purpose(
        "advertising",
        "Werbung",
        "Misst, welche Anzeigen zu einem Besuch geführt haben.",
        "ad-interaction",
      ),
      purpose(
        "personalization",
        "Personalisierung",
        "Merkt sich Einstellungen für spätere Besuche.",
        "preference",
      ),
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "thirteen-months" }],
  },
  policyVersion: "2026-09",
});
