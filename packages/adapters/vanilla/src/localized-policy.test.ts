import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type PolicyDefinition,
  type StorageLike,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import {
  bootstrapOpenCookie,
  mountOpenCookie,
  VANILLA_COPY_DE,
} from "./index.js";

// A site shows its choices in German and English from one policy. Each page
// shows the policy in its own language, and a decision made on one stays
// current on the other.

const POLICY: PolicyDefinition = {
  categories: [
    {
      id: "statistics",
      label: "Messung",
      purposeIds: ["analytics"],
      translations: [{ label: "Measurement", locale: "en" }],
    },
  ],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "measure" }],
  presentationRootCategoryIds: ["statistics"],
  providers: [{ id: "site-operator" }],
  purposes: [
    {
      dataCategoryIds: ["usage-event"],
      disclosure: "Misst die Nutzung der Seiten.",
      id: "analytics",
      label: "Statistik",
      operationIds: ["measure"],
      providerIds: ["site-operator"],
      recipientIds: ["site-operator"],
      retentionIds: ["thirteen-months"],
      translations: [
        { disclosure: "Measures page use.", label: "Statistics", locale: "en" },
      ],
    },
  ],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: "thirteen-months" }],
};

const TRACKER = [
  '<script type="text/plain" data-src="https://tracker.example.test/t.js"',
  ' data-oc-resource="tracker" data-oc-category="analytics"></script>',
].join("");

function memoryStorage(): StorageLike & {
  readonly items: Map<string, string>;
} {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    items,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function page() {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = TRACKER;
  return { document: window.document as unknown as Document, window };
}

function settings(document: Document) {
  document
    .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
    ?.click();
  const purpose = document.querySelector("label.oc-purpose:not(.oc-category)");
  return {
    description: purpose?.querySelector("small")?.textContent,
    heading: document.querySelector("label.oc-category")?.textContent,
    title: purpose?.querySelector("strong")?.textContent,
  };
}

describe("a policy shown in several languages", () => {
  it("shows each page its own language, headings included", async () => {
    for (const [copy, expected] of [
      [
        VANILLA_COPY_DE,
        {
          description: "Misst die Nutzung der Seiten.",
          heading: "Messung",
          title: "Statistik",
        },
      ],
      [
        undefined,
        {
          description: "Measures page use.",
          heading: "Measurement",
          title: "Statistics",
        },
      ],
    ] as const) {
      const { document, window } = page();
      const started = bootstrapOpenCookie({
        ...(copy === undefined ? {} : { copy }),
        document,
        policyDefinition: POLICY,
      });
      await started.ready;

      expect(settings(document)).toEqual(expected);
      started.destroy();
      window.close();
    }
  });

  it("keeps a decision made in one language current in the other", async () => {
    const storage = memoryStorage();
    const german = page();
    const deciding = bootstrapOpenCookie({
      copy: VANILLA_COPY_DE,
      document: german.document,
      policyDefinition: POLICY,
      storage,
    });
    await deciding.ready;
    await deciding.client.acceptAll();
    deciding.destroy();
    german.window.close();

    const english = page();
    const returning = bootstrapOpenCookie({
      document: english.document,
      policyDefinition: POLICY,
      storage,
    });
    await returning.ready;

    expect(
      returning.client.getSnapshot().runtime.consentEvaluation.prompt,
    ).toBe(false);
    expect(english.document.querySelector(".oc-bar")).toBeNull();
    expect(
      english.document.querySelector('[data-oc-active-resource="tracker"]'),
    ).not.toBeNull();
    returning.destroy();
    english.window.close();
  });

  it("records the language the visitor decided in", async () => {
    const storage = memoryStorage();
    const { document, window } = page();
    const started = bootstrapOpenCookie({
      copy: VANILLA_COPY_DE,
      document,
      policyDefinition: POLICY,
      storage,
    });
    await started.ready;
    await started.client.acceptAll();

    expect(storage.items.get("opencookie.consent")).toContain('"locale":"de"');
    started.destroy();
    window.close();
  });

  it("shows the page's language on a hand-wired mount", async () => {
    const policy = definePolicy(POLICY);
    if (!policy.ok) throw new Error("The test policy must be valid.");
    const resourcePolicy = defineResourcePolicy({
      policy: policy.policy,
      resources: [],
      services: [],
    });
    if (!resourcePolicy.ok) throw new Error("The resources must be valid.");
    const { document, window } = page();
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => `${kind}-1`,
      now: () => 1_700_000_000_000,
      policySnapshot: createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: policy.policy,
        policyVersion: "policy-1",
      }),
      reconcile: () => Promise.resolve(),
      resourcePolicy: resourcePolicy.resourcePolicy,
      store: createLocalStorageDecisionStore({
        key: "opencookie.consent",
        schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
        storage: memoryStorage(),
      }),
    });
    await client.initialize();
    const mounted = mountOpenCookie({ client, document });
    await mounted.ready;

    expect(settings(document).heading).toBe("Measurement");
    mounted.destroy();
    window.close();
  });
});
