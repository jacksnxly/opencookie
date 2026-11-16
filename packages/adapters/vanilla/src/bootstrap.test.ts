import { readFileSync } from "node:fs";

import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createPolicySnapshot,
  definePolicy,
  type DecisionStore,
  type OpenCookiePortContext,
  type PolicyDefinition,
  type PolicySnapshot,
} from "@opencookie-dev/core";
import type { CookieJarLike } from "@opencookie-dev/core/infrastructure";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { startAutoBootstrap } from "./auto-bootstrap.js";
import {
  bootstrapOpenCookie,
  type BootstrapOpenCookieOptions,
} from "./index.js";
import { defaultBrowserStorage } from "./product-composition.js";

function idGenerator(): (kind: "record" | "transition") => string {
  let sequence = 0;
  return (kind) => `${kind}-${String(++sequence)}`;
}

function selectivePolicyDefinition(
  analyticsDisclosure: string,
): PolicyDefinition {
  return {
    dataCategories: [{ id: "preference" }, { id: "usage-event" }],
    operations: [
      { id: "aggregate-measurement" },
      { id: "remember-preference" },
    ],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: analyticsDisclosure,
        id: "analytics",
        label: "Analytics",
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["until-reset"],
      },
      {
        dataCategoryIds: ["preference"],
        disclosure: "Remember the optional display preference.",
        id: "personalization",
        label: "Personalization",
        operationIds: ["remember-preference"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["until-reset"],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "until-reset" }],
  };
}

function policySnapshot(
  definition: PolicyDefinition,
  policyVersion: string,
): PolicySnapshot {
  const result = definePolicy(definition);
  if (!result.ok) throw new Error("The test policy must be valid.");
  return createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: result.policy,
    policyVersion,
  });
}

function capturingStore(): {
  readonly records: readonly unknown[];
  readonly store: DecisionStore;
} {
  const records: unknown[] = [];
  return {
    records,
    store: {
      clear: () => {
        records.length = 0;
        return Promise.resolve();
      },
      clearIfCurrent: () => {
        records.length = 0;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet(_expected, candidate) {
        records.push(candidate);
        return Promise.resolve({ status: "written" });
      },
      read: () => Promise.resolve({ status: "missing" }),
    },
  };
}

function memoryCookieJar(): CookieJarLike & {
  readonly writes: readonly string[];
} {
  let header = "";
  const writes: string[] = [];
  return {
    read: () => header,
    write(serializedCookie) {
      writes.push(serializedCookie);
      const pair = serializedCookie.split(";", 1)[0] ?? "";
      header = pair.endsWith("=") ? "" : pair;
    },
    writes,
  };
}

async function settleDom(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function settingsPanel(document: Document): HTMLDialogElement {
  const dialog = document.querySelector<HTMLDialogElement>("dialog.oc-panel");
  if (dialog === null)
    throw new Error("The persistent settings panel is missing.");
  return dialog;
}

function installRecoverableDefaultStorage(window: Window): {
  readonly makeAvailable: () => void;
  readonly readCount: () => number;
  readonly storage: Storage;
} {
  const storage = window.localStorage;
  let available = false;
  let reads = 0;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => {
      reads += 1;
      if (!available) {
        const error = new Error("Browser storage is temporarily blocked.");
        error.name = "SecurityError";
        throw error;
      }
      return storage;
    },
  });
  return {
    makeAvailable: () => {
      available = true;
    },
    readCount: () => reads,
    storage,
  };
}

function transientStorageError(): Error {
  const error = new Error("Browser storage is temporarily blocked.");
  error.name = "SecurityError";
  return error;
}

function pressEnter(window: Window, button: HTMLButtonElement): void {
  const keydown = new window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
  });
  const uncancelled = button.dispatchEvent(keydown as unknown as Event);
  // Happy DOM does not synthesize the browser's default Enter-to-click action.
  if (uncancelled) button.click();
  button.dispatchEvent(
    new window.KeyboardEvent("keyup", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    }) as unknown as Event,
  );
}

