import { expect, it } from "vitest";

import {
  executeConsentRuntimeDecision,
  projectConsentPolicy,
  toPersistedDecisionRecord,
  type DecisionStore,
  type PersistedConsentState,
} from "../../application.js";
import { createOpenCookie } from "./create-open-cookie.js";
import { recordConsentDecision, type ConsentRecord } from "../../domain.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";

function policySnapshot(
  policyVersion: string,
  analyticsDisclosure: string,
): PolicySnapshot {
  const definition = definePolicy(
    completeTestPolicyDefinition({
      purposes: [
        { disclosure: analyticsDisclosure, id: "analytics" },
        { id: "personalization" },
        { dependsOn: ["analytics"], id: "ads" },
      ],
    }),
  );
  if (!definition.ok) throw new Error("Policy must be valid.");
  return createPolicySnapshot({
    catalogueRevision: `catalogue-${policyVersion}`,
    policy: definition.policy,
    policyVersion,
  });
}

function historicalGrant(snapshot: PolicySnapshot): ConsentRecord {
  const result = recordConsentDecision(
    undefined,
    projectConsentPolicy(snapshot),
    {
      decidedAt: 1_000,
      expiresAt: 10_000,
      grantedPurposeIds: ["analytics", "personalization", "ads"],
      method: "granular",
      recordId: "record-historical",
    },
  );
  if (!result.ok) throw new Error("Historical decision must be valid.");
  return result.record;
}

function resources(snapshot: PolicySnapshot) {
  const result = defineResourcePolicy({
    policy: snapshot.policy,
    resources: [
      {
        access: "optional",
        id: "ads-script",
        purposeIds: ["ads"],
        serviceId: "ads-service",
      },
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics"],
        serviceId: "analytics-service",
      },
      {
        access: "optional",
        id: "personalization-script",
        purposeIds: ["personalization"],
        serviceId: "personalization-service",
      },
    ],
    services: [
      { id: "ads-service" },
      { id: "analytics-service" },
      { id: "personalization-service" },
    ],
  });
  if (!result.ok) throw new Error("Resource policy must be valid.");
  return result.resourcePolicy;
}

function emptyStore(): DecisionStore {
  return {
    clear: () => Promise.resolve(),
    clearIfCurrent: () => Promise.resolve("cleared"),
    compareAndSet: () => Promise.resolve({ status: "written" }),
    read: () => Promise.resolve({ status: "missing" }),
  };
}

it("keeps the historical record while selectively reconsenting only affected access", () => {
  const previous = policySnapshot("policy-1", "Original analytics disclosure");
  const current = policySnapshot("policy-2", "Changed analytics disclosure");
  const record = historicalGrant(previous);
  const before = structuredClone(record);

  const client = createOpenCookie({
    consentDurationMs: 9_000,
    idGenerator: (kind) => `${kind}-new`,
    initialRecord: record,
    initialTime: 2_000,
    now: () => 2_000,
    policyHistory: [current, previous],
    policySnapshot: current,
    resourcePolicy: resources(current),
    store: emptyStore(),
  });
  const snapshot = client.getSnapshot();

  expect(snapshot.record).toBe(record);
  expect(snapshot.record).toEqual(before);
  expect(snapshot.runtime.policyReconciliation).toMatchObject({
    decisions: [
      { purposeId: "ads", value: "granted" },
      { purposeId: "analytics", value: "unresolved" },
      { purposeId: "personalization", value: "granted" },
    ],
    prompt: true,
    status: "requires-reconsent",
  });
  expect(snapshot.runtime.accessConsent).toEqual({
    decisions: [
      { decision: "granted", purposeId: "ads" },
      { decision: "unresolved", purposeId: "analytics" },
      { decision: "granted", purposeId: "personalization" },
    ],
    status: "requires-reconsent",
  });
  expect(snapshot.runtime.effectiveAccess.resources).toEqual([
    {
      access: "blocked",
      blockReasons: ["purpose-dependency", "policy-change"].sort(),
      resourceId: "ads-script",
      serviceId: "ads-service",
    },
    {
      access: "blocked",
      blockReasons: ["policy-change"],
      resourceId: "analytics-script",
      serviceId: "analytics-service",
    },
    {
      access: "allowed",
      basis: "explicit-consent",
      blockReasons: [],
      resourceId: "personalization-script",
      serviceId: "personalization-service",
    },
  ]);
  expect(snapshot).toMatchObject({
    grantActivation: "active",
    preferencesOpen: true,
  });
  expect(Object.isFrozen(snapshot.runtime.policyReconciliation)).toBe(true);
  expect(record).toEqual(before);
});

