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

// A hand-wired tab whose store writes land only after a delay.
function openTab(
  name: string,
  storage: Map<string, string>,
  writeDelayMs: number,
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
  if (!resourcePolicy.ok) {
    throw new Error("Test resource policy must be valid.");
  }
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
        key: "opencookie.consent",
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

// Another tab's announcement arrives while this tab's own grant is still
// being stored. The grant wins: the tab is not reloaded.
describe("a grant in flight when another tab announces", () => {
  it("keeps the grant and does not reload", async () => {
    const mine = openTab("mine", new Map<string, string>(), 400);
    const mineMount = mountOpenCookie({
      client: mine.client,
      document: mine.document,
    });
    await mineMount.ready;
    const granting = mine.client.acceptAll();
    await vi.waitFor(() => {
      expect(mine.client.getSnapshot().lastPersistenceStatus).toBe("pending");
    });
    const announcer = new BroadcastChannel("opencookie-decision");
    announcer.postMessage("record-elsewhere-1:1");

    await granting;
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(mine.reload).not.toHaveBeenCalled();
    expect(mine.client.getSnapshot().record?.method).toBe("accept-all");
    expect(mine.client.getSnapshot().lastPersistenceStatus).toBe("confirmed");

    announcer.close();
    mineMount.destroy();
    mine.window.close();
  });
});
