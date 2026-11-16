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

import { createOpenCookieBrowserBinding } from "./index.js";

// A site that mounts through the browser binding, the route opencookie init
// generates, needs the same banner links and launcher choice as a site that
// calls bootstrapOpenCookie.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const SETTINGS_LINK =
  '<footer><a href="#privacy" data-oc-open-preferences>Cookie settings</a></footer>';

function page(markup = "<main></main>") {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = markup;
  const document = window.document as unknown as Document;
  const launcher = () => document.querySelector('[data-oc-action="open"]');
  return { document, launcher, window };
}

function binding() {
  const policy = definePolicy({
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "aggregate-measurement" }],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Understand aggregate site usage.",
        id: "analytics",
        label: "Analytics",
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["session"],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "session" }],
  });
  if (!policy.ok) throw new Error("Test policy must be valid.");
  const resourcePolicy = defineResourcePolicy({
    policy: policy.policy,
    resources: [
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics"],
        serviceId: "measurement-service",
      },
    ],
    services: [{ id: "measurement-service" }],
  });
  if (!resourcePolicy.ok) {
    throw new Error("Test resource policy must be valid.");
  }
  const snapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: policy.policy,
    policyVersion: "policy-1",
  });
  return createOpenCookieBrowserBinding({
    createClient: (ports) =>
      createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: ports.idGenerator,
        now: ports.now,
        policyHistory: [snapshot],
        policySnapshot: snapshot,
        reconcile: async (effect, context) => {
          await ports.reconcile(effect, context);
        },
        resourcePolicy: resourcePolicy.resourcePolicy,
        store: createLocalStorageDecisionStore({
          key: "opencookie.mount-options.test",
          schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
          storage: ports.storage,
        }),
      }),
  });
}

describe("browser binding mount options", () => {
  it("shows the site's links in the banner, in the order given", async () => {
    const { document, window } = page();
    const mounted = binding().mount({
      document,
      links: [
        { href: "/datenschutz", label: "Datenschutz" },
        { href: "/impressum", label: "Impressum" },
      ],
    });
    await mounted.ready;

    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        ".oc-bar nav.oc-bar-links a.oc-link",
      ),
    ];
    expect(
      links.map((link) => [link.getAttribute("href"), link.textContent]),
    ).toEqual([
      ["/datenschutz", "Datenschutz"],
      ["/impressum", "Impressum"],
    ]);
    mounted.destroy();
    window.close();
  });

  it("refuses a link that could run script before anything mounts", () => {
    const { document, window } = page();
    expect(() =>
      binding().mount({
        document,
        links: [{ href: "javascript:alert(1)", label: "Privacy" }],
      }),
    ).toThrow(TypeError);
    expect(document.querySelector(".oc-root")).toBeNull();
    window.close();
  });

  it("mounts after a refused mount on the same binding", async () => {
    const { document, window } = page();
    const shared = binding();
    expect(() =>
      shared.mount({
        document,
        links: [{ href: "javascript:alert(1)", label: "Privacy" }],
      }),
    ).toThrow(TypeError);

    const mounted = shared.mount({
      document,
      links: [{ href: "/datenschutz", label: "Datenschutz" }],
    });
    await mounted.ready;

    expect(document.querySelector(".oc-bar .oc-bar-links")).not.toBeNull();
    mounted.destroy();
    window.close();
  });

  it("leaves the launcher out with launcher: false on a page with its own settings link", async () => {
    const { document, launcher, window } = page(SETTINGS_LINK);
    const shared = binding();
    const mounted = shared.mount({ document, launcher: false });
    await mounted.ready;

    await shared.client.rejectAll();
    await settle();

    expect(document.querySelector(".oc-bar")).toBeNull();
    expect(launcher()).toBeNull();
    mounted.destroy();
    window.close();
  });

  it("keeps the launcher with launcher: false on a page without its own link", async () => {
    const { document, launcher, window } = page();
    const shared = binding();
    const mounted = shared.mount({ document, launcher: false });
    await mounted.ready;

    await shared.client.rejectAll();
    await settle();

    expect(launcher()).not.toBeNull();
    mounted.destroy();
    window.close();
  });
});
