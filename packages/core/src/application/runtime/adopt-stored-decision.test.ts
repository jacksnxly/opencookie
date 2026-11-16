import { describe, expect, it } from "vitest";

import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../../index.js";

// Two tabs of one site share a decision store. When one tab decides, the other
// adopts the stored decision in place: no write, no second receipt, and the
// ports in the order a decision needs (Consent Mode before resources start; a
// narrowing blocks first). A record this tab cannot verify is not adopted.

function tab(
  name: string,
  storage: Map<string, string>,
  policyVersion = "policy-1",
) {
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

describe("adopting a decision another tab stored", () => {
  it("adopts a grant in place: Consent Mode first, then resources; no write, no receipt", async () => {
    const storage = new Map<string, string>();
    const deciding = tab("deciding", storage);
    const other = tab("other", storage);
    await deciding.client.initialize();
    await other.client.initialize();
    other.calls.length = 0;
    const writesBefore = other.writes();

    await deciding.client.acceptAll();
    const result = await other.client.adoptStoredDecision();

    expect(result).toBe("adopted");
    const adopted = other.client.getSnapshot();
    expect(adopted.record?.method).toBe("accept-all");
    expect(adopted.record?.recordId).toBe(
      deciding.client.getSnapshot().record?.recordId,
    );
    expect(adopted.runtime.permittedPurposeIds).toEqual(["analytics"]);
    expect(adopted.lastPersistenceStatus).toBe("confirmed");
    expect(other.calls).toEqual(["broadcast", "reconcile"]);
    expect(other.writes()).toBe(writesBefore);
  });

  it("adopts a narrowing in place: resources are blocked before Consent Mode hears it", async () => {
    const storage = new Map<string, string>();
    const deciding = tab("deciding", storage);
    const other = tab("other", storage);
    await deciding.client.initialize();
    await other.client.initialize();
    await deciding.client.acceptAll();
    expect(await other.client.adoptStoredDecision()).toBe("adopted");
    other.calls.length = 0;

    await deciding.client.withdrawConsent();
    const result = await other.client.adoptStoredDecision();

    expect(result).toBe("adopted");
    expect(other.client.getSnapshot().runtime.permittedPurposeIds).toEqual([]);
    expect(other.calls).toEqual(["reconcile", "broadcast"]);
  });

  it("reports nothing to adopt when the stored decision is the one it has", async () => {
    const storage = new Map<string, string>();
    const deciding = tab("deciding", storage);
    const other = tab("other", storage);
    await deciding.client.initialize();
    await other.client.initialize();
    await deciding.client.acceptAll();
    expect(await other.client.adoptStoredDecision()).toBe("adopted");
    other.calls.length = 0;

    expect(await other.client.adoptStoredDecision()).toBe("unchanged");
    expect(other.calls).toEqual([]);
  });

  it("does not adopt a record from a policy it does not know", async () => {
    const storage = new Map<string, string>();
    const newer = tab("newer", storage, "policy-2");
    const older = tab("older", storage, "policy-1");
    await newer.client.initialize();
    await older.client.initialize();
    older.calls.length = 0;

    await newer.client.acceptAll();
    const result = await older.client.adoptStoredDecision();

    expect(result).toBe("unavailable");
    expect(older.client.getSnapshot().record).toBeUndefined();
    expect(older.calls).toEqual([]);
  });
});
