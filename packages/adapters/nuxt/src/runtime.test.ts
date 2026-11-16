import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import {
  createOpenCookiePlugin as createVueOpenCookiePlugin,
  useOpenCookieSnapshot as useVueOpenCookieSnapshot,
  useOpenCookieStore as useVueOpenCookieStore,
} from "@opencookie-dev/vue";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, defineComponent, h, type App } from "vue";
import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookieNuxtPlugin,
  useOpenCookieSnapshot,
  useOpenCookieStore,
  type OpenCookieNuxtApp,
} from "./runtime.js";

interface TestSnapshot {
  readonly state: "client" | "server";
}

function externalStore() {
  return {
    getServerSnapshot: (): TestSnapshot => ({ state: "server" }),
    getSnapshot: (): TestSnapshot => ({ state: "client" }),
    initialize: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn(() => () => undefined),
  } satisfies OpenCookieExternalStore<TestSnapshot> & {
    readonly initialize: () => PromiseLike<unknown>;
  };
}

describe("OpenCookie Nuxt runtime plugin", () => {
  it("installs the Vue binding per SSR app without subscribing or initializing", async () => {
    const store = externalStore();
    const Consumer = defineComponent({
      setup() {
        const snapshot = useOpenCookieSnapshot<TestSnapshot>();
        return () => h("output", snapshot.value.state);
      },
    });
    const vueApp = createSSRApp(Consumer);
    const hook = vi.fn();
    const nuxtApp = { hook, vueApp } as unknown as OpenCookieNuxtApp;

    const result = createOpenCookieNuxtPlugin(() => store)(nuxtApp);

    await expect(renderToString(vueApp)).resolves.toBe(
      "<output>server</output>",
    );
    expect(result.provide.openCookie).toBe(store);
    expect(hook).not.toHaveBeenCalled();
    expect(store.initialize).not.toHaveBeenCalled();
    expect(store.subscribe).not.toHaveBeenCalled();
  });

  it("defers browser initialization until Nuxt has mounted", async () => {
    const store = externalStore();
    const callbacks: Array<() => Promise<void> | void> = [];
    const use = vi.fn();
    const vueApp = { use } as unknown as App;
    const nuxtApp = {
      hook: vi.fn((name: string, callback: () => Promise<void> | void) => {
        expect(name).toBe("app:mounted");
        callbacks.push(callback);
      }),
      vueApp,
    } as unknown as OpenCookieNuxtApp;
    vi.stubGlobal("window", {});

    try {
      const result = createOpenCookieNuxtPlugin(() => store)(nuxtApp);

      expect(result.provide.openCookie).toBe(store);
      expect(use).toHaveBeenCalledOnce();
      expect(store.initialize).not.toHaveBeenCalled();

      await callbacks[0]?.();
      expect(store.initialize).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("constructs a distinct store for each Nuxt application", () => {
    const stores = [externalStore(), externalStore()];
    const factory = vi
      .fn()
      .mockReturnValueOnce(stores[0])
      .mockReturnValueOnce(stores[1]);
    const plugin = createOpenCookieNuxtPlugin(factory);
    const createApp = (): OpenCookieNuxtApp => ({
      hook: vi.fn(),
      vueApp: { use: vi.fn() } as unknown as App,
    });

    expect(plugin(createApp()).provide.openCookie).toBe(stores[0]);
    expect(plugin(createApp()).provide.openCookie).toBe(stores[1]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("delegates Vue context and snapshot behavior to one binding", () => {
    expect(useOpenCookieSnapshot).toBe(useVueOpenCookieSnapshot);
    expect(useOpenCookieStore).toBe(useVueOpenCookieStore);
    expect(createVueOpenCookiePlugin).toBeTypeOf("function");
  });
});
