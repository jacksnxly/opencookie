import { expect, it } from "vitest";

import { resetConsentForTesting } from "../../application.js";

// @covers PP-19 REQ-HEADLESS-API: reset-for-testing clears state without faking a visitor decision.
it("clears configured local state without a visitor event or receipt", async () => {
  const cleared: string[] = [];
  const visitorEvents: unknown[] = [];
  const receipts: unknown[] = [];

  await expect(
    resetConsentForTesting([
      {
        clear: () => {
          cleared.push("decision-store");
          return Promise.resolve();
        },
        id: "decision-store",
      },
      {
        clear: () => {
          cleared.push("service-preferences");
          return Promise.resolve();
        },
        id: "service-preferences",
      },
      {
        clear: () => {
          cleared.push("receipt-outbox");
          return Promise.resolve();
        },
        id: "receipt-outbox",
      },
    ]),
  ).resolves.toEqual({
    clearedIds: ["decision-store", "service-preferences", "receipt-outbox"],
    outcome: "cleared",
  });

  expect(cleared).toEqual([
    "decision-store",
    "service-preferences",
    "receipt-outbox",
  ]);
  expect(visitorEvents).toEqual([]);
  expect(receipts).toEqual([]);
});
