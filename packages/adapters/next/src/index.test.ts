import { readFileSync } from "node:fs";

import {
  OpenCookieProvider as ReactOpenCookieProvider,
  useOpenCookieSelector as useReactOpenCookieSelector,
  useOpenCookieSnapshot as useReactOpenCookieSnapshot,
  useOpenCookieStore as useReactOpenCookieStore,
} from "@opencookie-dev/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  OpenCookieProvider,
  useOpenCookieSelector,
  useOpenCookieSnapshot,
  useOpenCookieStore,
} from "./index.js";

interface TestSnapshot {
  readonly state: "client" | "server";
}

describe("Next.js React binding", () => {
  it("declares the package entry point as a Client Component boundary", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source.startsWith('"use client";')).toBe(true);
  });

  it("delegates the provider and hooks to the React adapter", () => {
    expect(OpenCookieProvider).toBe(ReactOpenCookieProvider);
    expect(useOpenCookieSelector).toBe(useReactOpenCookieSelector);
    expect(useOpenCookieSnapshot).toBe(useReactOpenCookieSnapshot);
    expect(useOpenCookieStore).toBe(useReactOpenCookieStore);
  });

  it("uses the core server snapshot during SSR without subscribing", () => {
    const subscribe = vi.fn(() => () => undefined);
    const store = {
      getServerSnapshot: vi.fn(() => ({ state: "server" as const })),
      getSnapshot: vi.fn(() => ({ state: "client" as const })),
      subscribe,
    };

    function Consumer() {
      const snapshot = useOpenCookieSnapshot<TestSnapshot>();
      return createElement("output", null, snapshot.state);
    }

    const markup = renderToStaticMarkup(
      createElement(OpenCookieProvider, { store }, createElement(Consumer)),
    );

    expect(markup).toBe("<output>server</output>");
    expect(store.getServerSnapshot).toHaveBeenCalled();
    expect(store.getSnapshot).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
