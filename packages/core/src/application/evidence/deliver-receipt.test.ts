import { describe, expect, it } from "vitest";

import {
  createInMemoryReceiptOutbox,
  deliverConsentReceipt,
  flushConsentReceiptOutbox,
} from "../../application.js";
import { projectConsentReceipt, type ConsentReceipt } from "../../domain.js";

function receipt(transitionId: string, revision: number): ConsentReceipt {
  return projectConsentReceipt({
    catalogueDigest: "catalogue-1",
    decidedAt: 1_782_600_000_000 + revision,
    decisionSurfaceDigest: "surface-1",
    decisions: { analytics: "denied" },
    method: "reject-all",
    occurredAt: 1_782_600_000_000 + revision,
    persistenceStatus: "confirmed",
    policyVersion: "policy-1",
    revision,
    transitionId,
  });
}

describe("consent receipt delivery", () => {
  it("defers a failed rejection receipt without changing the receipt", async () => {
    const outbox = createInMemoryReceiptOutbox({ capacity: 3 });
    const value = receipt("transition-1", 1);
    const before = JSON.stringify(value);

    await expect(
      deliverConsentReceipt(
        value,
        { send: () => Promise.reject(new Error("offline")) },
        outbox,
      ),
    ).resolves.toEqual({ outcome: "delivery-deferred" });

    expect(outbox.snapshot()).toEqual([value]);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("keeps a bounded deduplicated FIFO and retries in order", async () => {
    const outbox = createInMemoryReceiptOutbox({ capacity: 2 });
    const first = receipt("transition-1", 1);
    const second = receipt("transition-2", 2);
    const third = receipt("transition-3", 3);

    expect(outbox.enqueue(first)).toBe("queued");
    expect(outbox.enqueue(first)).toBe("duplicate");
    expect(outbox.enqueue(second)).toBe("queued");
    expect(outbox.enqueue(third)).toBe("full");
    expect(outbox.snapshot()).toEqual([first, second]);

    const attempted: string[] = [];
    await expect(
      flushConsentReceiptOutbox(outbox, {
        send: (value) => {
          attempted.push(value.transitionId);
          return value.transitionId === "transition-2"
            ? Promise.reject(new Error("still offline"))
            : Promise.resolve();
        },
      }),
    ).resolves.toEqual({ deliveredCount: 1, outcome: "delivery-deferred" });
    expect(attempted).toEqual(["transition-1", "transition-2"]);
    expect(outbox.snapshot()).toEqual([second]);

    await expect(
      flushConsentReceiptOutbox(outbox, {
        send: () => Promise.resolve(),
      }),
    ).resolves.toEqual({ deliveredCount: 1, outcome: "delivered" });
    expect(outbox.snapshot()).toEqual([]);
  });

  it("treats an absent sink as a valid local-only configuration", async () => {
    const outbox = createInMemoryReceiptOutbox({ capacity: 1 });

    await expect(
      deliverConsentReceipt(receipt("transition-1", 1), undefined, outbox),
    ).resolves.toEqual({ outcome: "delivery-not-configured" });
    expect(outbox.snapshot()).toEqual([]);
  });
});
