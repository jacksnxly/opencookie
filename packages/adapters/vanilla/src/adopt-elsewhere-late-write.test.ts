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

// In Firefox and WebKit the decision channel can deliver another tab's
// announcement before that tab's storage write is visible here. A tab that
// hears a decision converges on it anyway: it keeps adopting until it holds
// the announced decision, and reloads, as it did before adoption, if it cannot.

const LAG_MS = 300;

interface Shared {
  readonly truth: Map<string, string>;
  readonly views: Map<string, Map<string, string>>;
}

function sharedStorage(): Shared {
  return { truth: new Map(), views: new Map() };
}

// Each tab reads its own view. Its own writes land there at once; another
// tab's writes reach it only after LAG_MS.
function laggedView(shared: Shared, name: string) {
  const view = new Map(shared.truth);
  shared.views.set(name, view);
  const spread = (apply: (target: Map<string, string>) => void) => {
    apply(shared.truth);
    apply(view);
    for (const [other, target] of shared.views) {
      if (other !== name) {
        setTimeout(() => {
          apply(target);
        }, LAG_MS);
      }
    }
  };
  return {
    getItem: (key: string) => view.get(key) ?? null,
    removeItem: (key: string) => {
      spread((target) => target.delete(key));
    },
    setItem: (key: string, value: string) => {
      spread((target) => target.set(key, value));
    },
  };
}

// A tab of the site over storage whose writes reach the other tabs late: a hand-wired client over storage every tab shares, and a
// window whose BroadcastChannel reaches the other tabs.
function openTab(
  name: string,
  storage: Shared,
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
        storage: laggedView(storage, name),
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

describe("converging on a decision announced before its write is visible", () => {
  it("adopts a grant whose write reaches this tab late", async () => {
    const shared = sharedStorage();
    const waiting = openTab("waiting", shared);
    const waitingMount = mountOpenCookie({
      client: waiting.client,
      document: waiting.document,
    });
    await waitingMount.ready;
    const deciding = openTab("deciding", shared);
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
      { interval: 50, timeout: 3_000 },
    );
    await settle();

    expect(waiting.reload).not.toHaveBeenCalled();
    expect(waiting.document.querySelector(".oc-bar")).toBeNull();

    waitingMount.destroy();
    decidingMount.destroy();
    waiting.window.close();
    deciding.window.close();
  });

  it("still reloads a tab whose allowed resource another tab withdraws, when the write reaches it late", async () => {
    const shared = sharedStorage();
    const deciding = openTab("deciding", shared);
    const decidingMount = mountOpenCookie({
      client: deciding.client,
      document: deciding.document,
    });
    await decidingMount.ready;
    await deciding.client.acceptAll();
    await new Promise((resolve) => setTimeout(resolve, LAG_MS + 100));

    const other = openTab("other", shared);
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
      { interval: 50, timeout: 3_000 },
    );

    decidingMount.destroy();
    otherMount.destroy();
    deciding.window.close();
    other.window.close();
  });

  it("adopts a grant on the bootstrap route whose write reaches this tab late", async () => {
    const shared = sharedStorage();
    const open = (name: string) => {
      const window = new Window({ url: "https://shop.example.test/" });
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: globalThis.BroadcastChannel,
      });
      const reload = vi.fn();
      vi.spyOn(window.location, "reload").mockImplementation(reload);
      const document = window.document as unknown as Document;
      return { document, reload, storage: laggedView(shared, name), window };
    };
    const waiting = open("waiting");
    const waitingStarted = bootstrapOpenCookie({
      document: waiting.document,
      storage: waiting.storage,
    });
    await waitingStarted.ready;
    const deciding = open("deciding");
    const decidingStarted = bootstrapOpenCookie({
      document: deciding.document,
      storage: deciding.storage,
    });
    await decidingStarted.ready;

    await decidingStarted.client.acceptAll();
    await vi.waitFor(
      () => {
        expect(waitingStarted.client.getSnapshot().record?.method).toBe(
          "accept-all",
        );
      },
      { interval: 50, timeout: 3_000 },
    );
    await settle();

    expect(waiting.reload).not.toHaveBeenCalled();

    waitingStarted.destroy();
    decidingStarted.destroy();
    waiting.window.close();
    deciding.window.close();
  });
});
