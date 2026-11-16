import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, defineComponent, h } from "vue";
import { describe, expect, it, vi } from "vitest";

import {
  createOpenCookiePlugin,
  useOpenCookieSnapshot,
  useOpenCookieStore,
} from "./index.js";

interface TestSnapshot {
  readonly state: "client" | "server";
}

function externalStore(): OpenCookieExternalStore<TestSnapshot> & {
  readonly subscribe: ReturnType<typeof vi.fn>;
} {
  return {
    getServerSnapshot: () => ({ state: "server" }),
    getSnapshot: () => ({ state: "client" }),
    subscribe: vi.fn(() => () => undefined),
  };
}

describe("Vue external-store binding", () => {
  it("uses the server snapshot during SSR without subscribing", async () => {
    const store = externalStore();
    const Consumer = defineComponent({
      setup() {
        const snapshot = useOpenCookieSnapshot<TestSnapshot>();
        return () => h("output", snapshot.value.state);
      },
    });
    const app = createSSRApp(Consumer);
    app.use(createOpenCookiePlugin(store));

    await expect(renderToString(app)).resolves.toBe("<output>server</output>");
    expect(store.subscribe).not.toHaveBeenCalled();
  });

  it("provides the same typed store to descendants", async () => {
    const store = externalStore();
    const Consumer = defineComponent({
      setup() {
        const provided = useOpenCookieStore<TestSnapshot>();
        return () => h("output", provided === store ? "same" : "different");
      },
    });
    const app = createSSRApp(Consumer);
    app.use(createOpenCookiePlugin(store));

    await expect(renderToString(app)).resolves.toBe("<output>same</output>");
  });

  it("fails clearly when a composable is used without the plugin", async () => {
    const Consumer = defineComponent({
      setup() {
        useOpenCookieSnapshot<TestSnapshot>();
        return () => null;
      },
    });

    await expect(renderToString(createSSRApp(Consumer))).rejects.toThrow(
      /OpenCookie plugin/,
    );
  });
});