describe("bootstrapOpenCookie", () => {
  it("rejects a control-only category identity before bootstrap effects", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const categoryId = "\u0000";
    let started: ReturnType<typeof bootstrapOpenCookie> | undefined;
    let thrown: unknown;
    let returned = false;

    try {
      started = bootstrapOpenCookie({
        document,
        policyDefinition: {
          ...selectivePolicyDefinition("Understand aggregate site usage."),
          categories: [{ id: categoryId, purposeIds: ["analytics"] }],
          presentationRootCategoryIds: [categoryId],
        },
      });
      returned = true;
      await started.ready;
      document
        .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
        ?.click();
    } catch (error) {
      thrown = error;
    }

    const effects = {
      categoryInput:
        document.querySelector('input[name="opencookie-category"]') !== null,
      root: document.querySelector("[data-oc-root]") !== null,
      style: document.querySelector("style[data-opencookie]") !== null,
    };
    started?.destroy();
    window.close();

    expect({ effects, returned }).toEqual({
      effects: { categoryInput: false, root: false, style: false },
      returned: false,
    });
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty(
      "message",
      "The OpenCookie bootstrap purpose catalogue is invalid.",
    );
  });

  // A withdrawal in another tab must stop this tab's optional resources too.
  // The page reloads to re-read the stored decision. Its own decisions reload it
  // only when they turn off a script it ran (withdrawal-teardown.test.ts).
  it("reloads when another tab rewrites the stored decision", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => undefined);
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await started.client.acceptAll();
    await settleDom();

    window.localStorage.setItem("unrelated", "x");
    window.dispatchEvent(
      new window.StorageEvent("storage", { key: "unrelated", newValue: "x" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).not.toHaveBeenCalled();

    window.localStorage.setItem("opencookie.consent", "written elsewhere");
    window.dispatchEvent(
      new window.StorageEvent("storage", {
        key: "opencookie.consent",
        newValue: "written elsewhere",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).toHaveBeenCalledTimes(1);

    started.destroy();
    window.close();
  });

  // A denial publishes its record before the store write lands, so a baseline
  // read then saw the old value, and the next unrelated storage event, pageshow
  // or return to the tab reloaded the visitor's own page and lost its state.
  it.each(["rejectAll", "withdraw"] as const)(
    "does not reload after its own %s when an unrelated event arrives",
    async (decision) => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      const reload = vi
        .spyOn(window.location, "reload")
        .mockImplementation(() => undefined);
      const started = bootstrapOpenCookie({ document });
      await started.ready;
      if (decision === "withdraw") {
        await started.client.acceptAll();
        await settleDom();
        await started.client.withdrawConsent();
      } else {
        await started.client.rejectAll();
      }
      await settleDom();

      window.localStorage.setItem("cart", "1");
      window.dispatchEvent(
        new window.StorageEvent("storage", { key: "cart", newValue: "1" }),
      );
      window.dispatchEvent(new window.Event("pageshow"));
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(reload).not.toHaveBeenCalled();

      started.destroy();
      window.close();
    },
  );

  // Only a page restored from the back-forward cache can hold a stale
  // decision. A first load's pageshow compared as well, 500 ms later, so a
  // store emptied in that window reloaded the page under whoever was
  // navigating it: the e2e matrix's TEST-SAFARI-STATE-LOSS on 0.2.1.
  const pageShow = (window: Window, persisted: boolean) => {
    const event = new window.Event("pageshow");
    Object.defineProperty(event, "persisted", { value: persisted });
    return event;
  };

  it("does not compare the stored decision on a first load's pageshow", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => undefined);
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    window.dispatchEvent(pageShow(window, false));
    await started.client.rejectAll();
    await settleDom();

    window.localStorage.removeItem("opencookie.consent");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).not.toHaveBeenCalled();

    started.destroy();
    window.close();
  });

  it("compares the stored decision when restored from the back-forward cache", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => undefined);
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    await started.client.rejectAll();
    await settleDom();

    window.localStorage.removeItem("opencookie.consent");
    window.dispatchEvent(pageShow(window, true));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).toHaveBeenCalledTimes(1);

    started.destroy();
    window.close();
  });

  // The site's tabs announce decisions on one channel for the whole origin.
  // A tab adopts a change to its own stored decision. It reloads only when
  // that change blocks a script it started, or the record cannot be verified.
  // Another install on the origin keeps another store.
  describe("across tabs on one channel", () => {
    const tabOf = (store: "shared" | "other", shared: Map<string, string>) => {
      const window = new Window({ url: "https://shop.example.test/" });
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: globalThis.BroadcastChannel,
      });
      const reload = vi
        .spyOn(window.location, "reload")
        .mockImplementation(() => undefined);
      const started = bootstrapOpenCookie({
        document: window.document as unknown as Document,
        store: createLocalStorageDecisionStore({
          key: store === "shared" ? "app.consent" : "other-app.consent",
          schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
          storage: {
            getItem: (key) => shared.get(key) ?? null,
            removeItem: (key) => {
              shared.delete(key);
            },
            setItem: (key, value) => {
              shared.set(key, value);
            },
          },
        }),
      });
      return { reload, started, window };
    };

    it("does not reload for a decision in another install's store", async () => {
      const storage = new Map<string, string>();
      const mine = tabOf("shared", storage);
      await mine.started.ready;
      await mine.started.client.acceptAll();
      const other = tabOf("other", storage);
      await other.started.ready;

      await other.started.client.acceptAll();
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(mine.reload).not.toHaveBeenCalled();
      mine.started.destroy();
      other.started.destroy();
      mine.window.close();
      other.window.close();
    });

    it("adopts a withdrawal from another tab of its own store", async () => {
      const storage = new Map<string, string>();
      const first = tabOf("shared", storage);
      await first.started.ready;
      await first.started.client.acceptAll();
      const second = tabOf("shared", storage);
      await second.started.ready;

      await second.started.client.withdrawConsent();
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Nothing on the page had started, so the withdrawal is adopted in
      // place. A script that had run would still reload.
      expect(first.reload).not.toHaveBeenCalled();
      expect(first.started.client.getSnapshot().record?.method).toBe(
        "withdrawal",
      );
      expect(second.reload).not.toHaveBeenCalled();
      first.started.destroy();
      second.started.destroy();
      first.window.close();
      second.window.close();
    });
  });

  it("reloads when another tab rewrites a caller-owned store's decision", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => undefined);
    const started = bootstrapOpenCookie({
      document,
      store: createLocalStorageDecisionStore({
        key: "caller.consent",
        schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
        storage: window.localStorage,
      }),
    });
    await started.ready;
    await started.client.acceptAll();
    await settleDom();

    window.localStorage.setItem("unrelated", "x");
    window.dispatchEvent(
      new window.StorageEvent("storage", { key: "unrelated", newValue: "x" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).not.toHaveBeenCalled();

    window.localStorage.setItem("caller.consent", "written elsewhere");
    window.dispatchEvent(
      new window.StorageEvent("storage", {
        key: "caller.consent",
        newValue: "written elsewhere",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).toHaveBeenCalledTimes(1);

    started.destroy();
    window.close();
  });

  // A purpose's name is its label. Its disclosure is its description, so a
  // screen reader should hear it once, not a second time inside the name.
  it("names each purpose choice by its label and describes it by its disclosure", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({ document });
    await started.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const input = document.querySelector<HTMLInputElement>(
      '.oc-purpose:not(.oc-category) input[type="checkbox"]',
    );
    const name = document.getElementById(
      input?.getAttribute("aria-labelledby") ?? "",
    );
    const description = document.getElementById(
      input?.getAttribute("aria-describedby") ?? "",
    );
    expect(name?.textContent).toBe("Analytics");
    expect(description?.textContent).toBe("Understand aggregate site usage.");

    started.destroy();
    window.close();
  });

  it("presents the programmatic bootstrap in the caller's own task", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({ document });

    // Only the drop-in defers presentation; callers that query the DOM right
    // after bootstrapping keep finding the host.
    expect(document.querySelector("[data-oc-root]")).not.toBeNull();
    expect(document.querySelector("style[data-opencookie]")).not.toBeNull();

    await started.ready;
    started.destroy();
    window.close();
  });

  it("groups the default Analytics purpose under the optional presentation root", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({ document });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    expect(
      document.querySelector("fieldset.oc-purposes legend")?.textContent,
    ).toBe("optional");

    started.destroy();
    window.close();
  });

  it("binds custom presentation to the complete published policy disclosure", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({
      document,
      policyDefinition: {
        dataCategories: [{ id: "preference" }],
        operations: [{ id: "remember-preference" }],
        providers: [{ id: "site-operator" }],
        purposes: [
          {
            dataCategoryIds: ["preference"],
            disclosure: "Remember the optional display preference.",
            id: "personalization",
            label: "Policy-bound personalization",
            operationIds: ["remember-preference"],
            providerIds: ["site-operator"],
            recipientIds: ["site-operator"],
            retentionIds: ["until-reset"],
          },
        ],
        recipients: [{ id: "site-operator" }],
        retentions: [{ id: "until-reset" }],
      },
      purposes: [
        {
          description: "This presentation copy must not replace the policy.",
          id: "personalization",
          label: "Untrusted personalization",
        },
      ],
    } as unknown as BootstrapOpenCookieOptions);
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const purpose = document.querySelector<HTMLElement>(".oc-purpose");
    expect(purpose?.textContent).toContain(
      "Remember the optional display preference.",
    );
    expect(purpose?.textContent).toContain("Policy-bound personalization");
    expect(purpose?.textContent).not.toContain(
      "This presentation copy must not replace the policy.",
    );

    started.destroy();
    window.close();
  });

  it("binds starter retention metadata to the exact consent duration", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({
      consentDurationMs: 1_000,
      document,
    });
    await started.ready;

    const policy = started.client.getSnapshot().policySnapshot.policy;
    expect(policy.retentions).toEqual([{ id: "duration-1000-ms" }]);
    expect(policy.purposes[0]?.retentionIds).toEqual(["duration-1000-ms"]);

    started.destroy();
    window.close();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["noninteger", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ] as const)(
    "rejects a %s consent duration before any bootstrap effect",
    (_case, consentDurationMs) => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      let policyReads = 0;
      let storageReads = 0;
      const googleCalls: unknown[][] = [];
      const options: BootstrapOpenCookieOptions = {
        consentDurationMs,
        document,
        googleConsentMode: {
          command: (...call) => googleCalls.push(call),
          mapping: {},
          mode: "basic",
        },
      };
      Object.defineProperties(options, {
        policyDefinition: {
          get: () => {
            policyReads += 1;
            return undefined;
          },
        },
        storage: {
          get: () => {
            storageReads += 1;
            return window.localStorage;
          },
        },
      });

      expect(() => bootstrapOpenCookie(options)).toThrow(
        "Consent duration must be a positive safe integer.",
      );
      expect({ policyReads, storageReads }).toEqual({
        policyReads: 0,
        storageReads: 0,
      });
      expect(googleCalls).toEqual([]);
      expect(document.querySelector("[data-oc-root]")).toBeNull();
      window.close();
    },
  );

  it("rejects an explicit null duration instead of selecting the default", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    let policyReads = 0;
    let storageReads = 0;
    const googleCalls: unknown[][] = [];
    const options: BootstrapOpenCookieOptions = {
      document,
      googleConsentMode: {
        command: (...call) => googleCalls.push(call),
        mapping: {},
        mode: "basic",
      },
    };
    Object.defineProperties(options, {
      consentDurationMs: { enumerable: true, value: null },
      policyDefinition: {
        get: () => {
          policyReads += 1;
          return undefined;
        },
      },
      storage: {
        get: () => {
          storageReads += 1;
          return window.localStorage;
        },
      },
    });

    let started: ReturnType<typeof bootstrapOpenCookie> | undefined;
    let thrown: unknown;
    try {
      started = bootstrapOpenCookie(options);
    } catch (error) {
      thrown = error;
    }
    const mounted = document.querySelector("[data-oc-root]") !== null;
    started?.destroy();
    window.close();

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty(
      "message",
      "Consent duration must be a positive safe integer.",
    );
    expect({ mounted, policyReads, storageReads }).toEqual({
      mounted: false,
      policyReads: 0,
      storageReads: 0,
    });
    expect(googleCalls).toEqual([]);
  });

  it.each(["accessor", "inherited"] as const)(
    "rejects an %s duration without invoking it or producing OpenCookie effects",
    (durationKind) => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      let durationReads = 0;
      let policyReads = 0;
      let storageReads = 0;
      const googleCalls: unknown[][] = [];
      const options: BootstrapOpenCookieOptions = {
        document,
        googleConsentMode: {
          command: (...call) => googleCalls.push(call),
          mapping: {},
          mode: "basic",
        },
      };
      const durationDescriptor = {
        enumerable: true,
        get: () => {
          durationReads += 1;
          document.body.setAttribute("data-duration-getter-effect", "true");
          window.localStorage.setItem("duration-getter-effect", "true");
          googleCalls.push(["duration-getter-effect"]);
          return 0;
        },
      };
      if (durationKind === "accessor") {
        Object.defineProperty(options, "consentDurationMs", durationDescriptor);
      } else {
        const prototype = {};
        Object.defineProperty(
          prototype,
          "consentDurationMs",
          durationDescriptor,
        );
        Object.setPrototypeOf(options, prototype);
      }
      Object.defineProperties(options, {
        policyDefinition: {
          get: () => {
            policyReads += 1;
            return undefined;
          },
        },
        storage: {
          get: () => {
            storageReads += 1;
            return window.localStorage;
          },
        },
      });

      expect(() => bootstrapOpenCookie(options)).toThrow(
        "Consent duration must be a positive safe integer.",
      );
      expect({ durationReads, policyReads, storageReads }).toEqual({
        durationReads: 0,
        policyReads: 0,
        storageReads: 0,
      });
      expect(googleCalls).toEqual([]);
      expect(document.body.hasAttribute("data-duration-getter-effect")).toBe(
        false,
      );
      expect(window.localStorage.getItem("duration-getter-effect")).toBeNull();
      expect(document.querySelector("[data-oc-root]")).toBeNull();
      window.close();
    },
  );

  it("orders Consent Mode v2 defaults before decision updates and activation", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const calls: unknown[][] = [];
    const started = bootstrapOpenCookie({
      document,
      googleConsentMode: {
        command: (...call) => calls.push(call),
        mapping: { analyticsStorageResourceIds: ["analytics-script"] },
        mode: "basic",
      },
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });

    expect(calls).toEqual([
      [
        "consent",
        "default",
        {
          ad_personalization: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          analytics_storage: "denied",
        },
      ],
    ]);
    await started.ready;
    expect(calls).toHaveLength(1);

    await started.client.acceptAll();
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
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).not.toBeNull();

    await started.client.withdrawConsent();
    expect(calls.at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "denied",
      },
    ]);
    started.destroy();
    window.close();
  });

  it("canonicalizes declarative Google mapping identifiers before broadcasting grants", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const calls: unknown[][] = [];
    const started = bootstrapOpenCookie({
      document,
      googleConsentMode: {
        command: (...call) => calls.push(call),
        mapping: { analyticsStorageResourceIds: [" Analytics-Script "] },
        mode: "basic",
      },
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });

    await started.ready;
    await started.client.acceptAll();
    const update = calls.at(-1);
    started.destroy();
    window.close();

    expect(update).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "granted",
      },
    ]);
  });

  it("captures an inherited Google mapping once before caller mutation", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const calls: unknown[][] = [];
    const resourceIds = [" Analytics-Script "];
    let mappingReads = 0;
    class InheritedMapping {
      get analyticsStorageResourceIds(): readonly string[] {
        mappingReads += 1;
        return resourceIds;
      }
    }
    const started = bootstrapOpenCookie({
      document,
      googleConsentMode: {
        command: (...call) => calls.push(call),
        mapping: new InheritedMapping(),
        mode: "basic",
      },
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    resourceIds[0] = "missing-resource";

    await started.ready;
    await started.client.acceptAll();
    const update = calls.at(-1);
    started.destroy();
    window.close();

    expect({ mappingReads, update }).toEqual({
      mappingReads: 1,
      update: [
        "consent",
        "update",
        {
          ad_personalization: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          analytics_storage: "granted",
        },
      ],
    });
  });

  it("rejects hidden Google mapping identifiers before bootstrap effects", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const calls: unknown[][] = [];
    let started: ReturnType<typeof bootstrapOpenCookie> | undefined;
    let thrown: unknown;

    try {
      started = bootstrapOpenCookie({
        document,
        googleConsentMode: {
          command: (...call) => calls.push(call),
          mapping: { analyticsStorageResourceIds: ["ana\u200Blytics"] },
          mode: "basic",
        },
      });
    } catch (error) {
      thrown = error;
    }

    const effects = {
      root: document.querySelector("[data-oc-root]") !== null,
      style: document.querySelector("style[data-opencookie]") !== null,
    };
    started?.destroy();
    window.close();

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty(
      "message",
      "The OpenCookie Google Consent Mode resource mapping is invalid.",
    );
    expect({ calls, effects }).toEqual({
      calls: [],
      effects: { root: false, style: false },
    });
  });

  it("rejects sparse Google mapping arrays before bootstrap effects", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const calls: unknown[][] = [];
    let started: ReturnType<typeof bootstrapOpenCookie> | undefined;
    let thrown: unknown;

    try {
      started = bootstrapOpenCookie({
        document,
        googleConsentMode: {
          command: (...call) => calls.push(call),
          mapping: {
            analyticsStorageResourceIds: new Array<string>(1),
          },
          mode: "basic",
        },
      });
    } catch (error) {
      thrown = error;
    }

    const effects = {
      root: document.querySelector("[data-oc-root]") !== null,
      style: document.querySelector("style[data-opencookie]") !== null,
    };
    started?.destroy();
    window.close();

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty(
      "message",
      "The OpenCookie Google Consent Mode resource mapping is invalid.",
    );
    expect({ calls, effects }).toEqual({
      calls: [],
      effects: { root: false, style: false },
    });
  });

  it("rejects a Google mapping above the total capture budget before bootstrap effects", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const calls: unknown[][] = [];
    let thrown: unknown;

    try {
      bootstrapOpenCookie({
        document,
        googleConsentMode: {
          command: (...call) => calls.push(call),
          mapping: {
            adStorageResourceIds: Array<string>(5_000).fill("advertising"),
            analyticsStorageResourceIds: Array<string>(5_001).fill("analytics"),
          },
          mode: "basic",
        },
      });
    } catch (error) {
      thrown = error;
    }

    const effects = {
      root: document.querySelector("[data-oc-root]") !== null,
      style: document.querySelector("style[data-opencookie]") !== null,
    };
    window.close();

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty(
      "message",
      "The OpenCookie Google Consent Mode resource mapping is invalid.",
    );
    expect({ calls, effects }).toEqual({
      calls: [],
      effects: { root: false, style: false },
    });
  });

  it("ignores an overridden mapping array method and rejects its hidden entry before effects", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const calls: unknown[][] = [];
    const resourceIds = ["ana\u200Blytics"];
    let mapCalls = 0;
    Object.defineProperty(resourceIds, "map", {
      value: () => {
        mapCalls += 1;
        return new Array<string>(1);
      },
    });
    let started: ReturnType<typeof bootstrapOpenCookie> | undefined;
    let thrown: unknown;

    try {
      started = bootstrapOpenCookie({
        document,
        googleConsentMode: {
          command: (...call) => calls.push(call),
          mapping: { analyticsStorageResourceIds: resourceIds },
          mode: "basic",
        },
      });
    } catch (error) {
      thrown = error;
    }

    const effects = {
      root: document.querySelector("[data-oc-root]") !== null,
      style: document.querySelector("style[data-opencookie]") !== null,
    };
    started?.destroy();
    window.close();

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty(
      "message",
      "The OpenCookie Google Consent Mode resource mapping is invalid.",
    );
    expect({ calls, effects, mapCalls }).toEqual({
      calls: [],
      effects: { root: false, style: false },
      mapCalls: 0,
    });
  });

  it("forwards the exact active port context to the caller broadcast", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    let receivedContext: OpenCookiePortContext | undefined;
    const started = bootstrapOpenCookie({
      broadcast: (_effect, context?: OpenCookiePortContext) => {
        receivedContext = context;
        return Promise.resolve();
      },
      document: window.document as unknown as Document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });

    await started.ready;
    await started.client.acceptAll();

    expect(receivedContext).toBeDefined();
    if (receivedContext === undefined) {
      throw new Error("The broadcast must receive its grant port context.");
    }
    await expect(receivedContext.rejectAll()).rejects.toThrow(
      "OpenCookie port context is no longer active.",
    );

    started.destroy();
    window.close();
  });

  it("accepts a caller-owned decision store without touching Web Storage", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const memory = capturingStore();
    const started = bootstrapOpenCookie({
      document: window.document as unknown as Document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      store: memory.store,
    });

    await started.ready;
    await started.client.rejectAll();

    expect(memory.records).toHaveLength(1);
    expect(memory.records[0]).toMatchObject({
      record: {
        method: "reject-all",
        policyVersion: "policy-1",
      },
    });
    expect(window.localStorage.length).toBe(0);
    started.destroy();
    window.close();
  });

  it("rejects ambiguous custom-store and Web Storage configuration", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const memory = capturingStore();
    let started: ReturnType<typeof bootstrapOpenCookie> | undefined;
    let failure: unknown;

    try {
      started = bootstrapOpenCookie({
        document: window.document as unknown as Document,
        storage: window.localStorage,
        store: memory.store,
      });
    } catch (error) {
      failure = error;
    }

    started?.destroy();
    window.close();
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toMatch(/store.*storage|storage.*store/i);
  });

  it("falls back to deterministic identifiers when randomUUID is unavailable", async () => {
    const window = new Window({ url: "http://shop.example.test/" });
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    const started = bootstrapOpenCookie({
      document: window.document as unknown as Document,
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
      storageKey: "insecure-context-consent",
    });

    await started.ready;
    await expect(started.client.acceptAll()).resolves.toMatchObject({
      outcome: "committed",
    });
    expect(window.localStorage.getItem("insecure-context-consent")).toContain(
      '"recordId":"record-1700000000000-1"',
    );
    started.destroy();
    window.close();
  });

  it("creates a complete persistent client for the no-build browser path", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      policyVersion: "notice-2",
      storage: window.localStorage,
      storageKey: "consent-fixture",
    });

    await started.ready;
    expect(window.document.querySelector("[data-oc-root]")).not.toBeNull();

    await started.client.rejectAll();
    expect(window.localStorage.getItem("consent-fixture")).toContain(
      '"policyVersion":"notice-2"',
    );

    started.destroy();
    expect(window.document.querySelector("[data-oc-root]")).toBeNull();
  });

  it("re-probes default Web Storage when a failed grant is retried", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const storage = installRecoverableDefaultStorage(window);
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storageKey: "recoverable-default-storage",
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settleDom();

    expect(storage.storage.getItem("recoverable-default-storage")).toBeNull();
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    const readsBeforeRetry = storage.readCount();
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-pending-grant"]',
    );
    expect(retry).not.toBeNull();

    storage.makeAvailable();
    retry?.click();
    await settleDom();

    expect(storage.readCount()).toBeGreaterThan(readsBeforeRetry);
    expect(storage.storage.getItem("recoverable-default-storage")).toContain(
      '"method":"accept-all"',
    );
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      lastPersistenceStatus: "confirmed",
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();

    started.destroy();
    window.close();
  });

  it("retries a grant after getItem recovers on a resolved Storage handle", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const durableStorage = window.localStorage;
    let getterReads = 0;
    let methodReads = 0;
    let methodWrites = 0;
    let readAvailable = true;
    const resolvedStorage = {
      getItem: (key: string) => {
        methodReads += 1;
        if (!readAvailable) throw transientStorageError();
        return durableStorage.getItem(key);
      },
      removeItem: (key: string) => {
        durableStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        methodWrites += 1;
        durableStorage.setItem(key, value);
      },
    } as unknown as Storage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        getterReads += 1;
        return resolvedStorage;
      },
    });
    const storageKey = "resolved-handle-read-recovery";
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storageKey,
    });
    await started.ready;
    // The store reads once and the watch for another tab's decision reads once,
    // both through the one resolved handle.
    expect({ getterReads, methodReads }).toEqual({
      getterReads: 1,
      methodReads: 2,
    });

    readAvailable = false;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settleDom();

    expect(durableStorage.getItem(storageKey)).toBeNull();
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    const readsBeforeRetry = methodReads;
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-pending-grant"]',
    );
    expect(retry).not.toBeNull();
    if (retry === null) throw new Error("The pending grant must be retryable.");

    readAvailable = true;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    pressEnter(window, retry);
    await settleDom();

    expect(methodReads).toBeGreaterThan(readsBeforeRetry);
    expect(getterReads).toBe(1);
    const snapshotAfterRetry = started.client.getSnapshot();
    expect({
      activeResource:
        document.querySelector(
          '[data-oc-active-resource="analytics-script"]',
        ) !== null,
      alertVisible: document.querySelector('[role="alert"]') !== null,
      grantActivation: snapshotAfterRetry.grantActivation,
      methodWrites,
      persistence: snapshotAfterRetry.lastPersistenceStatus,
      storedAcceptAll:
        durableStorage.getItem(storageKey)?.includes('"method":"accept-all"') ??
        false,
    }).toMatchObject({
      activeResource: true,
      alertVisible: false,
      grantActivation: "active",
      methodWrites: 2,
      persistence: "confirmed",
      storedAcceptAll: true,
    });
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();

    started.destroy();
    window.close();
  });

  it("keeps a confirmed storage handle through grant readback and reload", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const storage = window.localStorage;
    let getterReads = 0;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        getterReads += 1;
        if (getterReads >= 4 && getterReads <= 6) {
          throw transientStorageError();
        }
        return storage;
      },
    });
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const storageKey = "confirmed-storage-handle";
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storageKey,
    });
    await started.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settleDom();

    const firstSnapshot = started.client.getSnapshot();
    const readsAfterDecision = getterReads;
    const activeAfterDecision = document.querySelectorAll(
      '[data-oc-active-resource="analytics-script"]',
    ).length;
    started.destroy();

    const firstReload = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_001,
      storageKey,
    });
    await firstReload.ready;
    const activeAfterFirstReload = document.querySelectorAll(
      '[data-oc-active-resource="analytics-script"]',
    ).length;
    firstReload.destroy();

    const secondReload = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_002,
      storageKey,
    });
    await secondReload.ready;

    expect({
      activeAfterDecision,
      activeAfterFirstReload,
      activeAfterSecondReload: document.querySelectorAll(
        '[data-oc-active-resource="analytics-script"]',
      ).length,
      firstActivation: firstSnapshot.grantActivation,
      firstPersistence: firstSnapshot.lastPersistenceStatus,
      readsAfterDecision,
      totalGetterReads: getterReads,
    }).toEqual({
      activeAfterDecision: 1,
      activeAfterFirstReload: 1,
      activeAfterSecondReload: 1,
      firstActivation: "active",
      firstPersistence: "confirmed",
      readsAfterDecision: 1,
      totalGetterReads: 3,
    });
    expect(storage.getItem(storageKey)).toContain('"method":"accept-all"');

    secondReload.destroy();
    window.close();
  });

  it("does not overwrite a durable record hidden by an initial getter failure", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const storage = window.localStorage;
    const storageKey = "recovered-existing-record";
    const seeded = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage,
      storageKey,
    });
    await seeded.ready;
    await seeded.client.rejectAll();
    const durableBefore = storage.getItem(storageKey);
    seeded.destroy();

    let getterReads = 0;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        getterReads += 1;
        if (getterReads === 1) throw transientStorageError();
        return storage;
      },
    });
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_001,
      storageKey,
    });
    await started.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settleDom();

    expect(storage.getItem(storageKey)).toBe(durableBefore);
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );

    started.destroy();
    window.close();
  });

  it("retries getter resolution without masking a Storage method failure", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const methodFailure = new Error("Storage read outcome is unknown.");
    const storage = {
      getItem: () => {
        throw methodFailure;
      },
      removeItem: () => undefined,
      setItem: () => undefined,
    } as unknown as Storage;
    let getterReads = 0;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        getterReads += 1;
        if (getterReads === 1) throw transientStorageError();
        return storage;
      },
    });
    const facade = defaultBrowserStorage(document);

    expect(facade.getItem("consent")).toBeNull();
    expect(() => facade.getItem("consent")).toThrow(methodFailure);

    window.close();
  });

  it("lets the watch for another tab read the default facade without permitting a write", () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    window.localStorage.setItem("consent", "stored");
    const facade = defaultBrowserStorage(document);

    expect(facade.peek("consent")).toBe("stored");
    expect(() => {
      facade.setItem("consent", "overwritten");
    }).toThrow("Browser local storage must be read successfully");
    expect(facade.getItem("consent")).toBe("stored");
    facade.setItem("consent", "written after a read");
    expect(facade.peek("consent")).toBe("written after a read");
    expect(() => {
      facade.setItem("consent", "overwritten");
    }).toThrow("Browser local storage must be read successfully");

    window.close();
  });

  it("allows unconditional store clearing through a fresh default facade", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const storageKey = "unconditional-default-clear";
    window.localStorage.setItem(storageKey, "stale");
    const store = createLocalStorageDecisionStore({
      key: storageKey,
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      storage: defaultBrowserStorage(document),
    });

    await expect(store.clear()).resolves.toBeUndefined();
    expect(window.localStorage.getItem(storageKey)).toBeNull();

    window.close();
  });

  it("keeps a quota-failed grant visible and retryable until storage confirms it", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    let storageAvailable = false;
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => {
        window.localStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (!storageAvailable) {
          const error = new Error("The storage quota was exceeded.");
          error.name = "QuotaExceededError";
          throw error;
        }
        window.localStorage.setItem(key, value);
      },
    };
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage,
      storageKey: "quota-failure-consent",
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settleDom();

    expect(window.localStorage.getItem("quota-failure-consent")).toBeNull();
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });
    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-pending-grant"]',
    );
    expect(retry).not.toBeNull();

    storageAvailable = true;
    retry?.click();
    await settleDom();

    expect(window.localStorage.getItem("quota-failure-consent")).toContain(
      '"method":"accept-all"',
    );
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      lastPersistenceStatus: "confirmed",
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();

    started.destroy();
    window.close();
  });

  it("keeps a failed rejection visible, blocked, and retryable", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const storageKey = "failed-rejection";
    let writeAvailable = false;
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => {
        window.localStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (!writeAvailable) throw new Error("Storage write unavailable.");
        window.localStorage.setItem(key, value);
      },
    };
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage,
      storageKey,
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
      ?.click();
    await settleDom();

    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(started.client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "failed",
      record: { method: "reject-all" },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    const reject = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="reject-all"]',
    );
    expect(reject).not.toBeNull();
    if (reject === null) throw new Error("The rejection must be retryable.");

    writeAvailable = true;
    reject.focus();
    expect(document.activeElement).toBe(reject);
    pressEnter(window, reject);
    await settleDom();

    expect(window.localStorage.getItem(storageKey)).toContain(
      '"method":"reject-all"',
    );
    expect(started.client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "confirmed",
      record: { method: "reject-all" },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();

    started.destroy();
    window.close();
  });

  it("keeps a failed withdrawal visible and blocked until its visible retry succeeds", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(resource);
    const storageKey = "failed-withdrawal";
    let storageAvailable = true;
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => {
        if (!storageAvailable) throw new Error("Storage remove unavailable.");
        window.localStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (!storageAvailable) throw new Error("Storage write unavailable.");
        window.localStorage.setItem(key, value);
      },
    };
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage,
      storageKey,
    });
    await started.ready;
    await started.client.acceptAll();
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="open"]')
      ?.click();

    storageAvailable = false;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="withdraw"]')
      ?.click();
    await settleDom();

    expect(window.localStorage.getItem(storageKey)).toContain(
      '"method":"accept-all"',
    );
    expect(started.client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "failed",
      record: { method: "withdrawal" },
      runtime: { consentEvaluation: { status: "withdrawn" } },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    expect(document.querySelector('[data-oc-action="withdraw"]')).toBeNull();
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    const noticeRetry = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-withdrawal"]',
    );
    expect(noticeRetry).not.toBeNull();
    if (noticeRetry === null) {
      throw new Error("The failed withdrawal must be visibly retryable.");
    }

    storageAvailable = true;
    noticeRetry.focus();
    expect(document.activeElement).toBe(noticeRetry);
    pressEnter(window, noticeRetry);
    await settleDom();

    expect(window.localStorage.getItem(storageKey)).toContain(
      '"method":"withdrawal"',
    );
    expect(started.client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "confirmed",
      record: { method: "withdrawal" },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.open).toBe(false);

    started.destroy();
    window.close();
  });

  // A granular save that grants nothing never becomes a pending grant, so it
  // had no retry: the visitor saw the failure and could only start over.
  it("offers a retry when a granular save that grants nothing fails to persist", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const storageKey = "failed-granular-deny";
    let storageAvailable = true;
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => {
        if (!storageAvailable) throw new Error("Storage remove unavailable.");
        window.localStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (!storageAvailable) throw new Error("Storage write unavailable.");
        window.localStorage.setItem(key, value);
      },
    };
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage,
      storageKey,
    });
    await started.ready;
    await started.client.acceptAll();
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="open"]')
      ?.click();
    const purpose = settingsPanel(document).querySelector<HTMLInputElement>(
      '.oc-purpose input[type="checkbox"]',
    );
    expect(purpose?.checked).toBe(true);
    purpose?.click();
    expect(purpose?.checked).toBe(false);

    storageAvailable = false;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settleDom();

    expect(started.client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "failed",
      record: { method: "granular" },
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-save"]',
    );
    expect(retry).not.toBeNull();
    if (retry === null) throw new Error("The failed save must be retryable.");

    storageAvailable = true;
    retry.click();
    await settleDom();

    expect(window.localStorage.getItem(storageKey)).toContain(
      '"method":"granular"',
    );
    expect(started.client.getSnapshot()).toMatchObject({
      lastPersistenceStatus: "confirmed",
      record: { method: "granular" },
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();

    started.destroy();
    window.close();
  });

  it("keeps a quota-failed granular choice aligned with its retry", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    let storageAvailable = false;
    const storage = {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => {
        window.localStorage.removeItem(key);
      },
      setItem: (key: string, value: string) => {
        if (!storageAvailable) throw new Error("Storage unavailable.");
        window.localStorage.setItem(key, value);
      },
    };
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      policyDefinition: selectivePolicyDefinition(
        "Understand aggregate site usage.",
      ),
      storage,
      storageKey: "granular-quota-failure",
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    document
      .querySelector<HTMLInputElement>('input[value="analytics"]')
      ?.click();
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settleDom();

    expect(started.client.getSnapshot()).toMatchObject({
      pendingGrant: { phase: "persistence" },
    });
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="open"]')
      ?.click();
    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(true);

    storageAvailable = true;
    document
      .querySelector<HTMLButtonElement>(
        '[data-oc-action="retry-pending-grant"]',
      )
      ?.click();
    await settleDom();

    expect(window.localStorage.getItem("granular-quota-failure")).toContain(
      '"method":"granular"',
    );
    expect(window.localStorage.getItem("granular-quota-failure")).toContain(
      '"analytics":"granted"',
    );

    started.destroy();
    window.close();
  });

  it("fails closed for hostile null policy history while undefined defaults", async () => {
    const restoreWithPolicyHistory = async (
      policyHistory: null | undefined,
    ) => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      const script = document.createElement("script");
      script.type = "text/plain";
      script.dataset["ocCategory"] = "analytics";
      script.dataset["ocResource"] = "analytics-script";
      script.dataset["src"] = "https://tracker.example.test/analytics.js";
      document.head.append(script);

      const initial = bootstrapOpenCookie({
        document,
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
        storage: window.localStorage,
        storageKey: "hostile-policy-history",
      });
      await initial.ready;
      await initial.client.acceptAll();
      initial.destroy();

      let restored: ReturnType<typeof bootstrapOpenCookie>;
      try {
        restored = bootstrapOpenCookie({
          document,
          idGenerator: idGenerator(),
          now: () => 1_700_000_000_001,
          policyHistory,
          storage: window.localStorage,
          storageKey: "hostile-policy-history",
        } as unknown as BootstrapOpenCookieOptions);
      } catch (error) {
        window.close();
        throw error;
      }
      await restored.ready;

      const result = {
        activeResources: document.querySelectorAll(
          '[data-oc-active-resource="analytics-script"]',
        ).length,
        snapshot: restored.client.getSnapshot(),
      };
      restored.destroy();
      window.close();
      return result;
    };

    const omitted = await restoreWithPolicyHistory(undefined);
    expect(omitted.snapshot.runtime).toMatchObject({
      accessConsent: {
        decisions: [{ decision: "granted", purposeId: "analytics" }],
        status: "active",
      },
      consentEvaluation: { status: "active" },
      policyReconciliation: { prompt: false, status: "current" },
    });
    expect(omitted.activeResources).toBe(1);

    await expect(restoreWithPolicyHistory(null)).rejects.toThrow(
      "Invalid consent runtime policy history.",
    );
  });

  it("reads hostile policy history once before forwarding it to core", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const script = document.createElement("script");
    script.type = "text/plain";
    script.dataset["ocCategory"] = "analytics";
    script.dataset["ocResource"] = "analytics-script";
    script.dataset["src"] = "https://tracker.example.test/analytics.js";
    document.head.append(script);

    const initial = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
      storageKey: "stateful-policy-history",
    });
    await initial.ready;
    await initial.client.acceptAll();
    initial.destroy();

    let policyHistoryReads = 0;
    const options = {
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_001,
      storage: window.localStorage,
      storageKey: "stateful-policy-history",
    } as unknown as BootstrapOpenCookieOptions;
    Object.defineProperty(options, "policyHistory", {
      get: () => {
        policyHistoryReads += 1;
        return policyHistoryReads === 1 ? null : undefined;
      },
    });

    let failure: unknown;
    let restored: ReturnType<typeof bootstrapOpenCookie> | undefined;
    try {
      restored = bootstrapOpenCookie(options);
      await restored.ready;
    } catch (error) {
      failure = error;
    }
    const activeResources = document.querySelectorAll(
      '[data-oc-active-resource="analytics-script"]',
    ).length;
    restored?.destroy();
    window.close();

    expect(policyHistoryReads).toBe(1);
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain(
      "Invalid consent runtime policy history.",
    );
    expect(activeResources).toBe(0);
  });

  it("enforces declarative resources initially and after SPA insertion", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const first = document.createElement("script");
    first.type = "text/plain";
    first.dataset["ocCategory"] = "analytics";
    first.dataset["ocResource"] = "analytics-script";
    first.dataset["src"] = "https://tracker.example.test/first.js";
    document.head.append(first);
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });

    await started.ready;
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();

    await started.client.acceptAll();
    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);

    const second = document.createElement("script");
    second.type = "text/plain";
    second.dataset["ocCategory"] = "analytics";
    second.dataset["ocResource"] = "analytics-script";
    second.dataset["src"] = "https://tracker.example.test/second.js";
    document.head.append(second);
    await settleDom();

    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(2);

    await started.client.withdrawConsent();
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    started.destroy();
    window.close();
  });

  it("expires active consent in place through the product refresh lifecycle", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const script = document.createElement("script");
    script.type = "text/plain";
    script.dataset["ocCategory"] = "analytics";
    script.dataset["ocResource"] = "analytics-script";
    script.dataset["src"] = "https://tracker.example.test/first.js";
    document.head.append(script);
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let sequence = 0;
    const timerWindow = window as unknown as {
      setTimeout: (callback: () => void, delay?: number) => number;
      clearTimeout: (identifier: number) => void;
    };
    const nativeSetTimeout = timerWindow.setTimeout.bind(timerWindow);
    timerWindow.setTimeout = (callback, delay) => {
      if (delay === undefined || delay < 1_000) {
        return nativeSetTimeout(callback, delay);
      }
      const identifier = ++sequence;
      timers.set(identifier, { callback, delay });
      return identifier;
    };
    timerWindow.clearTimeout = (identifier) => {
      timers.delete(identifier);
    };
    let now = 1_700_000_000_000;
    const activeAtExpiryBroadcast: number[] = [];
    const started = bootstrapOpenCookie({
      broadcast: (effect) => {
        if (effect.runtime.consentEvaluation.status === "expired") {
          activeAtExpiryBroadcast.push(
            document.querySelectorAll(
              '[data-oc-active-resource="analytics-script"]',
            ).length,
          );
        }
        return Promise.resolve();
      },
      consentDurationMs: 60_000,
      document,
      idGenerator: idGenerator(),
      now: () => now,
      storage: window.localStorage,
    });

    await started.ready;
    await started.client.acceptAll();
    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);
    expect([...timers.values()].map(({ delay }) => delay)).toEqual([60_000]);

    now += 60_000;
    const [identifier, timer] = [...timers.entries()][0] ?? [];
    if (identifier === undefined || timer === undefined) {
      throw new Error("The product must arm an expiry timer.");
    }
    timers.delete(identifier);
    timer.callback();
    await settleDom();

    expect(started.client.getSnapshot()).toMatchObject({
      record: { method: "accept-all" },
      runtime: { consentEvaluation: { status: "expired" } },
    });
    expect(activeAtExpiryBroadcast).toEqual([0]);
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(timers.size).toBe(0);

    started.destroy();
    window.close();
  });

  it("withholds expiry broadcast until physical resource blocking succeeds", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const script = document.createElement("script");
    script.type = "text/plain";
    script.dataset["ocCategory"] = "analytics";
    script.dataset["ocResource"] = "analytics-script";
    script.dataset["src"] = "https://tracker.example.test/first.js";
    document.head.append(script);
    let now = 1_700_000_000_000;
    const activeAtExpiryBroadcast: number[] = [];
    const started = bootstrapOpenCookie({
      broadcast: (effect) => {
        if (effect.runtime.consentEvaluation.status === "expired") {
          activeAtExpiryBroadcast.push(
            document.querySelectorAll(
              '[data-oc-active-resource="analytics-script"]',
            ).length,
          );
        }
        return Promise.resolve();
      },
      consentDurationMs: 60_000,
      document,
      idGenerator: idGenerator(),
      now: () => now,
      storage: window.localStorage,
    });

    await started.ready;
    await started.client.acceptAll();
    const active = document.querySelector<HTMLElement>(
      '[data-oc-active-resource="analytics-script"]',
    );
    if (active === null)
      throw new Error("The optional resource must be active.");
    const removeActive = active.remove.bind(active);
    const removalFailure = new Error("Active resource removal unavailable.");
    const remove = vi
      .spyOn(active, "remove")
      .mockImplementation(() => {
        removeActive();
      })
      .mockImplementationOnce(() => {
        throw removalFailure;
      })
      .mockImplementationOnce(() => {
        throw removalFailure;
      });
    now += 60_000;

    await expect(started.client.refresh()).rejects.toThrow(
      "OpenCookie could not enforce 2 declarative resource operation(s).",
    );
    expect(activeAtExpiryBroadcast).toEqual([]);
    expect(active.isConnected).toBe(true);

    await expect(started.client.refresh()).resolves.toBe(
      started.client.getSnapshot(),
    );
    expect(activeAtExpiryBroadcast).toEqual([0]);
    expect(active.isConnected).toBe(false);
    expect(remove).toHaveBeenCalledTimes(3);

    remove.mockRestore();
    started.destroy();
    window.close();
  });

  it("schedules restored consent from the runtime logical clock", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    let elapsed = 0;
    const elapsedNow = vi
      .spyOn(window.performance, "now")
      .mockImplementation(() => elapsed);
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let sequence = 0;
    const timerWindow = window as unknown as {
      setTimeout: (callback: () => void, delay?: number) => number;
      clearTimeout: (identifier: number) => void;
    };
    const nativeSetTimeout = timerWindow.setTimeout.bind(timerWindow);
    timerWindow.setTimeout = (callback, delay) => {
      if (delay === undefined || delay < 1_000) {
        return nativeSetTimeout(callback, delay);
      }
      const identifier = ++sequence;
      timers.set(identifier, { callback, delay });
      return identifier;
    };
    timerWindow.clearTimeout = (identifier) => {
      timers.delete(identifier);
    };

    let now = 1_700_000_030_000;
    const first = bootstrapOpenCookie({
      consentDurationMs: 60_000,
      document,
      idGenerator: idGenerator(),
      now: () => now,
      storage: window.localStorage,
    });
    await first.ready;
    await first.client.acceptAll();
    expect([...timers.values()].map(({ delay }) => delay)).toEqual([60_000]);
    first.destroy();
    expect(timers.size).toBe(0);

    now = 1_700_000_000_000;
    const restored = bootstrapOpenCookie({
      consentDurationMs: 60_000,
      document,
      idGenerator: idGenerator(),
      now: () => now,
      storage: window.localStorage,
    });
    await restored.ready;

    expect(restored.client.getSnapshot()).toMatchObject({
      record: { decidedAt: 1_700_000_030_000 },
      runtime: { consentEvaluation: { status: "active" } },
    });
    expect([...timers.values()].map(({ delay }) => delay)).toEqual([60_000]);

    elapsed += 60_000;
    const [identifier, timer] = [...timers.entries()][0] ?? [];
    if (identifier === undefined || timer === undefined) {
      throw new Error("The restored product must arm an expiry timer.");
    }
    timers.delete(identifier);
    timer.callback();
    await settleDom();

    expect(restored.client.getSnapshot()).toMatchObject({
      record: { decidedAt: 1_700_000_030_000 },
      runtime: { consentEvaluation: { status: "expired" } },
    });
    expect(timers.size).toBe(0);

    restored.destroy();
    elapsedNow.mockRestore();
    window.close();
  });

  it("refreshes verified selective reconsent on pageshow and broadcasts restoration once", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    for (const [purposeId, resourceId] of [
      ["analytics", "analytics-script"],
      ["personalization", "personalization-script"],
    ] as const) {
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = purposeId;
      resource.dataset["ocResource"] = resourceId;
      resource.dataset["src"] = `https://tracker.example.test/${resourceId}.js`;
      document.head.append(resource);
    }

    const timers = new Map<number, { callback: () => void; delay: number }>();
    let timerSequence = 0;
    const timerWindow = window as unknown as {
      setTimeout: (callback: () => void, delay?: number) => number;
      clearTimeout: (identifier: number) => void;
    };
    const nativeSetTimeout = timerWindow.setTimeout.bind(timerWindow);
    timerWindow.setTimeout = (callback, delay) => {
      if (delay === undefined || delay < 1_000) {
        return nativeSetTimeout(callback, delay);
      }
      const identifier = ++timerSequence;
      timers.set(identifier, { callback, delay });
      return identifier;
    };
    timerWindow.clearTimeout = (identifier) => {
      timers.delete(identifier);
    };

    const previousDefinition = selectivePolicyDefinition(
      "Understand aggregate site usage.",
    );
    const currentDefinition = selectivePolicyDefinition(
      "Understand aggregate site usage and feature adoption.",
    );
    const previousPolicy = policySnapshot(previousDefinition, "policy-1");
    const currentPolicy = policySnapshot(currentDefinition, "policy-2");
    let now = 1_700_000_000_000;
    const previous = bootstrapOpenCookie({
      consentDurationMs: 60_000,
      document,
      idGenerator: idGenerator(),
      now: () => now,
      policyDefinition: previousDefinition,
      policyVersion: "policy-1",
      storage: window.localStorage,
      storageKey: "selective-consent",
    });
    await previous.ready;
    await previous.client.acceptAll();
    previous.destroy();

    const googleCalls: unknown[][] = [];
    const current = bootstrapOpenCookie({
      consentDurationMs: 60_000,
      document,
      googleConsentMode: {
        command: (...call) => googleCalls.push(call),
        mapping: {
          analyticsStorageResourceIds: ["personalization-script"],
        },
        mode: "basic",
      },
      idGenerator: idGenerator(),
      now: () => now,
      policyDefinition: currentDefinition,
      policyHistory: [currentPolicy, previousPolicy],
      policyVersion: "policy-2",
      storage: window.localStorage,
      storageKey: "selective-consent",
    });
    await current.ready;

    const restored = current.client.getSnapshot();
    expect(restored).toMatchObject({
      record: { policy: { policyVersion: "policy-1" } },
      runtime: {
        accessConsent: { status: "requires-reconsent" },
        consentEvaluation: { status: "invalid" },
        policyReconciliation: { status: "requires-reconsent" },
      },
    });
    expect(restored.runtime.accessConsent.decisions).toEqual([
      { decision: "unresolved", purposeId: "analytics" },
      { decision: "granted", purposeId: "personalization" },
    ]);
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-oc-active-resource="personalization-script"]',
      ),
    ).not.toBeNull();
    expect(googleCalls.filter((call) => call[1] === "update")).toEqual([
      [
        "consent",
        "update",
        {
          ad_personalization: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          analytics_storage: "granted",
        },
      ],
    ]);
    expect([...timers.values()].map(({ delay }) => delay)).toEqual([60_000]);

    const historicalRecord = restored.record;
    now += 60_000;
    window.dispatchEvent(new window.Event("pageshow"));
    await settleDom();

    const expired = current.client.getSnapshot();
    expect(expired.record).toBe(historicalRecord);
    expect(expired.runtime).toMatchObject({
      accessConsent: { status: "expired" },
      policyReconciliation: { status: "expired" },
    });
    expect(document.querySelector("[data-oc-active-resource]")).toBeNull();
    expect(googleCalls.at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "denied",
      },
    ]);
    expect(timers.size).toBe(0);

    current.destroy();
    window.close();
  });

  it("TEST-BOOTSTRAP-DESTROY-CLEANUP leaves no active resource across remount", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const placeholder = document.createElement("template");
    placeholder.dataset["ocIframe"] = "";
    placeholder.dataset["ocCategory"] = "analytics";
    placeholder.dataset["ocResource"] = "product-video";
    placeholder.dataset["src"] = "https://tracker.example.test/frame";
    placeholder.title = "Optional product video";
    document.body.append(placeholder);

    const first = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await first.ready;
    await first.client.acceptAll();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      1,
    );

    first.destroy();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );

    const second = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_001,
      storage: window.localStorage,
    });
    await second.ready;
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      1,
    );

    await second.client.withdrawConsent();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );
    second.destroy();
    window.close();
  });

  it("TEST-BOOTSTRAP-DESTROY-CANCEL prevents pending restoration after teardown", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const placeholder = document.createElement("template");
    placeholder.dataset["ocIframe"] = "";
    placeholder.dataset["ocCategory"] = "analytics";
    placeholder.dataset["ocResource"] = "product-video";
    placeholder.dataset["src"] = "https://tracker.example.test/frame";
    document.body.append(placeholder);

    const seed = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await seed.ready;
    await seed.client.acceptAll();
    seed.destroy();
    for (const active of document.querySelectorAll(
      "[data-oc-active-resource]",
    )) {
      active.remove();
    }

    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_001,
      storage: window.localStorage,
    });
    const ready = started.ready;
    started.destroy();
    await ready;

    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );
    window.close();
  });

  it("TEST-SPA-RESOURCE-REMOVAL stops an active iframe with its declaration", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const placeholder = document.createElement("template");
    placeholder.dataset["ocIframe"] = "";
    placeholder.dataset["ocCategory"] = "analytics";
    placeholder.dataset["ocResource"] = "product-video";
    placeholder.dataset["src"] = "https://tracker.example.test/frame";
    document.body.append(placeholder);
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;
    await started.client.acceptAll();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      1,
    );

    placeholder.remove();
    await settleDom();

    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );
    started.destroy();
    window.close();
  });

  it("TEST-BOOTSTRAP-LISTENER-DISPOSAL removes legacy lifecycle handlers", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const iframe = document.createElement("iframe");
    iframe.dataset["ocCategory"] = "analytics";
    iframe.dataset["ocResource"] = "product-video";
    iframe.dataset["src"] = "https://tracker.example.test/frame";
    document.body.append(iframe);
    const started = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;
    await started.client.acceptAll();

    started.destroy();
    expect(iframe.isConnected).toBe(true);
    expect(iframe.hasAttribute("data-oc-active-resource")).toBe(false);
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );

    const pageHide = new window.Event("pagehide");
    Object.defineProperty(pageHide, "persisted", { value: false });
    window.dispatchEvent(pageHide);

    expect(iframe.isConnected).toBe(true);
    expect(
      document.querySelector(
        'iframe[data-oc-resource="product-video"]:not([data-oc-active-resource])',
      ),
    ).toBe(iframe);
    window.close();
  });
});

