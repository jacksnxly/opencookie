import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type LocalStorageDecisionStore,
  type OpenCookie,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { bootstrapOpenCookie, mountOpenCookie } from "./index.js";

// A tab of the site: a hand-wired client over storage every tab shares, and a
// window whose BroadcastChannel reaches the other tabs.
function openTab(
  name: string,
  storage: Map<string, string>,
  writeDelayMs = 0,
  key = "opencookie.consent",
): {
  readonly client: OpenCookie;
  readonly document: Document;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly window: Window;
} {
  const window = new Window({ url: "https://shop.example.test/" });
  Object.defineProperty(window, "BroadcastChannel", {
    configurable: true,
    value: globalThis.BroadcastChannel,
  });
  const reload = vi.fn();
  vi.spyOn(window.location, "reload").mockImplementation(reload);
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
  if (!resourcePolicy.ok)
    throw new Error("Test resource policy must be valid.");
  let sequence = 0;
  const client = createOpenCookie({
    consentDurationMs: 86_400_000,
    idGenerator: (kind) => `${kind}-${name}-${String((sequence += 1))}`,
    now: () => 1_700_000_000_000,
    policySnapshot: createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: policy.policy,
      policyVersion: "policy-1",
    }),
    reconcile: () => Promise.resolve(),
    resourcePolicy: resourcePolicy.resourcePolicy,
    store: delayedWrites(
      createLocalStorageDecisionStore({
        key,
        schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
        storage: {
          getItem: (key) => storage.get(key) ?? null,
          removeItem: (key) => {
            storage.delete(key);
          },
          setItem: (key, value) => {
            storage.set(key, value);
          },
        },
      }),
      writeDelayMs,
    ),
  });
  return {
    client,
    document: window.document as unknown as Document,
    reload,
    window,
  };
}

// A store whose writes land only after a delay, as a slow disk or a remote
// store would.
function delayedWrites<Store extends LocalStorageDecisionStore>(
  store: Store,
  delayMs: number,
): Store {
  return {
    ...store,
    compareAndSet: async (expected, candidate) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return store.compareAndSet(expected, candidate);
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

// A decision made in one tab reaches the site's other open tabs. They adopt it
// in place: the bar closes, the launcher appears, and nothing reloads, so a
// half-filled form in another tab survives. A tab reloads only when the new
// decision blocks something that may already have run there.
describe("adopting another tab's decision", () => {
  it("adopts a grant made in another tab without reloading", async () => {
    const storage = new Map<string, string>();
    const waiting = openTab("waiting", storage);
    const waitingMount = mountOpenCookie({
      client: waiting.client,
      document: waiting.document,
    });
    await waitingMount.ready;
    expect(waiting.document.querySelector(".oc-bar")).not.toBeNull();

    const deciding = openTab("deciding", storage);
    const decidingMount = mountOpenCookie({
      client: deciding.client,
      document: deciding.document,
    });
    await decidingMount.ready;
    await deciding.client.acceptAll();
    await vi.waitFor(
      () => {
        expect(waiting.client.getSnapshot().record?.method).toBe("accept-all");
      },
      { interval: 50, timeout: 2_000 },
    );
    await settle();

    expect(waiting.reload).not.toHaveBeenCalled();
    expect(waiting.document.querySelector(".oc-bar")).toBeNull();
    expect(
      waiting.document.querySelector('[data-oc-action="open"]'),
    ).not.toBeNull();

    waitingMount.destroy();
    decidingMount.destroy();
    waiting.window.close();
    deciding.window.close();
  });

  it("still reloads a tab when another tab withdraws what that tab allowed", async () => {
    const storage = new Map<string, string>();
    const deciding = openTab("deciding", storage);
    const decidingMount = mountOpenCookie({
      client: deciding.client,
      document: deciding.document,
    });
    await decidingMount.ready;
    await deciding.client.acceptAll();
    await settle();

    const other = openTab("other", storage);
    const otherMount = mountOpenCookie({
      client: other.client,
      document: other.document,
    });
    await otherMount.ready;
    expect(other.client.getSnapshot().record?.method).toBe("accept-all");
    await settle();

    await deciding.client.withdrawConsent();
    await vi.waitFor(
      () => {
        expect(other.reload).toHaveBeenCalled();
      },
      { interval: 50, timeout: 2_000 },
    );
    await settle();

    // A hand-wired client runs its own controllers, so the analytics resource
    // it allowed may have started: the tab reloads.
    expect(other.reload).toHaveBeenCalledTimes(1);

    decidingMount.destroy();
    otherMount.destroy();
    deciding.window.close();
    other.window.close();
  });

  it("adopts a grant on the bootstrap route without reloading", async () => {
    const shared = new Map<string, string>();
    const storage = {
      getItem: (key: string) => shared.get(key) ?? null,
      removeItem: (key: string) => {
        shared.delete(key);
      },
      setItem: (key: string, value: string) => {
        shared.set(key, value);
      },
    };
    const open = () => {
      const window = new Window({ url: "https://shop.example.test/" });
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: globalThis.BroadcastChannel,
      });
      const reload = vi.fn();
      vi.spyOn(window.location, "reload").mockImplementation(reload);
      const document = window.document as unknown as Document;
      return { document, reload, window };
    };
    const waiting = open();
    const waitingStarted = bootstrapOpenCookie({
      document: waiting.document,
      storage,
    });
    await waitingStarted.ready;
    const deciding = open();
    const decidingStarted = bootstrapOpenCookie({
      document: deciding.document,
      storage,
    });
    await decidingStarted.ready;

    await decidingStarted.client.acceptAll();
    await vi.waitFor(
      () => {
        expect(waitingStarted.client.getSnapshot().record?.method).toBe(
          "accept-all",
        );
      },
      { interval: 50, timeout: 2_000 },
    );
    await settle();

    expect(waiting.reload).not.toHaveBeenCalled();
    expect(waiting.document.querySelector(".oc-bar")).toBeNull();

    waitingStarted.destroy();
    decidingStarted.destroy();
    waiting.window.close();
    deciding.window.close();
  });
});
