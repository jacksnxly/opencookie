import type { PolicyDefinition } from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import {
  bootstrapOpenCookie,
  bootstrapOpenCookieFromHead,
  type VanillaGoogleConsentModeOptions,
} from "./index.js";

// The tags inside a tag manager's container read Consent Mode, so each
// signal follows the purposes it stands for, not whether the container, which
// serves several purposes, loaded.

const POLICY: PolicyDefinition = {
  categories: [{ id: "optional", purposeIds: ["advertising", "analytics"] }],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "measure" }],
  presentationRootCategoryIds: ["optional"],
  providers: [{ id: "site-operator" }],
  purposes: ["advertising", "analytics"].map((id) => ({
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

const PURPOSES = {
  adPersonalizationPurposeIds: ["advertising"],
  adStoragePurposeIds: ["advertising"],
  adUserDataPurposeIds: ["advertising"],
  analyticsStoragePurposeIds: ["analytics"],
};

function page() {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = CONTAINER;
  vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  const calls: unknown[][] = [];
  const google = (
    mapping: Partial<VanillaGoogleConsentModeOptions>,
  ): VanillaGoogleConsentModeOptions => ({
    command: (...call: unknown[]) => calls.push(call),
    mode: "basic",
    ...mapping,
  });
  return {
    calls,
    document: window.document as unknown as Document,
    google,
    window,
  };
}

describe("Consent Mode mapped to purposes on the bootstrap", () => {
  it("grants each signal by its purposes while the container loads for any", async () => {
    const { calls, document, google, window } = page();
    const started = bootstrapOpenCookie({
      document,
      googleConsentMode: google({ purposeMapping: PURPOSES }),
      policyDefinition: POLICY,
    });
    await started.ready;

    await started.client.savePreferences(["analytics"]);
    expect(calls.at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "granted",
      },
    ]);
    expect(
      document.querySelector('[data-oc-active-resource="container"]'),
    ).not.toBeNull();
    started.destroy();
    window.close();
  });

  it("works from <head> too", async () => {
    const { calls, document, google, window } = page();
    const started = await bootstrapOpenCookieFromHead({
      document,
      googleConsentMode: google({ purposeMapping: PURPOSES }),
      policyDefinition: POLICY,
    });
    await started.ready;

    await started.client.savePreferences(["advertising"]);
    expect(calls.map(([, action]) => action)).toEqual(["default", "update"]);
    expect(calls.at(-1)?.[2]).toMatchObject({
      ad_storage: "granted",
      analytics_storage: "denied",
    });
    started.destroy();
    window.close();
  });

  it("refuses a signal mapped to a container that serves several purposes", () => {
    const { calls, document, google, window } = page();

    expect(() =>
      bootstrapOpenCookie({
        document,
        googleConsentMode: google({
          mapping: { analyticsStorageResourceIds: ["container"] },
        }),
        policyDefinition: POLICY,
      }),
    ).toThrow(/container.*purposeMapping/u);
    expect(calls).toEqual([]);
    expect(document.querySelector("[data-oc-root]")).toBeNull();
    window.close();
  });

  it("needs exactly one of a resource mapping and a purpose mapping", () => {
    for (const mapping of [
      {},
      {
        mapping: { analyticsStorageResourceIds: ["container"] },
        purposeMapping: PURPOSES,
      },
    ]) {
      const { calls, document, google, window } = page();
      expect(() =>
        bootstrapOpenCookie({
          document,
          googleConsentMode: google(mapping),
          policyDefinition: POLICY,
        }),
      ).toThrow(TypeError);
      expect(calls).toEqual([]);
      window.close();
    }
  });
});
