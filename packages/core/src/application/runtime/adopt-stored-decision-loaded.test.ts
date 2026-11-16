import { describe, expect, it } from "vitest";

import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../../index.js";

// A tab can load with a decision already stored, then adopt a later one.
function tab(name: string, storage: Map<string, string>) {
  const calls: string[] = [];
  let writes = 0;
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
    broadcast: () => {
      calls.push("broadcast");
      return Promise.resolve();
    },
    consentDurationMs: 86_400_000,
    idGenerator: (kind) => `${kind}-${name}-${String((sequence += 1))}`,
    now: () => 1_700_000_000_000,
    policySnapshot: createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: policy.policy,
      policyVersion: "policy-1",
    }),
    receipt: () => {
      calls.push("receipt");
      return Promise.resolve();
    },
    reconcile: () => {
      calls.push("reconcile");
      return Promise.resolve();
    },
    resourcePolicy: resourcePolicy.resourcePolicy,
    store: createLocalStorageDecisionStore({
      key: "opencookie.consent",
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        removeItem: (key) => {
          writes += 1;
          storage.delete(key);
        },
        setItem: (key, value) => {
          writes += 1;
          storage.set(key, value);
        },
      },
    }),
  });
  return { calls, client, writes: () => writes };
}

describe("adopting after loading a stored decision", () => {
  it("adopts another tab's grant over the rejection it loaded with", async () => {
    const storage = new Map<string, string>();
    const earlier = tab("earlier", storage);
    await earlier.client.initialize();
    await earlier.client.rejectAll();

    const loaded = tab("loaded", storage);
    await loaded.client.initialize();
    expect(loaded.client.getSnapshot().record?.method).toBe("reject-all");
    loaded.calls.length = 0;
    const writesBefore = loaded.writes();

    const deciding = tab("deciding", storage);
    await deciding.client.initialize();
    await deciding.client.acceptAll();
    const result = await loaded.client.adoptStoredDecision();

    expect(result).toBe("adopted");
    expect(loaded.client.getSnapshot().record?.method).toBe("accept-all");
    expect(loaded.calls).toEqual(["broadcast", "reconcile"]);
    expect(loaded.writes()).toBe(writesBefore);
  });
});
