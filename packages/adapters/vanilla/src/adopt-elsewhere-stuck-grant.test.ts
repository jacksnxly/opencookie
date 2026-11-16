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

// A hand-wired tab whose own grant failed to store, because another tab's
// withdrawal won the write, keeps that grant pending until the visitor retries.
// It must still reload when the withdrawal is announced, or a script it allowed
// keeps running while the stored decision blocks it (the reversal rule).

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

describe("a tab whose own grant lost the write to another tab's withdrawal", () => {
  it("reloads when the withdrawal is announced", async () => {
    const shared = new Map<string, string>();
    const mineDelay = { ms: 0 };
    const mine = openTab("mine", shared, mineDelay);
    await mine.mount.ready;
    await mine.client.savePreferences(["analytics"]);
    await sleep(50);
    const other = openTab("other", shared, { ms: 0 });
    await other.mount.ready;
    await sleep(50);

    mineDelay.ms = 400;
    const granting = mine.client.savePreferences(["advertising", "analytics"]);
    await sleep(20);
    await other.client.withdrawConsent();
    await granting;

    await vi.waitFor(
      () => {
        expect(mine.reload).toHaveBeenCalled();
      },
      { interval: 50, timeout: 3_500 },
    );

    mine.mount.destroy();
    other.mount.destroy();
    mine.window.close();
    other.window.close();
  });
});
