import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type DecisionStore,
  type OpenCookie,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountOpenCookie } from "./index.js";

// Which tab posted which identity, in the order the tabs opened.
function watchPosts(): {
  readonly posts: readonly {
    readonly channel: number;
    readonly message: string;
  }[];
  readonly stop: () => void;
} {
  const channels: BroadcastChannel[] = [];
  const posts: { channel: number; message: string }[] = [];
  const RealChannel = globalThis.BroadcastChannel;
  const ObservedChannel = class extends RealChannel {
    constructor(name: string) {
      super(name);
      channels.push(this);
    }
    override postMessage(message: string): void {
      posts.push({ channel: channels.indexOf(this), message });
      super.postMessage(message);
    }
  };
  vi.stubGlobal("BroadcastChannel", ObservedChannel);
  return {
    posts,
    stop: () => {
      vi.unstubAllGlobals();
    },
  };
}

// A store whose read answers after a delay, as a slow or remote store would.
function slowReads<Store extends DecisionStore>(
  reads: { slow: boolean; started: boolean },
  store: Store,
): Store {
  return {
    ...store,
    read: async () => {
      const result = await store.read();
      if (reads.slow) {
        reads.started = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return result;
    },
  };
}

function openTab(
  name: string,
  storage: Map<string, string>,
): {
  readonly client: OpenCookie;
  readonly document: Document;
  readonly reads: { slow: boolean; started: boolean };
  readonly window: Window;
} {
  const reads = { slow: false, started: false };
  const window = new Window({ url: "https://shop.example.test/" });
  Object.defineProperty(window, "BroadcastChannel", {
    configurable: true,
    value: globalThis.BroadcastChannel,
  });
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
    store: slowReads(
      reads,
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
    ),
  });
  return {
    client,
    document: window.document as unknown as Document,
    reads,
    window,
  };
}

// A tab announces a decision it made. The tab that adopts that decision does
// not post it again, so a late echo cannot reach a tab deciding for itself.
describe("an adopted decision is not announced again", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts nothing on the channel when it adopts another tab's grant", async () => {
    const watch = watchPosts();
    const storage = new Map<string, string>();
    const waiting = openTab("waiting", storage);
    const waitingMount = mountOpenCookie({
      client: waiting.client,
      document: waiting.document,
    });
    await waitingMount.ready;

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

    // The waiting tab opened first, so its channel is 0. Only the deciding
    // tab, channel 1, announces the grant.
    expect(watch.posts.map((post) => post.channel)).toEqual([1]);

    waitingMount.destroy();
    decidingMount.destroy();
    waiting.window.close();
    deciding.window.close();
    watch.stop();
  });

  it("posts a withdrawal this tab makes while an adoption read is out", async () => {
    const watch = watchPosts();
    const waiting = openTab("waiting", new Map<string, string>());
    vi.spyOn(waiting.window.location, "reload").mockImplementation(
      () => undefined,
    );
    const waitingMount = mountOpenCookie({
      client: waiting.client,
      document: waiting.document,
    });
    await waitingMount.ready;
    await waiting.client.acceptAll();

    // Another tab announces a different decision. This tab's read of its own
    // store is still out when the visitor withdraws here.
    waiting.reads.slow = true;
    const announcer = new BroadcastChannel("opencookie-decision");
    announcer.postMessage("record-elsewhere-1:1");
    await vi.waitFor(() => {
      expect(waiting.reads.started).toBe(true);
    });
    await waiting.client.withdrawConsent();

    const record = waiting.client.getSnapshot().record;
    expect(record?.method).toBe("withdrawal");
    expect(
      watch.posts
        .filter((post) => post.channel === 0)
        .map((post) => post.message),
    ).toContain(
      record === undefined
        ? ""
        : `${record.recordId}:${String(record.revision)}`,
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    announcer.close();
    waitingMount.destroy();
    waiting.window.close();
    watch.stop();
  });
});
