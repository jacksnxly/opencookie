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

// Two installs on one origin keep separate stores but share the decision
// channel. A tab of one install that hears the other's announcement finds its
// own store unchanged, so it keeps its decision and never reloads, however
// long it waits (the convergence window included).

const PAST_CONVERGENCE_MS = 2_800;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("another install's decision on the same origin", () => {
  it("does not reload a hand-wired tab of this install, even after the convergence window", async () => {
    const storage = new Map<string, string>();
    const mine = openTab("mine", storage, 0, "app-a.consent");
    const mineMount = mountOpenCookie({
      client: mine.client,
      document: mine.document,
    });
    await mineMount.ready;
    await mine.client.acceptAll();
    await settle();

    const theirs = openTab("theirs", storage, 0, "app-b.consent");
    const theirsMount = mountOpenCookie({
      client: theirs.client,
      document: theirs.document,
    });
    await theirsMount.ready;
    await theirs.client.acceptAll();
    await wait(PAST_CONVERGENCE_MS);

    expect(mine.reload).not.toHaveBeenCalled();
    expect(mine.client.getSnapshot().record?.method).toBe("accept-all");

    mineMount.destroy();
    theirsMount.destroy();
    mine.window.close();
    theirs.window.close();
  });

  it("does not reload a bootstrapped tab of this install, even after the convergence window", async () => {
    const shared = new Map<string, string>();
    const open = (key: string) => {
      const window = new Window({ url: "https://shop.example.test/" });
      Object.defineProperty(window, "BroadcastChannel", {
        configurable: true,
        value: globalThis.BroadcastChannel,
      });
      const reload = vi.fn();
      vi.spyOn(window.location, "reload").mockImplementation(reload);
      const started = bootstrapOpenCookie({
        document: window.document as unknown as Document,
        storage: {
          getItem: (name: string) => shared.get(name) ?? null,
          removeItem: (name: string) => {
            shared.delete(name);
          },
          setItem: (name: string, value: string) => {
            shared.set(name, value);
          },
        },
        storageKey: key,
      });
      return { reload, started, window };
    };
    const mine = open("app.consent");
    await mine.started.ready;
    await mine.started.client.acceptAll();
    const theirs = open("other-app.consent");
    await theirs.started.ready;
    await theirs.started.client.acceptAll();
    await wait(PAST_CONVERGENCE_MS);

    expect(mine.reload).not.toHaveBeenCalled();

    mine.started.destroy();
    theirs.started.destroy();
    mine.window.close();
    theirs.window.close();
  });
});
