import { describe, expect, it } from "vitest";

import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type DecisionStore,
} from "../../index.js";

// Adoption reads the store, and the read can be slow. A decision this tab makes
// while the read is out wins: the old read is never installed over it. And a
// stored decision is judged at the current time, so one that expired while the
// tab was in the background is adopted as expired, never as current.

// A store whose read takes what is stored when it is called and answers later,
// as a slow or remote store would.
function slowReads<Store extends DecisionStore>(
  reads: { slow: boolean },
  store: Store,
): Store {
  return {
    ...store,
    read: async () => {
      const result = await store.read();
      if (reads.slow) await new Promise((resolve) => setTimeout(resolve, 50));
      return result;
    },
  };
}

function tab(
  name: string,
  storage: Map<string, string>,
  clock: { now: number },
  consentDurationMs = 86_400_000,
) {
  const policyVersion = "policy-1";
  const reads = { slow: false };
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
    consentDurationMs,
    idGenerator: (kind) => `${kind}-${name}-${String((sequence += 1))}`,
    now: () => clock.now,
    policySnapshot: createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: policy.policy,
      policyVersion,
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
    store: slowReads(
      reads,
      createLocalStorageDecisionStore({
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
    ),
  });
  return { calls, client, reads, writes: () => writes };
}

describe("adoption against a slow read and the clock", () => {
  it("never installs an old read over a withdrawal made in this tab meanwhile", async () => {
    const storage = new Map<string, string>();
    const clock = { now: 1_700_000_000_000 };
    const other = tab("other", storage, clock);
    await other.client.initialize();
    await other.client.acceptAll();

    other.reads.slow = true;
    const adoption = other.client.adoptStoredDecision();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await other.client.withdrawConsent();
    const result = await adoption;

    expect(result).not.toBe("adopted");
    expect(other.client.getSnapshot().runtime.permittedPurposeIds).toEqual([]);
  });

  it("adopts a decision that expired meanwhile as expired, with nothing permitted", async () => {
    const storage = new Map<string, string>();
    const clock = { now: 1_700_000_000_000 };
    const deciding = tab("deciding", storage, clock, 1_000);
    const other = tab("other", storage, clock, 1_000);
    await deciding.client.initialize();
    await other.client.initialize();
    await deciding.client.acceptAll();

    clock.now += 10_000;
    await other.client.adoptStoredDecision();

    const runtime = other.client.getSnapshot().runtime;
    expect(runtime.permittedPurposeIds).toEqual([]);
    expect(runtime.policyReconciliation?.status).not.toBe("current");
  });
});
