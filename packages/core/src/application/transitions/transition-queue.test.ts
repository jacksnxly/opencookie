import { expect, it } from "vitest";

import { createTransitionQueue } from "../../application.js";

function nextMicrotask(): Promise<void> {
  return new Promise((resolve) => {
    queueMicrotask(resolve);
  });
}

it("queues a subscriber-triggered command without interleaving", async () => {
  const order: string[] = [];
  const queue = createTransitionQueue<string>();
  let releaseGrant: () => void = () => undefined;
  let withdrawal: Promise<void> | undefined;

  queue.subscribe((event) => {
    order.push(`listener:${event}`);
    withdrawal = queue.enqueue(() => {
      order.push("withdrawal");
      return Promise.resolve();
    });
  });

  const grant = queue.enqueue(async () => {
    order.push("grant:start");
    queue.publish("granted");
    await new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    order.push("grant:end");
  });

  await nextMicrotask();
  expect(order).toEqual(["grant:start", "listener:granted"]);

  releaseGrant();
  await grant;
  await withdrawal;
  expect(order).toEqual([
    "grant:start",
    "listener:granted",
    "grant:end",
    "withdrawal",
  ]);
});

it("isolates synchronous and asynchronous listener errors", async () => {
  const errors: unknown[] = [];
  const observed: string[] = [];
  const queue = createTransitionQueue<string>({
    onListenerError: (error) => errors.push(error),
  });

  queue.subscribe(() => {
    throw new Error("sync listener");
  });
  queue.subscribe(() => Promise.reject(new Error("async listener")));
  queue.subscribe((event) => {
    observed.push(event);
  });

  queue.publish("ready");
  await nextMicrotask();
  await nextMicrotask();

  expect(observed).toEqual(["ready"]);
  expect(errors.map((error) => String(error))).toEqual([
    "Error: sync listener",
    "Error: async listener",
  ]);
});
