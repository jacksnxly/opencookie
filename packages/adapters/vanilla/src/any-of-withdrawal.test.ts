import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type PolicyDefinition,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { bootstrapOpenCookie, mountOpenCookie } from "./index.js";

// A container that serves several purposes stays allowed while any one is
// permitted, but the tags it started for a purpose the visitor has now turned
// off cannot be unloaded. Once that decision is stored, the tab reloads, and
// the container starts again with only what is still permitted.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const POLICY: PolicyDefinition = {
  categories: [
    {
      id: "optional",
      purposeIds: ["advertising", "analytics", "personalization"],
    },
  ],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "measure" }],
  presentationRootCategoryIds: ["optional"],
  providers: [{ id: "site-operator" }],
  purposes: ["advertising", "analytics", "personalization"].map((id) => ({
    dataCategoryIds: ["usage-event"],
    disclosure: `Uses ${id}.`,
    id,
    operationIds: ["measure"],
    providerIds: ["site-operator"],
    recipientIds: ["site-operator"],
    retentionIds: ["thirteen-months"],
  })) as unknown as PolicyDefinition["purposes"],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: "thirteen-months" }],
};

const CONTAINER =
  '<script type="text/plain" data-src="https://tags.example.test/container.js" data-oc-resource="container" data-oc-category="analytics advertising" data-oc-match="any"></script>';

function page() {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = CONTAINER;
  const reload = vi.fn();
  vi.spyOn(window.location, "reload").mockImplementation(reload);
  return { document: window.document as unknown as Document, reload, window };
}

describe("a started container that serves several purposes", () => {
  it("reloads its tab when one of its purposes is turned off", async () => {
    const { document, reload, window } = page();
    const started = bootstrapOpenCookie({ document, policyDefinition: POLICY });
    await started.ready;
    await started.client.savePreferences(["advertising", "analytics"]);
    await settle();
    expect(reload).not.toHaveBeenCalled();

    await started.client.savePreferences(["analytics"]);
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    started.destroy();
    window.close();
  });

  it("does not reload for a purpose it does not serve", async () => {
    const { document, reload, window } = page();
    const started = bootstrapOpenCookie({ document, policyDefinition: POLICY });
    await started.ready;
    await started.client.savePreferences(["analytics", "personalization"]);
    await settle();

    await started.client.savePreferences(["analytics"]);
    await settle();

    expect(reload).not.toHaveBeenCalled();
    started.destroy();
    window.close();
  });

  it("reloads a hand-wired mount's tab too", async () => {
    const { document, reload, window } = page();
    const policy = definePolicy(POLICY);
    if (!policy.ok) throw new Error("The test policy must be valid.");
    const resourcePolicy = defineResourcePolicy({
      policy: policy.policy,
      resources: [
        {
          access: "optional",
          id: "container",
          purposeIds: ["advertising", "analytics"],
          purposeMatch: "any",
          serviceId: "tag-manager",
        },
      ],
      services: [{ id: "tag-manager" }],
    });
    if (!resourcePolicy.ok) throw new Error("The resources must be valid.");
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (() => {
        let sequence = 0;
        return (kind) => `${kind}-${String((sequence += 1))}`;
      })(),
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
    const mounted = mountOpenCookie({ client, document });
    await mounted.ready;
    await client.savePreferences(["advertising", "analytics"]);
    await settle();

    await client.savePreferences(["analytics"]);
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    mounted.destroy();
    window.close();
  });
});

describe("storage a container declares for one of its purposes", () => {
  const SCOPED =
    '<script type="text/plain" data-src="https://tags.example.test/container.js" data-oc-resource="container" data-oc-category="analytics advertising" data-oc-match="any" data-oc-stores="advertising=local:_ad analytics=local:_an local:_shared"></script>';

  it("is deleted when that purpose is turned off, and the rest is kept", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    window.document.body.innerHTML = SCOPED;
    const reload = vi.fn();
    vi.spyOn(window.location, "reload").mockImplementation(reload);
    const started = bootstrapOpenCookie({
      document: window.document as unknown as Document,
      policyDefinition: POLICY,
    });
    await started.ready;
    await started.client.savePreferences(["advertising", "analytics"]);
    await settle();
    for (const key of ["_ad", "_an", "_shared"]) {
      window.localStorage.setItem(key, "written by a tag");
    }
    const stored = () =>
      ["_ad", "_an", "_shared"].filter(
        (key) => window.localStorage.getItem(key) !== null,
      );

    await started.client.savePreferences(["analytics"]);
    await settle();
    expect(stored()).toEqual(["_an", "_shared"]);
    expect(reload).toHaveBeenCalledTimes(1);

    await started.client.rejectAll();
    await settle();
    expect(stored()).toEqual([]);
    started.destroy();
    window.close();
  });
});
