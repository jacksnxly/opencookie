import { expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type ConsentRecord,
  type DefinedResourcePolicy,
  type PolicySnapshot,
  type ProcessingRestrictionSet,
  type ServicePreferenceRecord,
} from "../../index.js";
import {
  executeConsentRuntimeDecision,
  executeConsentRuntimeWithdrawal,
  toPersistedDecisionRecord,
  type ConsentRuntimeDecisionCommand,
  type ConsentRuntimeDecisionPorts,
  type DecisionStore,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../application.js";
import { recordConsentDecision } from "../../domain.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function stateRecord(value: PersistedConsentState): PersistedDecisionRecord {
  if (value.record === undefined) {
    throw new Error("Expected an active persisted consent record.");
  }
  return value.record;
}

function runtimeFixture(): {
  readonly currentRecord: ConsentRecord;
  readonly policySnapshot: PolicySnapshot;
  readonly resourcePolicy: DefinedResourcePolicy;
} {
  const definition = definePolicy(
    completeTestPolicyDefinition({ purposes: [{ id: "analytics" }] }),
  );
  if (!definition.ok) throw new Error("Policy must be valid.");
  const policySnapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: definition.policy,
    policyVersion: "policy-1",
  });
  const resources = defineResourcePolicy({
    policy: definition.policy,
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
  const recorded = recordConsentDecision(
    undefined,
    {
      catalogueDigest: policySnapshot.catalogueDigest,
      decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
      optionalPurposeIds: ["analytics"],
      policyVersion: policySnapshot.policyVersion,
    },
    {
      decidedAt: 1_000,
      expiresAt: 3_000,
      method: "accept-all",
      recordId: "record-1",
    },
  );
  if (!recorded.ok || recorded.outcome !== "changed") {
    throw new Error("Decision must be valid.");
  }
  return {
    currentRecord: recorded.record,
    policySnapshot,
    resourcePolicy: resources.resourcePolicy,
  };
}

type ResourcePolicyForgery = (
  policy: DefinedResourcePolicy,
) => DefinedResourcePolicy;

const hiddenIdentifier = "ana\u200Blytics";

const resourcePolicyIdentifierForgeries: readonly [
  boundary: string,
  forge: ResourcePolicyForgery,
][] = [
  [
    "policy purpose identifier",
    (policy) => ({ ...policy, purposeIds: [hiddenIdentifier] }),
  ],
  [
    "service identifier",
    (policy) => ({
      ...policy,
      services: policy.services.map((service, index) =>
        index === 0 ? { ...service, id: hiddenIdentifier } : service,
      ),
    }),
  ],
  [
    "resource identifier",
    (policy) => ({
      ...policy,
      resources: policy.resources.map((resource, index) =>
        index === 0 ? { ...resource, id: hiddenIdentifier } : resource,
      ),
    }),
  ],
  [
    "resource service identifier",
    (policy) => ({
      ...policy,
      resources: policy.resources.map((resource, index) =>
        index === 0 ? { ...resource, serviceId: hiddenIdentifier } : resource,
      ),
    }),
  ],
  [
    "resource purpose identifier",
    (policy) => ({
      ...policy,
      resources: policy.resources.map((resource, index) =>
        index === 0
          ? { ...resource, purposeIds: [hiddenIdentifier] }
          : resource,
      ),
    }),
  ],
];

function noEffectPorts(calls: string[]): ConsentRuntimeDecisionPorts {
  return {
    broadcast: () => {
      calls.push("broadcast");
      return Promise.resolve();
    },
    commit: () => {
      calls.push("commit");
    },
    notify: () => {
      calls.push("notify");
    },
    receipt: () => {
      calls.push("receipt");
      return Promise.resolve();
    },
    reconcile: () => {
      calls.push("reconcile");
      return Promise.resolve();
    },
    store: {
      clear: () => {
        calls.push("clear");
        return Promise.resolve();
      },
      clearIfCurrent: () => {
        calls.push("clearIfCurrent");
        return Promise.resolve("cleared");
      },
      compareAndSet: () => {
        calls.push("compareAndSet");
        return Promise.resolve({ status: "written" });
      },
      read: () => {
        calls.push("read");
        return Promise.resolve({ status: "missing" });
      },
    },
  };
}

function mutableProjectionInputs(fixture: ReturnType<typeof runtimeFixture>): {
  readonly policySnapshot: PolicySnapshot;
  readonly privacyRestrictions: ProcessingRestrictionSet;
  readonly resourcePolicy: DefinedResourcePolicy;
  readonly servicePreferences: ServicePreferenceRecord;
} {
  return {
    policySnapshot: structuredClone(fixture.policySnapshot),
    privacyRestrictions: {
      purposeIds: [],
      resourceIds: [],
      serviceIds: [],
      source: "gpc",
    },
    resourcePolicy: structuredClone(fixture.resourcePolicy),
    servicePreferences: { restrictedServiceIds: [] },
  };
}

function mutateProjectionInputs(
  inputs: ReturnType<typeof mutableProjectionInputs>,
): void {
  const policy = inputs.policySnapshot as unknown as {
    policy: { purposes: { id: string }[] };
  };
  const resources = inputs.resourcePolicy as unknown as {
    resources: { id: string }[];
  };
  const restrictions = inputs.privacyRestrictions as unknown as {
    purposeIds: string[];
  };
  const preferences = inputs.servicePreferences as unknown as {
    restrictedServiceIds: string[];
  };
  const purpose = policy.policy.purposes[0];
  const resource = resources.resources[0];
  if (purpose === undefined || resource === undefined) {
    throw new Error("Mutable projection fixture must be complete.");
  }
  purpose.id = "mutated-purpose";
  resource.id = "mutated-script";
  restrictions.purposeIds.push("analytics");
  preferences.restrictedServiceIds.push("metrics");
}

function expectOriginalProjection(result: unknown): void {
  expect(result).toMatchObject({
    effect: {
      runtime: {
        accessPolicy: {
          resources: [
            {
              id: "analytics-script",
              purposeIds: ["analytics"],
              serviceId: "metrics",
            },
          ],
          valid: true,
        },
        consentPolicy: { optionalPurposeIds: ["analytics"] },
        effectiveAccess: {
          resources: [
            {
              access: "allowed",
              resourceId: "analytics-script",
              serviceId: "metrics",
            },
          ],
        },
      },
    },
  });
}

it("detaches every projection input before grant persistence", async () => {
  const fixture = runtimeFixture();
  const inputs = mutableProjectionInputs(fixture);
  let durable: PersistedDecisionRecord | null = null;

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: () => Promise.resolve(),
      commit: () => undefined,
      notify: () => undefined,
      receipt: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared"),
        compareAndSet: (_expected, candidate) => {
          durable = stateRecord(candidate);
          mutateProjectionInputs(inputs);
          return Promise.resolve({ status: "written" });
        },
        read: () =>
          Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: state(durable), status: "stored" as const },
          ),
      },
    },
    {
      decision: {
        decidedAt: 1_500,
        expiresAt: 3_500,
        method: "accept-all",
        recordId: "record-2",
      },
      now: 1_500,
      ...inputs,
      transitionId: "transition-detached-projection",
    },
  );

  expect(result.outcome).toBe("committed");
  expectOriginalProjection(result);
});

