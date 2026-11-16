import { expect, it } from "vitest";

import {
  AUTO_TEST_STORAGE_KEY,
  comparablePortCalls,
  createParityHarness,
  deferred,
  expectProductParity,
  receiptPortCalls,
  runScenarioOnBoth,
  seededDecisionBytes,
  storageEntries,
  waitUntil,
  type ParityHarness,
  type ParityHarnessOptions,
  type ParityScenarioRun,
} from "./auto-product-test-fixtures.test-helper.js";

interface ParityRow {
  readonly name: string;
  readonly options?: ParityHarnessOptions;
  readonly scenario: (harness: ParityHarness) => Promise<unknown>;
  readonly verify?: (run: ParityScenarioRun) => void;
}

async function seedForeignEntries(
  harness: ParityHarness,
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  await Promise.resolve();
  for (const [key, value] of Object.entries(entries)) {
    harness.storage.values.set(key, value);
  }
}

const rows: readonly ParityRow[] = [
  {
    name: "accept-all grant commits and activates identically",
    scenario: async (harness) => {
      await harness.client.initialize();
      const result = await harness.client.acceptAll();
      return { result };
    },
    verify: (run) => {
      const { result } = run.auto.outcome as { result: { outcome: string } };
      expect(result.outcome).toBe("committed");
      expect(run.auto.harness.client.getSnapshot().grantActivation).toBe(
        "active",
      );
      expect(
        run.auto.harness.client.getSnapshot().runtime.policyReconciliation,
      ).toEqual(
        run.generic.harness.client.getSnapshot().runtime.policyReconciliation,
      );
      expect(
        run.auto.harness.client.getSnapshot().runtime.policyReconciliation
          ?.status,
      ).toBe("current");
    },
  },
  {
    name: "reject-all terminal denial persists identically",
    scenario: async (harness) => {
      await harness.client.initialize();
      const result = await harness.client.rejectAll();
      return { result };
    },
    verify: (run) => {
      const { result } = run.auto.outcome as { result: { outcome: string } };
      expect(result.outcome).toBe("committed");
    },
  },
  {
    name: "granular grant then complete granular denial match",
    scenario: async (harness) => {
      await harness.client.initialize();
      const granted = await harness.client.savePreferences(["analytics"]);
      const denied = await harness.client.savePreferences([]);
      return { denied, granted };
    },
  },
  {
    name: "repeating the same decision reports unchanged",
    scenario: async (harness) => {
      await harness.client.initialize();
      const first = await harness.client.acceptAll();
      const repeated = await harness.client.acceptAll();
      return { first, repeated };
    },
    verify: (run) => {
      const { repeated } = run.auto.outcome as {
        repeated: { outcome: string };
      };
      expect(repeated.outcome).toBe("unchanged");
    },
  },
  {
    name: "withdrawal after an active grant matches",
    scenario: async (harness) => {
      await harness.client.initialize();
      const granted = await harness.client.acceptAll();
      const withdrawn = await harness.client.withdrawConsent();
      return { granted, withdrawn };
    },
    verify: (run) => {
      const { withdrawn } = run.auto.outcome as {
        withdrawn: { outcome: string };
      };
      expect(withdrawn.outcome).toBe("committed");
    },
  },
  {
    name: "withdrawal without a record is not applicable",
    scenario: async (harness) => {
      await harness.client.initialize();
      const withdrawn = await harness.client.withdrawConsent();
      return { withdrawn };
    },
    verify: (run) => {
      const { withdrawn } = run.auto.outcome as {
        withdrawn: { outcome: string };
      };
      expect(withdrawn.outcome).toBe("not-applicable");
    },
  },
  {
    name: "broadcast failure parks the grant and retry keeps its identity",
    scenario: async (harness) => {
      await harness.client.initialize();
      harness.control.failBroadcastOnce = true;
      const parked = await harness.client.acceptAll();
      harness.clock.advance(5_000);
      const retried = await harness.client.acceptAll();
      return { parked, retried };
    },
    verify: (run) => {
      const { parked, retried } = run.auto.outcome as {
        parked: {
          outcome: string;
          transition: { record: { recordId: string } };
        };
        retried: {
          outcome: string;
          transition: { record: { recordId: string } };
        };
      };
      expect(parked.outcome).toBe("pending");
      expect(retried.outcome).toBe("committed");
      expect(retried.transition.record.recordId).toBe(
        parked.transition.record.recordId,
      );
      const receipts = receiptPortCalls(run.generic.harness);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.payload).toMatchObject({
        decidedAt: 1_000,
        occurredAt: 6_000,
        persistenceStatus: "confirmed",
      });
    },
  },
  {
    name: "a repeated in-flight decision coalesces onto one completion",
    scenario: async (harness) => {
      await harness.client.initialize();
      const gate = deferred();
      harness.control.broadcastGate = gate.promise;
      const first = harness.client.acceptAll();
      await waitUntil(() =>
        harness.calls.some((call) => call.port === "broadcast"),
      );
      const second = harness.client.acceptAll();
      harness.control.broadcastGate = undefined;
      gate.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      return { firstResult, sameCompletion: firstResult === secondResult };
    },
    verify: (run) => {
      const { sameCompletion } = run.auto.outcome as {
        sameCompletion: boolean;
      };
      expect(sameCompletion).toBe(true);
    },
  },
  {
    name: "a foreign durable write parks staging in the persistence phase",
    scenario: async (harness) => {
      const foreign = await seededDecisionBytes((client) => client.rejectAll());
      await harness.client.initialize();
      await seedForeignEntries(harness, foreign);
      const parked = await harness.client.acceptAll();
      return { parked };
    },
    verify: (run) => {
      const { parked } = run.auto.outcome as { parked: { outcome: string } };
      expect(parked.outcome).toBe("pending");
      expect(run.auto.harness.client.getSnapshot().pendingGrant).toMatchObject({
        phase: "persistence",
      });
    },
  },
  {
    name: "a reload resumes a staged pending grant identically",
    scenario: async (harness) => {
      await harness.client.initialize();
      const gate = deferred();
      harness.control.broadcastGate = gate.promise;
      const pending = harness.client.acceptAll();
      await waitUntil(() =>
        harness.calls.some((call) => call.port === "broadcast"),
      );
      const staged = Object.entries(storageEntries(harness)).map(
        (entry) => [entry[0], entry[1]] as const,
      );
      const reloaded = createParityHarness(harness.kind, {
        initialEntries: staged,
      });
      const resumedSnapshot = await reloaded.client.initialize();
      harness.control.broadcastGate = undefined;
      gate.resolve();
      const original = await pending;
      return {
        original,
        resumedCalls: comparablePortCalls(reloaded),
        resumedSnapshot,
        resumedStorage: storageEntries(reloaded),
      };
    },
  },
  {
    name: "a terminal decision supersedes the pending grant",
    scenario: async (harness) => {
      await harness.client.initialize();
      const gate = deferred();
      harness.control.broadcastGate = gate.promise;
      const pending = harness.client.acceptAll();
      await waitUntil(() =>
        harness.calls.some((call) => call.port === "broadcast"),
      );
      const terminalPromise = harness.client.rejectAll();
      await waitUntil(
        () => harness.client.getSnapshot().record?.method === "reject-all",
      );
      harness.control.broadcastGate = undefined;
      gate.resolve();
      const [terminal, superseded] = await Promise.all([
        terminalPromise,
        pending,
      ]);
      return { superseded, terminal };
    },
    verify: (run) => {
      const { superseded, terminal } = run.auto.outcome as {
        superseded: { diagnostics?: readonly { code: string }[] };
        terminal: { outcome: string };
      };
      expect(terminal.outcome).toBe("committed");
      expect(superseded.diagnostics).toEqual(
        expect.arrayContaining([
          { code: "grant-activation-conflict" },
          { code: "grant-superseded" },
        ]),
      );
    },
  },
  {
    name: "a foreign activation conflict corrects the completion",
    scenario: async (harness) => {
      const foreign = await seededDecisionBytes((client) => client.rejectAll());
      await harness.client.initialize();
      const gate = deferred();
      harness.control.broadcastGate = gate.promise;
      const pending = harness.client.acceptAll();
      await waitUntil(() =>
        harness.calls.some((call) => call.port === "broadcast"),
      );
      await seedForeignEntries(harness, foreign);
      harness.control.broadcastGate = undefined;
      gate.resolve();
      const corrected = await pending;
      return { corrected };
    },
    verify: (run) => {
      const { corrected } = run.auto.outcome as {
        corrected: { outcome: string };
      };
      expect(corrected.outcome).not.toBe("committed");
    },
  },
  {
    name: "live expiry runs identical expiry effects on refresh",
    scenario: async (harness) => {
      await harness.client.initialize();
      await harness.client.acceptAll();
      harness.clock.advance(61_000);
      const refreshed = await harness.client.refresh();
      return { refreshed };
    },
    verify: (run) => {
      expect(
        run.auto.harness.client.getSnapshot().runtime.consentEvaluation,
      ).toMatchObject({ status: "expired" });
    },
  },
  {
    name: "invalid stored bytes are preserved on both products",
    options: {
      initialEntries: [[AUTO_TEST_STORAGE_KEY, "!!not-an-envelope!!"]],
    },
    scenario: async (harness) => {
      const snapshot = await harness.client.initialize();
      return { snapshot };
    },
    verify: (run) => {
      expect(run.auto.harness.client.getSnapshot().readiness).toBe("invalid");
      expect(storageEntries(run.auto.harness)).toEqual({
        [AUTO_TEST_STORAGE_KEY]: "!!not-an-envelope!!",
      });
    },
  },
  {
    name: "a thrown store write parks the grant unconfirmed",
    scenario: async (harness) => {
      await harness.client.initialize();
      harness.storage.behavior.failNextSet = true;
      const parked = await harness.client.acceptAll();
      const retried = await harness.client.retryPendingGrant();
      return { parked, retried };
    },
    verify: (run) => {
      const { parked, retried } = run.auto.outcome as {
        parked: { outcome: string };
        retried: { outcome: string };
      };
      expect(parked.outcome).toBe("pending");
      expect(retried.outcome).toBe("committed");
    },
  },
  {
    name: "a thrown store write degrades a terminal denial",
    scenario: async (harness) => {
      await harness.client.initialize();
      harness.storage.behavior.failNextSet = true;
      const denied = await harness.client.rejectAll();
      return { denied };
    },
    verify: (run) => {
      const { denied } = run.auto.outcome as { denied: { outcome: string } };
      expect(denied.outcome).toBe("degraded");
    },
  },
  {
    name: "a dropped write surfaces the same readback mismatch",
    scenario: async (harness) => {
      await harness.client.initialize();
      harness.storage.behavior.dropNextSet = true;
      const denied = await harness.client.rejectAll();
      return { denied };
    },
    verify: (run) => {
      const { denied } = run.auto.outcome as { denied: { outcome: string } };
      expect(denied.outcome).toBe("degraded");
    },
  },
  {
    name: "a vanished write surfaces the same missing readback",
    scenario: async (harness) => {
      await harness.client.initialize();
      harness.storage.behavior.vanishNextSet = true;
      const denied = await harness.client.rejectAll();
      return { denied };
    },
    verify: (run) => {
      const { denied } = run.auto.outcome as { denied: { outcome: string } };
      expect(denied.outcome).toBe("degraded");
    },
  },
  {
    name: "unavailable persistence behaves identically",
    options: { persistence: "unavailable" },
    scenario: async (harness) => {
      await harness.client.initialize();
      const parked = await harness.client.acceptAll();
      const denied = await harness.client.rejectAll();
      return { denied, parked };
    },
    verify: (run) => {
      const { parked } = run.auto.outcome as { parked: { outcome: string } };
      expect(parked.outcome).toBe("pending");
    },
  },
  {
    name: "raw GPC observations resolve inside the product",
    options: {
      gpc: {
        navigationId: "https://example.com/",
        observations: [
          { observedAtMs: 500, source: "server", value: "enabled" },
        ],
      },
    },
    scenario: async (harness) => {
      await harness.client.initialize();
      const granted = await harness.client.acceptAll();
      return { granted };
    },
  },
  {
    name: "a restored record from a foreign catalogue prompts again",
    scenario: async (harness) => {
      const foreign = await seededDecisionBytes(
        (client) => client.acceptAll(),
        {
          purposeId: "ads",
        },
      );
      await seedForeignEntries(harness, foreign);
      const snapshot = await harness.client.initialize();
      return { snapshot };
    },
    verify: (run) => {
      const auto = run.auto.harness.client.getSnapshot().runtime;
      expect(auto.consentEvaluation.prompt).toBe(true);
      expect(auto.policyReconciliation).toMatchObject({
        decisions: [{ purposeId: "analytics", value: "unresolved" }],
        prompt: true,
        status: "invalid",
      });
      expect(auto.accessConsent).toEqual({
        decisions: [{ decision: "unresolved", purposeId: "analytics" }],
        status: "requires-reconsent",
      });
    },
  },
  {
    name: "receipt aftercare is the only committed-grant difference",
    scenario: async (harness) => {
      await harness.client.initialize();
      const result = await harness.client.acceptAll();
      return { result };
    },
    verify: (run) => {
      expect(run.generic.harness.calls.map((call) => call.port)).toEqual([
        "broadcast",
        "reconcile",
        "receipt",
      ]);
      expect(run.auto.harness.calls.map((call) => call.port)).toEqual([
        "broadcast",
        "reconcile",
      ]);
      const receipts = receiptPortCalls(run.generic.harness);
      expect(receipts[0]?.payload).toMatchObject({
        occurredAt: 1_000,
        persistenceStatus: "confirmed",
        schemaVersion: 2,
      });
    },
  },
  {
    name: "policy, resource, catalogue, and decision-surface identity match",
    scenario: async (harness) => {
      const snapshot = await harness.client.initialize();
      return { snapshot };
    },
    verify: (run) => {
      const auto = run.auto.harness.client.getSnapshot();
      const generic = run.generic.harness.client.getSnapshot();
      expect(auto.policySnapshot.catalogueDigest).toBe(
        generic.policySnapshot.catalogueDigest,
      );
      expect(auto.policySnapshot.decisionSurfaceDigest).toBe(
        generic.policySnapshot.decisionSurfaceDigest,
      );
      expect(auto.policySnapshot.policy).toEqual(generic.policySnapshot.policy);
      expect(auto.runtime.accessPolicy).toEqual(generic.runtime.accessPolicy);
      expect(auto.runtime.policyReconciliation).toEqual(
        generic.runtime.policyReconciliation,
      );
      expect(auto.runtime.policyReconciliation?.status).toBeUndefined();
    },
  },
];

