import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie, mountOpenCookie } from "./index.js";

// The floating launcher reopens the choices once a decision is stored. A page
// with its own "Cookie settings" entry point can leave it out with
// launcher: false, so it covers nothing. A page without one keeps it, because
// the choices must stay reachable.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const LINK =
  '<footer><a href="#privacy" data-oc-open-preferences>Cookie settings</a></footer>';

function page(markup = LINK) {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = markup;
  const document = window.document as unknown as Document;
  const launcher = () => document.querySelector('[data-oc-action="open"]');
  return { document, launcher, window };
}

describe("launcher: false", () => {
  it("leaves the launcher out on a page with its own settings link", async () => {
    const { document, launcher, window } = page();
    const started = bootstrapOpenCookie({ document, launcher: false });
    await started.ready;

    await started.client.rejectAll();
    await settle();

    expect(document.querySelector(".oc-bar")).toBeNull();
    expect(launcher()).toBeNull();
    started.destroy();
    window.close();
  });

  it("keeps the launcher on a page without its own link", async () => {
    const { document, launcher, window } = page("<main></main>");
    const started = bootstrapOpenCookie({ document, launcher: false });
    await started.ready;

    await started.client.rejectAll();
    await settle();

    expect(launcher()).not.toBeNull();
    started.destroy();
    window.close();
  });

  it("is not the default", async () => {
    const { document, launcher, window } = page();
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    await started.client.rejectAll();
    await settle();

    expect(launcher()).not.toBeNull();
    started.destroy();
    window.close();
  });

  // With the launcher, a decision made in the bar moves focus to it. Without
  // it, the page's own link takes its place, so focus is not lost.
  it("moves focus to the page's own link after a decision in the bar", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({ document, launcher: false });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('.oc-bar [data-oc-action="reject-all"]')
      ?.click();
    await settle();
    await settle();

    expect(document.activeElement).toBe(
      document.querySelector("[data-oc-open-preferences]"),
    );
    started.destroy();
    window.close();
  });

  it("applies to a hand-wired mount", async () => {
    const { document, launcher, window } = page();
    const policy = definePolicy({
      categories: [{ id: "optional", purposeIds: ["analytics"] }],
      dataCategories: [{ id: "usage-event" }],
      operations: [{ id: "measure" }],
      presentationRootCategoryIds: ["optional"],
      providers: [{ id: "site-operator" }],
      purposes: [
        {
          dataCategoryIds: ["usage-event"],
          disclosure: "Measures page use.",
          id: "analytics",
          operationIds: ["measure"],
          providerIds: ["site-operator"],
          recipientIds: ["site-operator"],
          retentionIds: ["thirteen-months"],
        },
      ],
      recipients: [{ id: "site-operator" }],
      retentions: [{ id: "thirteen-months" }],
    });
    if (!policy.ok) throw new Error("The test policy must be valid.");
    const resourcePolicy = defineResourcePolicy({
      policy: policy.policy,
      resources: [
        {
          access: "optional",
          id: "tag",
          purposeIds: ["analytics"],
          serviceId: "tags",
        },
      ],
      services: [{ id: "tags" }],
    });
    if (!resourcePolicy.ok) throw new Error("The resources must be valid.");
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
        storage: (window as unknown as { localStorage: Storage }).localStorage,
      }),
    });
    const mounted = mountOpenCookie({ client, document, launcher: false });
    await mounted.ready;

    await client.rejectAll();
    await settle();

    expect(launcher()).toBeNull();
    mounted.destroy();
    window.close();
  });
});
