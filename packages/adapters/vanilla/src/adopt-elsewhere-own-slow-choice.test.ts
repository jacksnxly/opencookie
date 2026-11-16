import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type PolicyPurposeDefinition,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { mountOpenCookie } from "./index.js";

// A hand-wired tab that is still converging on another install's announcement
// (its own store unchanged) may be in the middle of the visitor's own choice,
// written slowly. That choice wins: the tab is not reloaded under it.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openTab(
  name: string,
  shared: Map<string, string>,
  writeDelay: { ms: number },
) {
  const window = new Window({ url: "https://shop.example.test/" });
  Object.defineProperty(window, "BroadcastChannel", {
    configurable: true,
    value: globalThis.BroadcastChannel,
  });
  const reload = vi.fn();
  vi.spyOn(window.location, "reload").mockImplementation(reload);
  const purpose = (id: string, label: string): PolicyPurposeDefinition => ({
    dataCategoryIds: ["usage-event"],
    disclosure: `${label} disclosure.`,
    id,
    label,
    operationIds: ["aggregate-measurement"],
    providerIds: ["site-operator"],
    recipientIds: ["site-operator"],
    retentionIds: ["session"],
  });
  const policy = definePolicy({
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "aggregate-measurement" }],
    providers: [{ id: "site-operator" }],
    purposes: [
      purpose("analytics", "Analytics"),
      purpose("advertising", "Ads"),
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
      {
        access: "optional",
        id: "ads-script",
        purposeIds: ["advertising"],
        serviceId: "measurement-service",
      },
    ],
    services: [{ id: "measurement-service" }],
  });
  if (!resourcePolicy.ok) {
    throw new Error("Test resource policy must be valid.");
  }
  const store = createLocalStorageDecisionStore({
    key: "opencookie.consent",
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
  });
  let sequence = 0;
  let tick = 0;
  const client = createOpenCookie({
    consentDurationMs: 86_400_000,
    idGenerator: (kind) => `${kind}-${name}-${String((sequence += 1))}`,
    now: () => 1_700_000_000_000 + (tick += 10),
    policySnapshot: createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: policy.policy,
      policyVersion: "policy-1",
    }),
    reconcile: () => Promise.resolve(),
    resourcePolicy: resourcePolicy.resourcePolicy,
    store: {
      ...store,
      compareAndSet: async (expected, candidate) => {
        await sleep(writeDelay.ms);
        return store.compareAndSet(expected, candidate);
      },
    },
  });
  const mount = mountOpenCookie({
    client,
    document: window.document as unknown as Document,
  });
  return { client, mount, reload, window };
}

describe("a tab that decides while it converges on another install's announcement", () => {
  it("keeps its own slow choice and is not reloaded", async () => {
    const shared = new Map<string, string>();
    const delay = { ms: 0 };
    const mine = openTab("mine", shared, delay);
    await mine.mount.ready;
    await mine.client.rejectAll();
    await sleep(50);

    const announcer = new BroadcastChannel("opencookie-decision");
    announcer.postMessage("record-other-install:1");
    await sleep(100);
    delay.ms = 600;
    await mine.client.acceptAll();
    await sleep(2_500);

    expect(mine.reload).not.toHaveBeenCalled();
    expect(mine.client.getSnapshot().record?.method).toBe("accept-all");
    expect(mine.client.getSnapshot().lastPersistenceStatus).toBe("confirmed");

    announcer.close();
    mine.mount.destroy();
    mine.window.close();
  });
});