it.each(rows)(
  "$name",
  async ({ options, scenario, verify }) => {
    const run = await runScenarioOnBoth(options ?? {}, scenario);
    expectProductParity(run);
    verify?.(run);
  },
  20_000,
);

it("preserves a valid withdrawal across a current-only policy identity change", async () => {
  const withdrawnEntries = await seededDecisionBytes(
    async (client) => {
      await client.acceptAll();
      return client.withdrawConsent();
    },
    { policyVersion: "policy-1" },
  );
  const run = await runScenarioOnBoth(
    {
      initialEntries: Object.entries(withdrawnEntries),
      policyVersion: "policy-2",
    },
    (harness) => harness.client.initialize(),
  );

  expectProductParity(run);
  expect(run.auto.harness.client.getSnapshot()).toMatchObject({
    preferencesOpen: false,
    runtime: {
      policyReconciliation: { prompt: false, status: "withdrawn" },
    },
  });
});

it("blocks a restored grant whose catalogue identity alone changed", async () => {
  const historicEntries = await seededDecisionBytes(
    (client) => client.acceptAll(),
    { editorialNote: "Historic catalogue-only note." },
  );
  const run = await runScenarioOnBoth(
    { initialEntries: Object.entries(historicEntries) },
    (harness) => harness.client.initialize(),
  );

  expectProductParity(run);
  expect(run.auto.harness.client.getSnapshot()).toMatchObject({
    preferencesOpen: true,
    runtime: {
      accessConsent: {
        decisions: [{ decision: "unresolved", purposeId: "analytics" }],
        status: "requires-reconsent",
      },
      policyReconciliation: { prompt: true, status: "invalid" },
    },
  });
});