describe("the auto IIFE entry", () => {
  it("re-probes default Web Storage when an auto grant is retried", async () => {
    const window = new Window({ url: "https://app.opencookie.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.opencookie.test/analytics.js";
    document.head.append(resource);
    const script = document.createElement("script");
    script.dataset["ocStorageKey"] = "recoverable-auto-storage";
    document.head.append(script);
    const storage = installRecoverableDefaultStorage(window);
    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settleDom();

    expect(storage.storage.getItem("recoverable-auto-storage")).toBeNull();
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    const readsBeforeRetry = storage.readCount();
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-pending-grant"]',
    );
    expect(retry).not.toBeNull();

    storage.makeAvailable();
    retry?.click();
    await settleDom();

    expect(storage.readCount()).toBeGreaterThan(readsBeforeRetry);
    expect(storage.storage.getItem("recoverable-auto-storage")).toContain(
      '"method":"accept-all"',
    );
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      lastPersistenceStatus: "confirmed",
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();

    started.destroy();
    window.close();
  });

  it("retries an auto cookie grant after suppressed writes start taking effect", async () => {
    const window = new Window({ url: "https://app.opencookie.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.opencookie.test/analytics.js";
    document.head.append(resource);
    const script = document.createElement("script");
    script.dataset["ocStorage"] = "cookie";
    script.dataset["ocStorageKey"] = "suppressed-auto-cookie";
    document.head.append(script);
    let header = "";
    let writesTakeEffect = false;
    const writes: string[] = [];
    const cookieJar = {
      read: () => header,
      write: (serializedCookie: string) => {
        writes.push(serializedCookie);
        if (!writesTakeEffect) return;
        const pair = serializedCookie.split(";", 1)[0] ?? "";
        header = pair.endsWith("=") ? "" : pair;
      },
    };
    const started = startAutoBootstrap(document, script, {
      cookieJar,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settleDom();

    expect(header).toBe("");
    expect(writes.length).toBeGreaterThan(0);
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "pending",
      pendingGrant: { phase: "persistence" },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /could(?: not|n't) save/i,
    );
    const writesBeforeRetry = writes.length;
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="retry-pending-grant"]',
    );
    expect(retry).not.toBeNull();
    if (retry === null) throw new Error("The cookie grant must be retryable.");

    writesTakeEffect = true;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    pressEnter(window, retry);
    await settleDom();

    expect(writes.length).toBeGreaterThan(writesBeforeRetry);
    expect(decodeURIComponent(header)).toContain('"method":"accept-all"');
    expect(started.client.getSnapshot()).toMatchObject({
      grantActivation: "active",
      lastPersistenceStatus: "confirmed",
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).not.toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();

    started.destroy();
    window.close();
  });

  it("resolves explicit GPC inputs without manufacturing a consent decision", async () => {
    const window = new Window({ url: "https://app.opencookie.test/" });
    Object.defineProperty(window.navigator, "globalPrivacyControl", {
      configurable: true,
      value: true,
    });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.opencookie.test/a.js";
    document.head.append(resource);
    const calls: unknown[][] = [];
    Object.assign(window, {
      gtag: (...call: unknown[]) => calls.push(call),
    });
    const script = document.createElement("script");
    script.dataset["ocGoogleAnalyticsResource"] = "analytics-script";
    script.dataset["ocGoogleConsentMode"] = "basic";
    script.dataset["ocGpcPurposeId"] = "analytics";
    script.dataset["ocServerGpc"] = "enabled";
    document.head.append(script);

    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;
    await started.client.acceptAll();

    const snapshot = started.client.getSnapshot();
    expect(snapshot).toMatchObject({
      record: {
        decisions: [{ purposeId: "analytics", value: "granted" }],
        method: "accept-all",
      },
      runtime: {
        effectiveAccess: {
          resources: [
            {
              access: "blocked",
              resourceId: "analytics-script",
            },
          ],
        },
      },
    });
    expect(
      snapshot.runtime.effectiveAccess.resources[0]?.blockReasons,
    ).toContain("privacy-signal");
    expect(calls.map((call) => call[1])).toEqual(["default", "update"]);
    expect(calls.at(-1)).toMatchObject([
      "consent",
      "update",
      { analytics_storage: "denied" },
    ]);
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    started.destroy();
    window.close();
  });

  it("persists the actual consent record across explicitly shared subdomains", async () => {
    const jar = memoryCookieJar();
    const firstWindow = new Window({ url: "https://app.opencookie.test/" });
    const firstScript = firstWindow.document.createElement("script");
    firstScript.dataset["ocStorage"] = "cookie";
    firstScript.dataset["ocStorageKey"] = "opencookie-consent";
    firstScript.dataset["ocCookieDomain"] = "opencookie.test";
    firstScript.dataset["ocRegistrableDomain"] = "opencookie.test";
    firstWindow.document.head.append(firstScript);

    const first = startAutoBootstrap(
      firstWindow.document as unknown as Document,
      firstScript as unknown as HTMLScriptElement,
      {
        cookieJar: jar,
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
      },
    );
    await first.ready;
    await first.client.rejectAll();

    expect(jar.writes.at(-1)).toContain("Domain=opencookie.test");
    expect(jar.writes.at(-1)).toContain("Max-Age=15552000");
    expect(jar.writes.at(-1)).toContain("SameSite=Lax");
    expect(jar.writes.at(-1)).toContain("Secure");

    const secondWindow = new Window({ url: "https://shop.opencookie.test/" });
    const secondScript = secondWindow.document.createElement("script");
    secondScript.dataset["ocStorage"] = "cookie";
    secondScript.dataset["ocStorageKey"] = "opencookie-consent";
    secondScript.dataset["ocCookieDomain"] = "opencookie.test";
    secondScript.dataset["ocRegistrableDomain"] = "opencookie.test";
    secondWindow.document.head.append(secondScript);
    const second = startAutoBootstrap(
      secondWindow.document as unknown as Document,
      secondScript as unknown as HTMLScriptElement,
      {
        cookieJar: jar,
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_001,
      },
    );
    await second.ready;

    expect(second.client.getSnapshot()).toMatchObject({
      record: {
        decisions: [{ purposeId: "analytics", value: "denied" }],
        method: "reject-all",
      },
      runtime: { consentEvaluation: { prompt: false } },
    });

    first.destroy();
    second.destroy();
    firstWindow.close();
    secondWindow.close();
  });

  it("keeps plain auto current-only and conservative after a policy change", async () => {
    const window = new Window({ url: "https://app.opencookie.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.opencookie.test/a.js";
    document.head.append(resource);
    const firstScript = document.createElement("script");
    firstScript.dataset["ocPolicyVersion"] = "notice-1";
    firstScript.dataset["ocStorageKey"] = "auto-policy-history";
    document.head.append(firstScript);
    const first = startAutoBootstrap(document, firstScript, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await first.ready;
    await first.client.acceptAll();
    first.destroy();

    const secondScript = document.createElement("script");
    secondScript.dataset["ocPolicyVersion"] = "notice-2";
    secondScript.dataset["ocPurposeDescription"] =
      "Updated analytics disclosure.";
    secondScript.dataset["ocStorageKey"] = "auto-policy-history";
    document.head.append(secondScript);
    const second = startAutoBootstrap(document, secondScript, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_001,
      storage: window.localStorage,
    });
    await second.ready;

    const snapshot = second.client.getSnapshot();
    expect(snapshot.runtime.accessConsent.decisions).toEqual([
      { decision: "unresolved", purposeId: "analytics" },
    ]);
    expect(snapshot.runtime.accessConsent.status).not.toBe("active");
    expect(snapshot.runtime.consentEvaluation.prompt).toBe(true);
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();

    second.destroy();
    window.close();
  });

  it("uses one explicit consent duration for the record and cookie envelope", async () => {
    const jar = memoryCookieJar();
    const window = new Window({ url: "https://app.opencookie.test/" });
    const script = window.document.createElement("script");
    script.dataset["ocConsentDurationMs"] = "1000";
    script.dataset["ocStorage"] = "cookie";
    window.document.head.append(script);

    const started = startAutoBootstrap(
      window.document as unknown as Document,
      script as unknown as HTMLScriptElement,
      {
        cookieJar: jar,
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
      },
    );
    await started.ready;
    await started.client.acceptAll();

    expect(jar.writes.at(-1)).toContain("Max-Age=1;");
    expect(decodeURIComponent(jar.writes.at(-1) ?? "")).toContain(
      '"expiresAt":1700000001000',
    );
    started.destroy();
    window.close();
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects invalid consent duration markup: %s",
    (value) => {
      const window = new Window({ url: "https://app.opencookie.test/" });
      const script = window.document.createElement("script");
      script.dataset["ocConsentDurationMs"] = value;
      window.document.head.append(script);

      expect(() =>
        startAutoBootstrap(
          window.document as unknown as Document,
          script as unknown as HTMLScriptElement,
        ),
      ).toThrow(/positive safe integer/u);
      window.close();
    },
  );

  it("fails closed when shared-cookie boundary attributes are incomplete", () => {
    const window = new Window({ url: "https://app.opencookie.test/" });
    const script = window.document.createElement("script");
    script.dataset["ocStorage"] = "cookie";
    script.dataset["ocCookieDomain"] = "opencookie.test";
    window.document.head.append(script);
    let started: ReturnType<typeof startAutoBootstrap> | undefined;
    let failure: unknown;

    try {
      started = startAutoBootstrap(
        window.document as unknown as Document,
        script as unknown as HTMLScriptElement,
        { cookieJar: memoryCookieJar() },
      );
    } catch (error) {
      failure = error;
    }

    started?.destroy();
    window.close();
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toMatch(
      /cookie domain.*registrable domain|registrable domain.*cookie domain/i,
    );
  });

  it("reads conservative script attributes and mounts without inline code", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const script = document.createElement("script");
    script.dataset["ocPolicyVersion"] = "notice-3";
    script.dataset["ocStorageKey"] = "auto-consent";
    script.nonce = "fixture-nonce";
    const getAttribute = script.getAttribute.bind(script);
    script.getAttribute = (name: string): string | null =>
      name === "nonce" ? "" : getAttribute(name);
    document.head.append(script);

    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;

    expect(
      window.document
        .querySelector("style[data-opencookie]")
        ?.getAttribute("nonce"),
    ).toBe("fixture-nonce");
    await started.client.rejectAll();
    expect(window.localStorage.getItem("auto-consent")).toContain(
      '"policyVersion":"notice-3"',
    );
  });

  it("publishes the auto entry as the one-line CDN target", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly unpkg?: string };

    expect(manifest.unpkg).toBe("./dist/auto.iife.js");
  });
});
