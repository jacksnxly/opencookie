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

import { mountOpenCookie } from "./index.js";

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

// Every documented integration mounts the interface, including one that wires
// its own client and store. A withdrawal in one tab must stop optional
// resources in the others, so they reload to re-read the stored decision.
describe("mountOpenCookie across tabs", () => {
  it("reloads a tab when another tab changes the decision, not when it restores it", async () => {
    const storage = new Map<string, string>();
    const first = openTab("first", storage);
    const firstMount = mountOpenCookie({
      client: first.client,
      document: first.document,
    });
    await firstMount.ready;
    await first.client.acceptAll();
    await settle();

    const second = openTab("second", storage);
    const secondMount = mountOpenCookie({
      client: second.client,
      document: second.document,
    });
    await secondMount.ready;
    expect(second.client.getSnapshot().record?.method).toBe("accept-all");
    await settle();
    expect(first.reload).not.toHaveBeenCalled();

    await second.client.withdrawConsent();
    await settle();
    expect(first.reload).toHaveBeenCalledTimes(1);
    // Its own withdrawal blocks a resource it allowed (Pass B's M-C).
    expect(second.reload).toHaveBeenCalledTimes(1);

    firstMount.destroy();
    secondMount.destroy();
    first.window.close();
    second.window.close();
  });

  // Two installations on one origin keep separate stores. A tab that only
  // restores its own decision announced it, and a tab of the other install
  // reloaded, restored and announced in turn, forever.
  it("reloads no tab of another install when a tab restores its decision", async () => {
    const storage = new Map<string, string>();
    for (const key of ["app-a.consent", "app-b.consent"]) {
      const tab = openTab(`${key}-decides`, storage, 0, key);
      const mounted = mountOpenCookie({
        client: tab.client,
        document: tab.document,
      });
      await mounted.ready;
      await tab.client.acceptAll();
      await settle();
      mounted.destroy();
      tab.window.close();
    }

    const b = openTab("b", storage, 0, "app-b.consent");
    const bMount = mountOpenCookie({ client: b.client, document: b.document });
    await bMount.ready;
    const a = openTab("a", storage, 0, "app-a.consent");
    const aMount = mountOpenCookie({ client: a.client, document: a.document });
    await aMount.ready;
    await settle();

    expect(b.reload).not.toHaveBeenCalled();
    expect(a.reload).not.toHaveBeenCalled();

    aMount.destroy();
    bMount.destroy();
    a.window.close();
    b.window.close();
  });

  it("announces a withdrawal only once it is stored", async () => {
    const storage = new Map<string, string>();
    const first = openTab("first", storage);
    const firstMount = mountOpenCookie({
      client: first.client,
      document: first.document,
    });
    await firstMount.ready;
    await first.client.acceptAll();
    const second = openTab("second", storage, 100);
    const secondMount = mountOpenCookie({
      client: second.client,
      document: second.document,
    });
    await secondMount.ready;
    await settle();
    let storedAtReload: string | undefined;
    first.reload.mockImplementation(() => {
      storedAtReload = storage.get("opencookie.consent");
    });

    await second.client.withdrawConsent();
    await settle();

    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(storedAtReload).toContain('"method":"withdrawal"');

    firstMount.destroy();
    secondMount.destroy();
    first.window.close();
    second.window.close();
  });
});

// Pass B's M-C: a hand-wired client runs its own controllers, so the mount
// cannot see which scripts ran. It reloads its own tab once a decision made
// there is stored and blocks a resource the last stored decision allowed.
describe("mountOpenCookie in the tab that decides", () => {
  it("reloads once its withdrawal of an allowed resource is stored", async () => {
    const storage = new Map<string, string>();
    const tab = openTab("decides", storage);
    let storedAtReload: string | undefined;
    tab.reload.mockImplementation(() => {
      storedAtReload = storage.get("opencookie.consent");
    });
    const mounted = mountOpenCookie({
      client: tab.client,
      document: tab.document,
    });
    await mounted.ready;
    await tab.client.acceptAll();
    await settle();
    expect(tab.reload).not.toHaveBeenCalled();

    await tab.client.withdrawConsent();
    await settle();

    expect(tab.reload).toHaveBeenCalledTimes(1);
    expect(storedAtReload).toContain('"method":"withdrawal"');
    mounted.destroy();
    tab.window.close();
  });

  it("does not reload for a first denial", async () => {
    const tab = openTab("denies", new Map<string, string>());
    const mounted = mountOpenCookie({
      client: tab.client,
      document: tab.document,
    });
    await mounted.ready;

    await tab.client.rejectAll();
    await settle();

    expect(tab.reload).not.toHaveBeenCalled();
    mounted.destroy();
    tab.window.close();
  });
});
