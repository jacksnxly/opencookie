import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import { describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  mount: undefined as (() => (() => void) | undefined) | undefined,
}));

vi.mock("svelte", () => {
  let currentContext: unknown;

  return {
    createContext: <Context>() =>
      [
        (): Context => {
          if (currentContext === undefined) {
            throw new Error("Context has not been set.");
          }
          return currentContext as Context;
        },
        (context: Context): Context => {
          currentContext = context;
          return context;
        },
      ] as const,
    onMount: (mount: () => (() => void) | undefined): void => {
      lifecycle.mount = mount;
    },
  };
});

import { setOpenCookieContext } from "./index.js";

interface TestSnapshot {
  readonly state: string;
}

describe("Svelte external-store lifecycle", () => {
  it("subscribes after mount, publishes the latest snapshot, and cleans up once", () => {
    const events: string[] = [];
    const unsubscribe = vi.fn(() => {
      events.push("unsubscribe");
    });
    let clientSnapshot: TestSnapshot = { state: "client" };
    let notify: (() => void) | undefined;
    const store: OpenCookieExternalStore<TestSnapshot> = {
      getServerSnapshot: vi.fn(() => ({ state: "server" })),
      getSnapshot: vi.fn(() => {
        events.push(`get:${clientSnapshot.state}`);
        return clientSnapshot;
      }),
      subscribe: vi.fn((listener: () => void) => {
        events.push("subscribe");
        notify = listener;
        return unsubscribe;
      }),
    };

    const binding = setOpenCookieContext(store);
    const observed: string[] = [];
    const stopObserving = binding.snapshot.subscribe((snapshot) => {
      observed.push(snapshot.state);
    });

    expect(binding.store).toBe(store);
    expect(observed).toEqual(["server"]);
    expect(store.subscribe).not.toHaveBeenCalled();

    const cleanup = lifecycle.mount?.();
    expect(cleanup).toBeTypeOf("function");
    expect(events).toEqual(["subscribe", "get:client"]);
    expect(observed).toEqual(["server", "client"]);

    clientSnapshot = { state: "updated" };
    notify?.();
    expect(observed).toEqual(["server", "client", "updated"]);

    if (typeof cleanup !== "function") {
      throw new Error("Expected a lifecycle cleanup function.");
    }
    cleanup();
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();

    const clientReads = vi.mocked(store.getSnapshot).mock.calls.length;
    clientSnapshot = { state: "after-cleanup" };
    notify?.();
    expect(vi.mocked(store.getSnapshot)).toHaveBeenCalledTimes(clientReads);
    expect(observed).toEqual(["server", "client", "updated"]);

    stopObserving();
  });
});
