import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookie,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
} from "../../index.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
} from "../../domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";

function runtimePolicy() {
  const catalogue = definePolicy(
    completeTestPolicyDefinition({
      purposes: [{ id: "analytics" }, { id: "personalization" }],
    }),
  );
  if (!catalogue.ok) throw new Error("Policy must be valid.");

  const policySnapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: catalogue.policy,
    policyVersion: "policy-1",
  });
  const resources = defineResourcePolicy({
    policy: catalogue.policy,
    resources: [
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics"],
        serviceId: "metrics",
      },
    ],
    services: [{ id: "metrics" }],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");

  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

describe("createOpenCookie pending grant identity", () => {
  it("retries a failed first-grant attempt without regenerating identity", async () => {
    let writes = 0;
    const generatedKinds: string[] = [];
    const broadcast = vi.fn<
      (effect: ConsentRuntimeTransitionEffect) => Promise<void>
    >(() => Promise.resolve());
    const receipt = vi.fn(() => Promise.resolve());
    const reconcile = vi.fn<
      (effect: ConsentRuntimeTransitionEffect) => Promise<void>
    >(() => Promise.resolve());
    const store: DecisionStore = {
      clear: () => Promise.resolve(),
      clearIfCurrent: () => Promise.resolve("cleared"),
      compareAndSet: () => {
        writes += 1;
        return Promise.reject(new Error("quota exceeded"));
      },
      read: () => Promise.resolve({ status: "missing" }),
    };
    let now = 1_000;
    const client = createOpenCookie({
      broadcast,
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => {
        generatedKinds.push(kind);
        return `${kind}-${String(generatedKinds.length)}`;
      },
      now: () => now,
      receipt,
      reconcile,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    const first = await client.acceptAll();
    now = 2_000;
    const second = await client.acceptAll();

    expect(first).toMatchObject({
      diagnostics: [{ code: "grant-write-failed" }],
      effect: {
        events: [],
        record: {
          decidedAt: 1_000,
          expiresAt: 86_401_000,
          recordId: "record-1",
          revision: 1,
        },
        transitionId: "transition-2",
      },
      outcome: "pending",
      transition: {
        persistenceStatus: "pending",
        transitionId: "transition-2",
      },
    });
    expect(second).toEqual(first);
    expect(writes).toBe(2);
    expect(generatedKinds).toEqual(["record", "transition"]);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(
      [...broadcast.mock.calls, ...reconcile.mock.calls].map(
        ([effect]) => effect.runtime.effectiveAccess.resources[0]?.access,
      ),
    ).toEqual(Array.from({ length: 4 }, () => "blocked"));
    expect(receipt).not.toHaveBeenCalled();
  });

  it("retries a granular intent when purpose order changes", async () => {
    let writes = 0;
    const generatedKinds: string[] = [];
    const store: DecisionStore = {
      clear: () => Promise.resolve(),
      clearIfCurrent: () => Promise.resolve("cleared"),
      compareAndSet: () => {
        writes += 1;
        return Promise.reject(new Error("quota exceeded"));
      },
      read: () => Promise.resolve({ status: "missing" }),
    };
    let now = 1_000;
    const client = createOpenCookie({
      consentDurationMs: 86_400_000,
      idGenerator: (kind) => {
        generatedKinds.push(kind);
        return `${kind}-${String(generatedKinds.length)}`;
      },
      now: () => now,
      ...runtimePolicy(),
      store,
    });
    await client.initialize();

    const first = await client.savePreferences([
      "personalization",
      "analytics",
    ]);
    now = 2_000;
    const second = await client.savePreferences([
      "analytics",
      "personalization",
    ]);

    expect(second).toEqual(first);
    expect(writes).toBe(2);
    expect(generatedKinds).toEqual(["record", "transition"]);
  });
});
