import type { ConsentReceipt } from "../../domain/consent-evidence/index.js";

/** @public */
export interface ConsentReceiptSink {
  readonly send: (receipt: ConsentReceipt) => Promise<void>;
}

/** @public */
export type ReceiptOutboxEnqueueResult = "duplicate" | "full" | "queued";

/** @public */
export interface ConsentReceiptOutbox {
  readonly enqueue: (receipt: ConsentReceipt) => ReceiptOutboxEnqueueResult;
  readonly peek: () => ConsentReceipt | undefined;
  readonly remove: (transitionId: string) => void;
  readonly snapshot: () => readonly ConsentReceipt[];
}

/** @public */
export interface InMemoryReceiptOutboxOptions {
  readonly capacity: number;
}

/** @public */
export type ReceiptDeliveryResult =
  | { readonly outcome: "delivered" }
  | { readonly outcome: "delivery-deferred" }
  | {
      readonly diagnostics: readonly [{ readonly code: "receipt-outbox-full" }];
      readonly outcome: "delivery-failed";
    }
  | { readonly outcome: "delivery-not-configured" };

/** @public */
export type ReceiptOutboxFlushResult =
  | {
      readonly deliveredCount: number;
      readonly outcome: "delivered";
    }
  | {
      readonly deliveredCount: number;
      readonly outcome: "delivery-deferred";
    };

/** @public */
export function createInMemoryReceiptOutbox(
  options: InMemoryReceiptOutboxOptions,
): ConsentReceiptOutbox {
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
    throw new RangeError("Receipt outbox capacity must be a positive integer.");
  }

  const items: ConsentReceipt[] = [];
  const transitionIds = new Set<string>();

  return Object.freeze({
    enqueue(receipt: ConsentReceipt): ReceiptOutboxEnqueueResult {
      if (transitionIds.has(receipt.transitionId)) return "duplicate";
      if (items.length >= options.capacity) return "full";

      items.push(receipt);
      transitionIds.add(receipt.transitionId);
      return "queued";
    },
    peek(): ConsentReceipt | undefined {
      return items[0];
    },
    remove(transitionId: string): void {
      const index = items.findIndex(
        (receipt) => receipt.transitionId === transitionId,
      );
      if (index < 0) return;

      items.splice(index, 1);
      transitionIds.delete(transitionId);
    },
    snapshot(): readonly ConsentReceipt[] {
      return Object.freeze([...items]);
    },
  });
}

/** @public */
export async function deliverConsentReceipt(
  receipt: ConsentReceipt,
  sink: ConsentReceiptSink | undefined,
  outbox: ConsentReceiptOutbox,
): Promise<ReceiptDeliveryResult> {
  if (!sink) return { outcome: "delivery-not-configured" };

  try {
    await sink.send(receipt);
    return { outcome: "delivered" };
  } catch {
    const queued = outbox.enqueue(receipt);
    return queued === "full"
      ? {
          diagnostics: [{ code: "receipt-outbox-full" }],
          outcome: "delivery-failed",
        }
      : { outcome: "delivery-deferred" };
  }
}

/** @public */
export async function flushConsentReceiptOutbox(
  outbox: ConsentReceiptOutbox,
  sink: ConsentReceiptSink,
): Promise<ReceiptOutboxFlushResult> {
  let deliveredCount = 0;
  let receipt = outbox.peek();

  while (receipt) {
    try {
      await sink.send(receipt);
    } catch {
      return { deliveredCount, outcome: "delivery-deferred" };
    }

    outbox.remove(receipt.transitionId);
    deliveredCount += 1;
    receipt = outbox.peek();
  }

  return { deliveredCount, outcome: "delivered" };
}