it("precomputes the conservative grant projection before persistence", async () => {
  const fixture = runtimeFixture();
  const inputs = mutableProjectionInputs(fixture);

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: () => Promise.resolve(),
      commit: () => undefined,
      notify: () => undefined,
      receipt: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared"),
        compareAndSet: () => {
          mutateProjectionInputs(inputs);
          return Promise.resolve({ status: "conflict" });
        },
        read: () => Promise.resolve({ status: "missing" }),
      },
    },
    {
      decision: {
        decidedAt: 1_500,
        expiresAt: 3_500,
        method: "accept-all",
        recordId: "record-2",
      },
      now: 1_500,
      ...inputs,
      transitionId: "transition-conservative-projection",
    },
  );

  expect(result.outcome).toBe("degraded");
  expect(result).toMatchObject({
    effect: {
      runtime: {
        accessPolicy: {
          resources: [{ id: "analytics-script" }],
          valid: true,
        },
        consentPolicy: { optionalPurposeIds: ["analytics"] },
        effectiveAccess: {
          resources: [
            {
              access: "blocked",
              blockReasons: ["denied"],
              resourceId: "analytics-script",
            },
          ],
        },
      },
    },
  });
});

async function expectInvalidDecisionProjection(
  fixture: ReturnType<typeof runtimeFixture>,
  override: Partial<ConsentRuntimeDecisionCommand>,
  message: string,
  reads: () => number,
): Promise<void> {
  const calls: string[] = [];
  await expect(
    executeConsentRuntimeDecision(noEffectPorts(calls), {
      decision: {
        decidedAt: 1_500,
        expiresAt: 3_500,
        method: "accept-all",
        recordId: "record-2",
      },
      now: 1_500,
      policySnapshot: fixture.policySnapshot,
      resourcePolicy: fixture.resourcePolicy,
      transitionId: "transition-invalid-projection",
      ...override,
    }),
  ).rejects.toThrow(message);
  expect(reads()).toBe(0);
  expect(calls).toEqual([]);
}