it.each([
  [
    "unsupported identity version",
    (digest: string) => digest.replace("sha256-v1:", "sha256-v2:"),
  ],
  ["unsupported identity format", (digest: string) => `${digest}a`],
] as const)(
  "rejects a foreign withdrawal with %s identically",
  async (_variant, corruptDigest) => {
    const withdrawnEntries = await seededDecisionBytes(
      async (client) => {
        await client.acceptAll();
        return client.withdrawConsent();
      },
      { policyVersion: "policy-1" },
    );
    const corruptedEntries = Object.entries(withdrawnEntries).map(
      ([key, raw]) => {
        const envelope = JSON.parse(raw) as {
          record: {
            catalogueDigest: string;
            decisionSurfaceDigest: string;
          };
        };
        envelope.record.catalogueDigest = corruptDigest(
          envelope.record.catalogueDigest,
        );
        envelope.record.decisionSurfaceDigest = corruptDigest(
          envelope.record.decisionSurfaceDigest,
        );
        return [key, JSON.stringify(envelope)] as const;
      },
    );
    const run = await runScenarioOnBoth(
      { initialEntries: corruptedEntries, policyVersion: "policy-2" },
      (harness) => harness.client.initialize(),
    );

    expectProductParity(run);
    expect(run.auto.harness.client.getSnapshot()).toMatchObject({
      preferencesOpen: true,
      runtime: {
        policyReconciliation: { prompt: true, status: "invalid" },
      },
    });
  },
);
