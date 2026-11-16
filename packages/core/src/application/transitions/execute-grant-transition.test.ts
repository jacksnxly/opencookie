import { expect, it } from "vitest";

import {
  executeGrantTransition,
  type GrantTransitionPorts,
  type PersistedDecisionRecord,
} from "../../application.js";

it("orders a confirmed grant before downstream activation", async () => {
  const order: string[] = [];
  const candidate: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: { analytics: "granted" },
    expiresAt: 2_000,
    method: "accept-all",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  };
  const observedTransitions: unknown[] = [];
  const ports: GrantTransitionPorts = {
    broadcast: (transition) => {
      order.push("signal");
      observedTransitions.push(transition);
      return Promise.resolve();
    },
    commit: (transition) => {
      order.push("commit");
      observedTransitions.push(transition);
    },
    notify: (transition) => {
      order.push("notify");
      observedTransitions.push(transition);
    },
    receipt: (transition) => {
      order.push("receipt");
      observedTransitions.push(transition);
      return Promise.resolve();
    },
    reconcile: (transition) => {
      order.push("reconcile");
      observedTransitions.push(transition);
      return Promise.resolve();
    },
    store: {
      clear: () => Promise.resolve(),
      clearIfCurrent: () => Promise.resolve("cleared" as const),
      compareAndSet: () => {
        order.push("write");
        return Promise.resolve({ status: "written" });
      },
      read: () => {
        order.push("readback");
        return Promise.resolve({
          state: { record: candidate },
          status: "stored",
        });
      },
    },
  };

  const result = await executeGrantTransition(ports, {
    candidate,
    expectedRecord: null,
    previous: null,
    transitionId: "transition-1",
  });

  expect(order).toEqual([
    "write",
    "readback",
    "commit",
    "signal",
    "reconcile",
    "receipt",
    "notify",
  ]);
  expect(result).toEqual({
    outcome: "committed",
    transition: {
      persistenceStatus: "confirmed",
      record: candidate,
      transitionId: "transition-1",
    },
  });
  expect(observedTransitions).toHaveLength(5);
  expect(observedTransitions.every((value) => Object.isFrozen(value))).toBe(
    true,
  );
  expect(new Set(observedTransitions).size).toBe(1);
});

it("does not activate resources when grant broadcasting fails", async () => {
  const order: string[] = [];
  const candidate: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: { analytics: "granted" },
    expiresAt: 2_000,
    method: "accept-all",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  };
  const ports: GrantTransitionPorts = {
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
      order.push("reconcile");
      return Promise.resolve();
    },
    store: {
      clear: () => Promise.resolve(),
      clearIfCurrent: () => Promise.resolve("cleared" as const),
      compareAndSet: () => {
        order.push("write");
        return Promise.resolve({ status: "written" });
      },
      read: () => {
        order.push("readback");
        return Promise.resolve({
          state: { record: candidate },
          status: "stored",
        });
      },
    },
  };

  await expect(
    executeGrantTransition(ports, {
      candidate,
      expectedRecord: null,
      previous: null,
      transitionId: "transition-1",
    }),
  ).rejects.toThrow("broadcaster unavailable");
  expect(order).toEqual(["write", "readback", "commit", "signal"]);
});

it("applies only conservative narrowing when a mixed grant save fails", async () => {
  const order: string[] = [];
  const observedTransitions: unknown[] = [];
  const previous: PersistedDecisionRecord = {
    catalogueDigest: "catalogue-1",
    decidedAt: 1_000,
    decisionSurfaceDigest: "surface-1",
    decisions: { ads: "denied", analytics: "granted" },
    expiresAt: 2_000,
    method: "granular",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  };
  const candidate: PersistedDecisionRecord = {
    ...previous,
    decidedAt: 1_500,
    decisions: { ads: "granted", analytics: "denied" },
    expiresAt: 2_500,
    revision: 2,
  };
  const observe = (label: string) => (transition: unknown) => {
    order.push(label);
    observedTransitions.push(transition);
  };
  const ports: GrantTransitionPorts = {
    broadcast: (transition) => {
      observe("signal")(transition);
      return Promise.resolve();
    },
    commit: observe("commit"),
    notify: observe("notify"),
    receipt: (transition) => {
      observe("receipt")(transition);
      return Promise.resolve();
    },
    reconcile: (transition) => {
      observe("reconcile")(transition);
      return Promise.resolve();
    },
    store: {
      clear: () => {
        order.push("clear");
        return Promise.resolve();
      },
      clearIfCurrent: () => {
        order.push("clear");
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: () => {
        order.push("write");
        return Promise.reject(new Error("quota exceeded"));
      },
      read: () => {
        order.push("verify-clear");
        return Promise.resolve({ status: "missing" });
      },
    },
  };

  await expect(
    executeGrantTransition(ports, {
      candidate,
      expectedRecord: previous,
      previous,
      transitionId: "transition-mixed",
    }),
  ).resolves.toEqual({
    diagnostics: [{ code: "grant-write-failed" }],
    outcome: "degraded",
    transition: {
      appliedChanges: [
        { from: "granted", purposeId: "analytics", to: "denied" },
      ],
      persistenceStatus: "failed-conservative",
      record: {
        ...candidate,
        decisions: { ads: "denied", analytics: "denied" },
        method: "reject-all",
      },
      transitionId: "transition-mixed",
      withheldPurposeIds: ["ads"],
    },
  });
  expect(order).toEqual([
    "write",
    "clear",
    "commit",
    "signal",
    "reconcile",
    "receipt",
    "notify",
  ]);
  expect(observedTransitions).toHaveLength(5);
  expect(new Set(observedTransitions).size).toBe(1);
});