it("rejects an accessor-backed policy snapshot before any effect", async () => {
  const fixture = runtimeFixture();
  let reads = 0;
  const policySnapshot = { ...fixture.policySnapshot };
  Object.defineProperty(policySnapshot, "policy", {
    get: () => {
      reads += 1;
      return fixture.policySnapshot.policy;
    },
  });

  await expectInvalidDecisionProjection(
    fixture,
    { policySnapshot },
    "Invalid consent runtime policy snapshot.",
    () => reads,
  );
});

it("rejects an accessor-backed resource policy before any effect", async () => {
  const fixture = runtimeFixture();
  let reads = 0;
  const resourcePolicy = { ...fixture.resourcePolicy };
  Object.defineProperty(resourcePolicy, "resources", {
    get: () => {
      reads += 1;
      return fixture.resourcePolicy.resources;
    },
  });

  await expectInvalidDecisionProjection(
    fixture,
    { resourcePolicy },
    "Invalid consent runtime resource policy.",
    () => reads,
  );
});

it.each(resourcePolicyIdentifierForgeries)(
  "rejects a forged resource-policy %s before any effect",
  async (_boundary, forge) => {
    const fixture = runtimeFixture();

    await expectInvalidDecisionProjection(
      fixture,
      { resourcePolicy: forge(fixture.resourcePolicy) },
      "Invalid consent runtime resource policy.",
      () => 0,
    );
  },
);

it("round-trips a defined resource identifier that recomposes after lowercasing", async () => {
  const fixture = runtimeFixture();
  const definition = defineResourcePolicy({
    policy: fixture.policySnapshot.policy,
    resources: [
      {
        access: "optional",
        id: "J\u030C",
        purposeIds: ["analytics"],
        serviceId: "metrics",
      },
    ],
    services: [{ id: "metrics" }],
  });
  if (!definition.ok) throw new Error("Resource policy must be valid.");
  expect(definition.resourcePolicy.resources[0]?.id).toBe("ǰ");

  const calls: string[] = [];
  await expect(
    executeConsentRuntimeDecision(noEffectPorts(calls), {
      decision: {
        decidedAt: 1_500,
        expiresAt: 3_500,
        method: "accept-all",
        recordId: "record-2",
      },
      now: 1_500,
      policySnapshot: fixture.policySnapshot,
      resourcePolicy: definition.resourcePolicy,
      transitionId: "transition-recomposed-identifier",
    }),
  ).resolves.toBeDefined();
});

it("rejects accessor-backed privacy restrictions before any effect", async () => {
  const fixture = runtimeFixture();
  let reads = 0;
  const privacyRestrictions = {
    purposeIds: [],
    resourceIds: [],
    serviceIds: [],
    source: "gpc" as const,
  };
  Object.defineProperty(privacyRestrictions, "purposeIds", {
    get: () => {
      reads += 1;
      return [];
    },
  });

  await expectInvalidDecisionProjection(
    fixture,
    { privacyRestrictions },
    "Invalid consent runtime privacy restrictions.",
    () => reads,
  );
});

