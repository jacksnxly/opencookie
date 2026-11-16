import { expect, it } from "vitest";

import {
  executeDenialTransition,
  type DenialTransitionPorts,
  type PersistedDecisionRecord,
} from "../../application.js";
import {
  executeDenialTransitionProgram,
  type SupersedingDenialTransitionProgram,
} from "./execute-denial-transition.js";

interface TestDenialState {
  readonly value: string;
}

type TestDenialProgram = SupersedingDenialTransitionProgram<
  TestDenialState,
  string,
  "finished"
>;

it("immediately hands superseding persistence to its dedicated lane before signal work", async () => {
  const order: string[] = [];
  let lane = "caller";
  let runPersistence: (() => Promise<void>) | undefined;

  const planPromise = executeDenialTransitionProgram<
    TestDenialState,
    string,
    "finished",
    TestDenialProgram
  >({
    broadcast: () => {
      order.push(`broadcast:${lane}`);
      return Promise.resolve();
    },
    candidate: { value: "denied" },
    commit: () => {
      order.push(`commit:${lane}`);
    },
    completions: [],
    equals: (left, right) => left.value === right.value,
    finalize: () => {
      order.push(`finalize:${lane}`);
      return "finished" as const;
    },
    kind: "superseding" as const,
    pending: "pending",
    preconditions: [],
    predecessors: [{ value: "granted" }],
    publish: () => {
      order.push(`publish:${lane}`);
    },
    receipt: () => {
      order.push(`receipt:${lane}`);
      return Promise.resolve();
    },
    reconcile: () => {
      order.push(`reconcile:${lane}`);
      return Promise.resolve();
    },
    schedule: async (operation) => {
      lane = "signal";
      try {
        return await operation();
      } finally {
        lane = "caller";
      }
    },
    schedulePersistence: (operation: () => Promise<void>) =>
      new Promise<void>((resolve) => {
        runPersistence = async () => {
          lane = "persistence";
          try {
            await operation();
          } finally {
            lane = "caller";
            resolve();
          }
        };
      }),
    store: {
      compareAndSet: () => {
        order.push(`persist:${lane}`);
        return Promise.resolve({ status: "written" as const });
      },
    },
  });

  await Promise.resolve();
  expect(runPersistence).toBeTypeOf("function");
  const plan = await planPromise;
  expect(order).toEqual([]);

  await runPersistence?.();
  await expect(plan.completion).resolves.toBe("finished");
  expect(order).toEqual([
    "persist:persistence",
    "commit:persistence",
    "broadcast:signal",
    "reconcile:signal",
    "receipt:signal",
    "publish:signal",
    "finalize:signal",
  ]);
});

it("blocks rejection before persistence and survives broadcaster failure", async () => {
  const order: string[] = [];
  const rejection: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: { ads: "denied", analytics: "denied" },
    expiresAt: 2_000,
    method: "reject-all",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 2,
  };
  const store = {
    clear: () => {
      order.push("clear");
      return Promise.resolve();
    },
    clearIfCurrent: () => {
      order.push("clear");
      return Promise.resolve("cleared" as const);
    },
    compareAndSet: () => {
      order.push("persist");
      return Promise.reject(new Error("quota exceeded"));
    },
    read: () => Promise.reject(new Error("denial does not need readback")),
  };
  const ports: DenialTransitionPorts = {
    broadcast: () => {
      order.push("signal");
      return Promise.reject(new Error("broadcaster unavailable"));
    },
    commit: () => order.push("commit"),
    notify: () => order.push("notify"),
    receipt: () => {
      order.push("receipt");
      return Promise.resolve();
    },
    reconcile: () => {
      order.push("block");
      return Promise.resolve();
    },
    store,
  };

  const result = await executeDenialTransition(ports, {
    expectedRecord: { ...rejection, revision: 1 },
    rejection,
    transitionId: "transition-2",
  });

  expect(order).toEqual([
    "commit",
    "signal",
    "block",
    "persist",
    "clear",
    "receipt",
    "notify",
  ]);
  expect(result).toEqual({
    diagnostics: [
      { code: "denial-signal-broadcast-failed" },
      { code: "denial-persistence-failed" },
    ],
    outcome: "degraded",
    transition: {
      persistenceStatus: "failed",
      record: rejection,
      transitionId: "transition-2",
    },
  });
});

it("persists rejection and delivers receipt and notification after reconcile fails", async () => {
  const order: string[] = [];
  const rejection: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: { ads: "denied", analytics: "denied" },
    expiresAt: 2_000,
    method: "reject-all",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 2,
  };
  const ports: DenialTransitionPorts = {
    broadcast: () => {
      order.push("signal");
      return Promise.resolve();
    },
    commit: () => order.push("commit"),
    notify: () => order.push("notify"),
    receipt: () => {
      order.push("receipt");
      return Promise.resolve();
    },
    reconcile: () => {
      order.push("block");
      return Promise.reject(new Error("cleanup failed"));
    },
    store: {
      clear: () => Promise.resolve(),
      clearIfCurrent: () => Promise.resolve("cleared" as const),
      compareAndSet: () => {
        order.push("persist");
        return Promise.resolve({ status: "written" });
      },
      read: () => Promise.reject(new Error("denial does not need readback")),
    },
  };

  await expect(
    executeDenialTransition(ports, {
      expectedRecord: { ...rejection, revision: 1 },
      rejection,
      transitionId: "transition-2",
    }),
  ).resolves.toEqual({
    diagnostics: [{ code: "denial-reconcile-failed" }],
    outcome: "degraded",
    transition: {
      persistenceStatus: "confirmed",
      record: rejection,
      transitionId: "transition-2",
    },
  });
  expect(order).toEqual([
    "commit",
    "signal",
    "block",
    "persist",
    "receipt",
    "notify",
  ]);
});