it("captures generic client policy history once and reuses its detached copy", async () => {
  const previous = policySnapshot("policy-1", "Original analytics disclosure");
  const current = policySnapshot("policy-2", "Changed analytics disclosure");
  const record = historicalGrant(previous);
  const mutableCurrent = structuredClone(current);
  const mutablePrevious = structuredClone(previous);
  const history = [mutableCurrent, mutablePrevious];
  let descriptorReads = 0;
  const observedHistory = new Proxy(history, {
    getOwnPropertyDescriptor: (target, property) => {
      if (property === "0" || property === "1") descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  let durable: PersistedConsentState | null = {
    record: toPersistedDecisionRecord(record),
  };
  const store: DecisionStore = {
    clear: () => {
      durable = null;
      return Promise.resolve();
    },
    clearIfCurrent: () => Promise.resolve("conflict"),
    compareAndSet: (_expected, candidate) => {
      durable = candidate;
      return Promise.resolve({ status: "written" });
    },
    read: () =>
      Promise.resolve(
        durable === null
          ? { status: "missing" as const }
          : { state: durable, status: "stored" as const },
      ),
  };
  const client = createOpenCookie({
    consentDurationMs: 9_000,
    idGenerator: (kind) => `${kind}-captured-history`,
    initialRecord: record,
    initialTime: 2_000,
    now: () => 2_000,
    policyHistory: observedHistory,
    policySnapshot: current,
    resourcePolicy: resources(current),
    store,
  });

  (mutableCurrent as { policyVersion: string }).policyVersion =
    "mutated-current";
  (mutablePrevious as { policyVersion: string }).policyVersion =
    "mutated-previous";
  history.length = 0;
  const restored = await client.initialize();

  expect(descriptorReads).toBe(2);
  expect(restored.runtime.policyReconciliation).toMatchObject({
    status: "requires-reconsent",
  });
  expect(restored.record).toEqual(record);
});

it.each([
  { history: [] as readonly PolicySnapshot[], name: "empty" },
  {
    history: undefined,
    name: "missing the current policy identity",
  },
])(
  "rejects $name explicit policy history during construction",
  ({ history }) => {
    const previous = policySnapshot(
      "policy-1",
      "Original analytics disclosure",
    );
    const current = policySnapshot("policy-2", "Changed analytics disclosure");

    expect(() =>
      createOpenCookie({
        consentDurationMs: 9_000,
        idGenerator: (kind) => `${kind}-invalid-history`,
        now: () => 2_000,
        policyHistory: history ?? [previous],
        policySnapshot: current,
        resourcePolicy: resources(current),
        store: emptyStore(),
      }),
    ).toThrow("Invalid consent runtime policy history.");
  },
);

it("replaces historical policy identity only after a new explicit decision", async () => {
  const previous = policySnapshot("policy-1", "Original analytics disclosure");
  const current = policySnapshot("policy-2", "Changed analytics disclosure");
  const historical = historicalGrant(previous);
  const historicalBefore = structuredClone(historical);
  let durable: PersistedConsentState | null = {
    record: toPersistedDecisionRecord(historical),
  };
  const store: DecisionStore = {
    clear: () => {
      durable = null;
      return Promise.resolve();
    },
    clearIfCurrent: () => {
      durable = null;
      return Promise.resolve("cleared");
    },
    compareAndSet: (_expected, candidate) => {
      durable = candidate;
      return Promise.resolve({ status: "written" });
    },
    read: () =>
      Promise.resolve(
        durable === null
          ? { status: "missing" as const }
          : { state: durable, status: "stored" as const },
      ),
  };

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: () => Promise.resolve(),
      commit: () => undefined,
      notify: () => undefined,
      receipt: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
      store,
    },
    {
      currentRecord: historical,
      decision: {
        decidedAt: 2_000,
        expiresAt: 11_000,
        grantedPurposeIds: ["personalization"],
        method: "granular",
        recordId: "record-current",
      },
      now: 2_000,
      policyHistory: [current, previous],
      policySnapshot: current,
      resourcePolicy: resources(current),
      transitionId: "transition-current",
    },
  );

  expect(result.outcome).toBe("committed");
  if (result.outcome !== "committed") return;
  expect(result.effect.record.policy).toEqual({
    catalogueDigest: current.catalogueDigest,
    decisionSurfaceDigest: current.decisionSurfaceDigest,
    policyVersion: current.policyVersion,
  });
  expect(result.effect.runtime.policyReconciliation).toMatchObject({
    prompt: false,
    status: "current",
  });
  expect(historical).toEqual(historicalBefore);
  expect(durable.record).toMatchObject({
    policyVersion: current.policyVersion,
    recordId: "record-historical",
  });
});
