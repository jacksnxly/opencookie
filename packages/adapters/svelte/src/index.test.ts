import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import type { Component } from "svelte";
import { render } from "svelte/server";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { getOpenCookieContext, setOpenCookieContext } from "./index.js";

interface TestSnapshot {
  readonly state: "client" | "server";
}

function externalStore(
  serverState: TestSnapshot["state"] = "server",
): OpenCookieExternalStore<TestSnapshot> & {
  readonly getServerSnapshot: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly subscribe: ReturnType<typeof vi.fn>;
} {
  return {
    getServerSnapshot: vi.fn(() => ({ state: serverState })),
    getSnapshot: vi.fn(() => ({ state: "client" as const })),
    subscribe: vi.fn(() => () => undefined),
  };
}

function renderProvider(
  store: OpenCookieExternalStore<TestSnapshot>,
  consume: () => void,
): string {
  const Consumer: Component = () => {
    consume();
    return {};
  };
  const Provider: Component = (internals, props) => {
    setOpenCookieContext(store);
    return Consumer(internals, props);
  };

  return render(Provider).body;
}

describe("Svelte external-store context", () => {
  it("uses the server snapshot during SSR without touching the client store", () => {
    const store = externalStore();
    let observed: TestSnapshot | undefined;

    renderProvider(store, () => {
      const binding = getOpenCookieContext<TestSnapshot>();
      observed = get(binding.snapshot);
      expect(binding.framework).toBe("svelte");
      expect(binding.store).toBe(store);
    });

    expect(observed).toEqual({ state: "server" });
    expect(store.getServerSnapshot).toHaveBeenCalledOnce();
    expect(store.getSnapshot).not.toHaveBeenCalled();
    expect(store.subscribe).not.toHaveBeenCalled();
  });

  it("isolates bindings between independent server render trees", () => {
    const states: TestSnapshot["state"][] = [];

    for (const state of ["server", "client"] as const) {
      renderProvider(externalStore(state), () => {
        states.push(get(getOpenCookieContext<TestSnapshot>().snapshot).state);
      });
    }

    expect(states).toEqual(["server", "client"]);
  });

  it("fails clearly when consumed outside an OpenCookie provider", () => {
    const Consumer: Component = () => {
      getOpenCookieContext<TestSnapshot>();
      return {};
    };

    expect(() => render(Consumer).body).toThrow(/setOpenCookieContext/);
  });
});