it("rejects accessor-backed service preferences before any effect", async () => {
  const fixture = runtimeFixture();
  let reads = 0;
  const servicePreferences = { restrictedServiceIds: [] };
  Object.defineProperty(servicePreferences, "restrictedServiceIds", {
    get: () => {
      reads += 1;
      return [];
    },
  });

  await expectInvalidDecisionProjection(
    fixture,
    { servicePreferences },
    "Invalid consent runtime service preferences.",
    () => reads,
  );
});

it("preserves a mismatched resource purpose set as invalid", async () => {
  const fixture = runtimeFixture();
  const resourcePolicy = structuredClone(fixture.resourcePolicy) as unknown as {
    purposeIds: string[];
  } & DefinedResourcePolicy;
  resourcePolicy.purposeIds.splice(0);
  let durable: PersistedDecisionRecord | null = null;

  const result = await executeConsentRuntimeDecision(
    {
      broadcast: () => Promise.resolve(),
      commit: () => undefined,
      notify: () => undefined,
      receipt: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
      store: {
        clear: () => Promise.resolve(),
        clearIfCurrent: () => Promise.resolve("cleared"),
        compareAndSet: (_expected, candidate) => {
          durable = stateRecord(candidate);
          return Promise.resolve({ status: "written" });
        },
        read: () =>
          Promise.resolve(
            durable === null
              ? { status: "missing" as const }
              : { state: state(durable), status: "stored" as const },
          ),
      },
    },
    {
      decision: {
        decidedAt: 1_500,
        expiresAt: 3_500,
        method: "accept-all",
        recordId: "record-2",
      },
      now: 1_500,
      policySnapshot: fixture.policySnapshot,
      resourcePolicy,
      transitionId: "transition-invalid-resource-purpose-set",
    },
  );

  expect(result).toMatchObject({
    effect: { runtime: { accessPolicy: { valid: false } } },
    outcome: "committed",
  });
});

it("captures store and effect callbacks before persistence", async () => {
  const fixture = runtimeFixture();
  const calls: string[] = [];
  const maliciousCalls: string[] = [];
  let durable: PersistedDecisionRecord | null = null;
  const originalRead = function (this: DecisionStore) {
    expect(this).toBe(store);
    calls.push("read");
    return Promise.resolve(
      durable === null
        ? { status: "missing" as const }
        : { state: state(durable), status: "stored" as const },
    );
  };
  const store: DecisionStore = {
    clear: () => Promise.resolve(),
    clearIfCurrent: () => Promise.resolve("cleared"),
    compareAndSet: function (this: DecisionStore, _expected, candidate) {
      expect(this).toBe(store);
      calls.push("write");
      durable = stateRecord(candidate);
      const mutableStore = store as unknown as {
        read: DecisionStore["read"];
      };
      const mutablePorts = ports as unknown as {
        broadcast: ConsentRuntimeDecisionPorts["broadcast"];
        commit: ConsentRuntimeDecisionPorts["commit"];
        notify: ConsentRuntimeDecisionPorts["notify"];
      };
      mutableStore.read = () => {
        maliciousCalls.push("read");
        return Promise.resolve({ status: "missing" });
      };
      mutablePorts.commit = () => {
        maliciousCalls.push("commit");
      };
      mutablePorts.broadcast = () => {
        maliciousCalls.push("broadcast");
        return Promise.resolve();
      };
      mutablePorts.notify = () => {
        maliciousCalls.push("notify");
      };
      return Promise.resolve({ status: "written" });
    },
    read: originalRead,
  };
  const ports: ConsentRuntimeDecisionPorts = {
    broadcast: function (this: ConsentRuntimeDecisionPorts) {
      expect(this).toBe(ports);
      calls.push("broadcast");
      return Promise.resolve();
    },
    commit: function (this: ConsentRuntimeDecisionPorts) {
      expect(this).toBe(ports);
      calls.push("commit");
    },
    notify: function (this: ConsentRuntimeDecisionPorts) {
      expect(this).toBe(ports);
      calls.push("notify");
    },
    receipt: () => {
      calls.push("receipt");
      return Promise.resolve();
    },
    reconcile: () => {
      calls.push("reconcile");
      return Promise.resolve();
    },
    store,
  };

  const result = await executeConsentRuntimeDecision(ports, {
    decision: {
      decidedAt: 1_500,
      expiresAt: 3_500,
      method: "accept-all",
      recordId: "record-2",
    },
    now: 1_500,
    policySnapshot: fixture.policySnapshot,
    resourcePolicy: fixture.resourcePolicy,
    transitionId: "transition-captured-ports",
  });

  expect(result.outcome).toBe("committed");
  expect(calls).toEqual([
    "write",
    "read",
    "commit",
    "broadcast",
    "reconcile",
    "receipt",
    "notify",
  ]);
  expect(maliciousCalls).toEqual([]);
});

