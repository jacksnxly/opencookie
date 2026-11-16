import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type OpenCookie,
  type PolicyDefinition,
  type StorageLike,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { bootstrapOpenCookie, mountOpenCookie } from "./index.js";

// The catalogue both policy versions share. Only the version string differs.
function catalogue(): PolicyDefinition {
  return {
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
  };
}

function memory(storage: Map<string, string>): StorageLike {
  return {
    getItem: (key) => storage.get(key) ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, value);
    },
  };
}

function browserWindow(): {
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
  return {
    document: window.document as unknown as Document,
    reload,
    window,
  };
}

function handWired(
  name: string,
  storage: Map<string, string>,
  policyVersion: string,
  writeDelayMs = 0,
  key = "opencookie.consent",
  withResource = true,
): {
  readonly client: OpenCookie;
  readonly document: Document;
  readonly reload: ReturnType<typeof vi.fn>;
  readonly window: Window;
} {
  const defined = definePolicy(catalogue());
  if (!defined.ok) throw new Error("Test policy must be valid.");
  const resourcePolicy = defineResourcePolicy({
    policy: defined.policy,
    resources: withResource
      ? [
          {
            access: "optional",
            id: "analytics-script",
            purposeIds: ["analytics"],
            serviceId: "measurement-service",
          },
        ]
      : [],
    services: withResource ? [{ id: "measurement-service" }] : [],
  });
  if (!resourcePolicy.ok) {
    throw new Error("Test resource policy must be valid.");
  }
  const page = browserWindow();
  let sequence = 0;
  const client = createOpenCookie({
    consentDurationMs: 86_400_000,
    idGenerator: (kind) => `${kind}-${name}-${String((sequence += 1))}`,
    now: () => 1_700_000_000_000,
    policySnapshot: createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: defined.policy,
      policyVersion,
    }),
    reconcile: () => Promise.resolve(),
    resourcePolicy: resourcePolicy.resourcePolicy,
    store: delayedWrites(
      createLocalStorageDecisionStore({
        key,
        schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
        storage: memory(storage),
      }),
      writeDelayMs,
    ),
  });
  return {
    client,
    document: page.document,
    reload: page.reload,
    window: page.window,
  };
}

function delayedWrites<
  Store extends ReturnType<typeof createLocalStorageDecisionStore>,
>(store: Store, delayMs: number): Store {
  if (delayMs === 0) return store;
  return {
    ...store,
    compareAndSet: async (expected, candidate) => {
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs);
      });
      return store.compareAndSet(expected, candidate);
    },
  };
}

// A stored withdrawal from policy-2, which a policy-1 tab cannot take.
async function storedWithdrawal(name: string): Promise<string> {
  const storage = new Map<string, string>();
  const writer = handWired(name, storage, "policy-2");
  await writer.client.acceptAll();
  await writer.client.withdrawConsent();
  writer.window.close();
  const raw = storage.get("opencookie.consent");
  if (raw === undefined) throw new Error("Withdrawal was not stored.");
  return raw;
}

function announce(raw: string, identity: string, storage: Map<string, string>) {
  storage.set("opencookie.consent", raw);
  const channel = new BroadcastChannel("opencookie-decision");
  channel.postMessage(identity);
  channel.close();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A reload the visitor declines stays on the page. A later, different stored
// withdrawal must still be able to ask for a reload.
describe("a declined reload on the runtime route", () => {
  it("requests another reload when a different withdrawal is announced", async () => {
    const storage = new Map<string, string>();
    const page = browserWindow();
    const started = bootstrapOpenCookie({
      document: page.document,
      policyDefinition: catalogue(),
      policyVersion: "policy-1",
      storage: memory(storage),
      storageKey: "opencookie.consent",
    });
    await started.ready;
    await started.client.acceptAll();
    await wait(50);
    expect(page.reload).not.toHaveBeenCalled();

    const first = await storedWithdrawal("first");
    const second = await storedWithdrawal("second");
    expect(first).not.toBe(second);

    announce(first, "withdrawal-first", storage);
    await vi.waitFor(() => {
      expect(page.reload).toHaveBeenCalledTimes(1);
    });
    // Retries through the convergence window must not ask again for this value.
    await wait(2_300);
    expect(page.reload).toHaveBeenCalledTimes(1);

    announce(second, "withdrawal-second", storage);
    await vi.waitFor(() => {
      expect(page.reload).toHaveBeenCalledTimes(2);
    });

    started.destroy();
    page.window.close();
  });
});

// A tab that holds a record reloads at the end of the window when the
// announced decision belongs to a policy version it cannot take.
describe("a record from another policy version", () => {
  it("reloads a hand-wired tab within 2,500 ms", async () => {
    const storage = new Map<string, string>();
    const mine = handWired("mine", storage, "policy-1");
    const mineMount = mountOpenCookie({
      client: mine.client,
      document: mine.document,
    });
    await mineMount.ready;
    await mine.client.acceptAll();
    await wait(50);

    const next = handWired("next", storage, "policy-2");
    const nextMount = mountOpenCookie({
      client: next.client,
      document: next.document,
    });
    await nextMount.ready;
    await wait(50);
    expect(mine.reload).not.toHaveBeenCalled();

    await next.client.acceptAll();
    await vi.waitFor(
      () => {
        expect(mine.reload).toHaveBeenCalled();
      },
      { interval: 20, timeout: 2_500 },
    );

    mineMount.destroy();
    nextMount.destroy();
    mine.window.close();
    next.window.close();
  });
});

// Another install announces while this tab's own rejection is still being
// stored. The rejection wins: the window ends on the new identity, so the
// tab is not reloaded. No optional resource is declared, so the rejection
// itself has nothing already running to reload for.
describe("a slow rejection during another install's announcement", () => {
  it("keeps the rejection and is not reloaded", async () => {
    const storage = new Map<string, string>();
    const mine = handWired(
      "mine",
      storage,
      "policy-1",
      400,
      "app.consent",
      false,
    );
    const mineMount = mountOpenCookie({
      client: mine.client,
      document: mine.document,
    });
    await mineMount.ready;
    await mine.client.acceptAll();
    await wait(50);

    const other = handWired("other", storage, "policy-1", 0, "other.consent");
    const otherMount = mountOpenCookie({
      client: other.client,
      document: other.document,
    });
    await otherMount.ready;

    const rejecting = mine.client.rejectAll();
    await vi.waitFor(() => {
      expect(mine.client.getSnapshot().lastPersistenceStatus).toBe("pending");
    });
    await other.client.acceptAll();
    await rejecting;
    await wait(2_500);

    expect(mine.reload).not.toHaveBeenCalled();
    expect(mine.client.getSnapshot().record?.method).toBe("reject-all");
    expect(mine.client.getSnapshot().lastPersistenceStatus).toBe("confirmed");

    mineMount.destroy();
    otherMount.destroy();
    mine.window.close();
    other.window.close();
  });
});
