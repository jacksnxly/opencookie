import { expect, it } from "vitest";

import type { PersistedConsentState } from "../application/runtime/initialize-consent.js";
import { createUnavailableDecisionStore } from "./unavailable-decision-store.js";

const state = {
  record: {
    catalogueDigest: "sha256-v1:test",
    decidedAt: 1_000,
    decisionSurfaceDigest: "sha256-v1:test",
    decisions: { analytics: "granted" },
    expiresAt: 61_000,
    method: "accept-all",
    policyVersion: "policy-1",
    recordId: "record-1",
    revision: 1,
  },
} as unknown as PersistedConsentState;

it("reports missing durable state on every read", async () => {
  await expect(createUnavailableDecisionStore().read()).resolves.toEqual({
    status: "missing",
  });
});

it("cannot confirm any write readback", async () => {
  await expect(
    createUnavailableDecisionStore().compareAndSet(null, state),
  ).resolves.toEqual({ status: "readback-mismatch" });
  await expect(
    createUnavailableDecisionStore().compareAndSet(state, state),
  ).resolves.toEqual({ status: "readback-mismatch" });
});

it("confirms clears because nothing can be durably stored", async () => {
  const store = createUnavailableDecisionStore();
  await expect(store.clearIfCurrent(state)).resolves.toBe("cleared");
  await expect(store.clear()).resolves.toBeUndefined();
});

it("returns a frozen store", () => {
  expect(Object.isFrozen(createUnavailableDecisionStore())).toBe(true);
});