it("rejects an accessor-backed store callback before persistence", async () => {
  const fixture = runtimeFixture();
  const calls: string[] = [];
  let reads = 0;
  const ports = noEffectPorts(calls);
  Object.defineProperty(ports.store, "read", {
    get: () => {
      reads += 1;
      return () => Promise.resolve({ status: "missing" as const });
    },
  });

  await expect(
    executeConsentRuntimeDecision(ports, {
      decision: {
        decidedAt: 1_500,
        expiresAt: 3_500,
        method: "accept-all",
        recordId: "record-2",
      },
      now: 1_500,
      policySnapshot: fixture.policySnapshot,
      resourcePolicy: fixture.resourcePolicy,
      transitionId: "transition-invalid-store",
    }),
  ).rejects.toThrow("Invalid consent runtime ports.");
  expect(reads).toBe(0);
  expect(calls).toEqual([]);
});

it("precomputes denial projection before a callback can mutate inputs", async () => {
  const fixture = runtimeFixture();
  const inputs = mutableProjectionInputs(fixture);
  let durable: PersistedDecisionRecord | null = null;
  const portTarget: ConsentRuntimeDecisionPorts = {
    broadcast: () => Promise.resolve(),
    commit: () => undefined,
    notify: () => undefined,
    receipt: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    store: {
      clear: () => Promise.resolve(),
      clearIfCurrent: () => Promise.resolve("cleared" as const),
      compareAndSet: (_expected: unknown, candidate: PersistedConsentState) => {
        durable = stateRecord(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: state(durable), status: "stored" as const },
        ),
    },
  };
  const ports = new Proxy(portTarget, {
    get: (target, property, receiver) => {
      if (property === "commit") mutateProjectionInputs(inputs);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  const result = await executeConsentRuntimeDecision(ports, {
    decision: {
      decidedAt: 1_500,
      expiresAt: 3_500,
      method: "reject-all",
      recordId: "record-2",
    },
    now: 1_500,
    ...inputs,
    transitionId: "transition-precomputed-denial",
  });

  expect(result.outcome).toBe("committed");
  expect(result).toMatchObject({
    effect: {
      runtime: {
        accessPolicy: {
          resources: [{ id: "analytics-script" }],
          valid: true,
        },
        consentPolicy: { optionalPurposeIds: ["analytics"] },
      },
    },
  });
});

it("precomputes withdrawal projection before a callback can mutate inputs", async () => {
  const fixture = runtimeFixture();
  const inputs = mutableProjectionInputs(fixture);
  let durable: PersistedDecisionRecord | null = toPersistedDecisionRecord(
    fixture.currentRecord,
  );
  const portTarget: ConsentRuntimeDecisionPorts = {
    broadcast: () => Promise.resolve(),
    commit: () => undefined,
    notify: () => undefined,
    receipt: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    store: {
      clear: () => Promise.resolve(),
      clearIfCurrent: () => Promise.resolve("cleared" as const),
      compareAndSet: (_expected: unknown, candidate: PersistedConsentState) => {
        durable = stateRecord(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: state(durable), status: "stored" as const },
        ),
    },
  };
  const ports = new Proxy(portTarget, {
    get: (target, property, receiver) => {
      if (property === "commit") mutateProjectionInputs(inputs);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  const result = await executeConsentRuntimeWithdrawal(ports, {
    currentRecord: fixture.currentRecord,
    now: 2_000,
    ...inputs,
    transitionId: "transition-precomputed-withdrawal",
  });

  expect(result.outcome).toBe("committed");
  expect(result).toMatchObject({
    effect: {
      runtime: {
        accessPolicy: {
          resources: [{ id: "analytics-script" }],
          valid: true,
        },
        consentPolicy: { optionalPurposeIds: ["analytics"] },
      },
    },
  });
});

it("captures withdrawal policy history once before observing ports", async () => {
  const fixture = runtimeFixture();
  const mutableSnapshot = structuredClone(fixture.policySnapshot);
  const history = [mutableSnapshot];
  let descriptorReads = 0;
  const observedHistory = new Proxy(history, {
    getOwnPropertyDescriptor: (target, property) => {
      if (property === "0") descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  let durable: PersistedDecisionRecord | null = toPersistedDecisionRecord(
    fixture.currentRecord,
  );
  const calls: string[] = [];
  const ports = noEffectPorts(calls);
  const mutableStore = ports.store as {
    compareAndSet: DecisionStore["compareAndSet"];
    read: DecisionStore["read"];
  };
  mutableStore.compareAndSet = (_expected, candidate) => {
    durable = stateRecord(candidate);
    (mutableSnapshot as { policyVersion: string }).policyVersion = "mutated";
    history.length = 0;
    return Promise.resolve({ status: "written" });
  };
  mutableStore.read = () =>
    Promise.resolve(
      durable === null
        ? { status: "missing" as const }
        : { state: state(durable), status: "stored" as const },
    );

  const result = await executeConsentRuntimeWithdrawal(ports, {
    currentRecord: fixture.currentRecord,
    now: 2_000,
    policyHistory: observedHistory,
    policySnapshot: fixture.policySnapshot,
    resourcePolicy: fixture.resourcePolicy,
    transitionId: "transition-withdrawal-history",
  });

  expect(result.outcome).toBe("committed");
  expect(descriptorReads).toBe(1);
  expect(result).toMatchObject({
    effect: { runtime: { policyReconciliation: { status: "withdrawn" } } },
  });
});

it("rejects hostile withdrawal policy history before observing ports", async () => {
  const fixture = runtimeFixture();
  const calls: string[] = [];
  let reads = 0;
  const command = {
    currentRecord: fixture.currentRecord,
    now: 2_000,
    policySnapshot: fixture.policySnapshot,
    resourcePolicy: fixture.resourcePolicy,
    transitionId: "transition-hostile-withdrawal-history",
  };
  Object.defineProperty(command, "policyHistory", {
    get: () => {
      reads += 1;
      return [fixture.policySnapshot];
    },
  });

  await expect(
    executeConsentRuntimeWithdrawal(noEffectPorts(calls), command),
  ).rejects.toThrow("Invalid consent runtime policy history.");
  expect(reads).toBe(0);
  expect(calls).toEqual([]);
});

it("captures policy history once before persistence and detaches it from mutation", async () => {
  const fixture = runtimeFixture();
  const capturedSnapshot = structuredClone(fixture.policySnapshot);
  const policyHistory = [capturedSnapshot];
  let descriptorReads = 0;
  const observedHistory = new Proxy(policyHistory, {
    getOwnPropertyDescriptor: (target, property) => {
      if (property === "0") descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  let durable: PersistedDecisionRecord | null = null;
  const calls: string[] = [];
  const ports = noEffectPorts(calls);
  const mutableStore = ports.store as {
    compareAndSet: DecisionStore["compareAndSet"];
    read: DecisionStore["read"];
  };
  mutableStore.compareAndSet = (_expected, candidate) => {
    durable = stateRecord(candidate);
    (capturedSnapshot as { policyVersion: string }).policyVersion = "mutated";
    policyHistory.length = 0;
    return Promise.resolve({ status: "written" });
  };
  mutableStore.read = () =>
    Promise.resolve(
      durable === null
        ? { status: "missing" as const }
        : { state: state(durable), status: "stored" as const },
    );

  const result = await executeConsentRuntimeDecision(ports, {
    decision: {
      decidedAt: 1_500,
      expiresAt: 3_500,
      method: "accept-all",
      recordId: "record-history-capture",
    },
    now: 1_500,
    policyHistory: observedHistory,
    policySnapshot: fixture.policySnapshot,
    resourcePolicy: fixture.resourcePolicy,
    transitionId: "transition-history-capture",
  });

  expect(result.outcome).toBe("committed");
  expect(descriptorReads).toBe(1);
  expect(result).toMatchObject({
    effect: {
      runtime: { policyReconciliation: { status: "current" } },
    },
  });
});

it("defaults policy history to the captured current snapshot", async () => {
  const fixture = runtimeFixture();
  let durable: PersistedDecisionRecord | null = null;
  const ports = noEffectPorts([]);
  const mutableStore = ports.store as {
    compareAndSet: DecisionStore["compareAndSet"];
    read: DecisionStore["read"];
  };
  mutableStore.compareAndSet = (_expected, candidate) => {
    durable = stateRecord(candidate);
    return Promise.resolve({ status: "written" });
  };
  mutableStore.read = () =>
    Promise.resolve(
      durable === null
        ? { status: "missing" as const }
        : { state: state(durable), status: "stored" as const },
    );

  const result = await executeConsentRuntimeDecision(ports, {
    decision: {
      decidedAt: 1_500,
      expiresAt: 3_500,
      method: "accept-all",
      recordId: "record-default-history",
    },
    now: 1_500,
    policySnapshot: fixture.policySnapshot,
    resourcePolicy: fixture.resourcePolicy,
    transitionId: "transition-default-history",
  });

  expect(result).toMatchObject({
    effect: {
      runtime: { policyReconciliation: { status: "current" } },
    },
    outcome: "committed",
  });
});

it("rejects accessor-backed policy history without invoking the accessor", async () => {
  const fixture = runtimeFixture();
  const calls: string[] = [];
  let reads = 0;
  const command = {
    decision: {
      decidedAt: 1_500,
      expiresAt: 3_500,
      method: "accept-all" as const,
      recordId: "record-accessor-history",
    },
    now: 1_500,
    policySnapshot: fixture.policySnapshot,
    resourcePolicy: fixture.resourcePolicy,
    transitionId: "transition-accessor-history",
  };
  Object.defineProperty(command, "policyHistory", {
    get: () => {
      reads += 1;
      return [fixture.policySnapshot];
    },
  });

  await expect(
    executeConsentRuntimeDecision(noEffectPorts(calls), command),
  ).rejects.toThrow("Invalid consent runtime policy history.");
  expect(reads).toBe(0);
  expect(calls).toEqual([]);
});

it.each([
  {
    history: () => new Array<PolicySnapshot>(1),
    name: "sparse",
  },
  {
    history: () => {
      const history: PolicySnapshot[] = [];
      Object.defineProperty(history, "0", {
        get: () => {
          throw new Error("history accessor must not run");
        },
      });
      Object.defineProperty(history, "length", { value: 1 });
      return history;
    },
    name: "accessor-backed",
  },
  {
    history: () => {
      const { proxy, revoke } = Proxy.revocable<PolicySnapshot[]>([], {});
      revoke();
      return proxy;
    },
    name: "revoked",
  },
  {
    history: (snapshot: PolicySnapshot) =>
      Array.from({ length: 33 }, () => snapshot),
    name: "over-limit",
  },
])(
  "rejects $name policy history before observing ports",
  async ({ history }) => {
    const fixture = runtimeFixture();
    const calls: string[] = [];

    await expect(
      executeConsentRuntimeDecision(noEffectPorts(calls), {
        decision: {
          decidedAt: 1_500,
          expiresAt: 3_500,
          method: "accept-all",
          recordId: "record-invalid-history",
        },
        now: 1_500,
        policyHistory: history(fixture.policySnapshot),
        policySnapshot: fixture.policySnapshot,
        resourcePolicy: fixture.resourcePolicy,
        transitionId: "transition-invalid-history",
      }),
    ).rejects.toThrow("Invalid consent runtime policy history.");
    expect(calls).toEqual([]);
  },
);
