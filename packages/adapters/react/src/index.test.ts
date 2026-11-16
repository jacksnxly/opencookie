import type { OpenCookieExternalStore } from "@opencookie-dev/core";
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

function externalStore(): OpenCookieExternalStore<TestSnapshot> & {
  readonly subscribe: ReturnType<typeof vi.fn>;
} {
  const subscribe = vi.fn(() => () => undefined);
  return {
    getServerSnapshot: () => ({ state: "server" as const }),
    getSnapshot: () => ({ state: "client" as const }),
    subscribe,
  };
}

describe("React external-store binding", () => {
  it("uses the server snapshot during SSR without subscribing", () => {
    const store = externalStore();
    type Snapshot = ReturnType<typeof store.getSnapshot>;

    function Consumer() {
      const snapshot = useOpenCookieSnapshot<Snapshot>();
      return createElement("output", null, snapshot.state);
    }

    const markup = renderToStaticMarkup(
      createElement(OpenCookieProvider, { store }, createElement(Consumer)),
    );

    expect(markup).toBe("<output>server</output>");
    expect(store.subscribe).not.toHaveBeenCalled();
  });

  it("exposes typed store and selector hooks through one provider", () => {
    const store = externalStore();
    type Snapshot = ReturnType<typeof store.getSnapshot>;

    function Consumer() {
      const provided = useOpenCookieStore<Snapshot>();
      const selected = useOpenCookieSelector<Snapshot, string>((snapshot) =>
        snapshot.state.toUpperCase(),
      );
      return createElement(
        "output",
        null,
        `${provided === store ? "same" : "different"}:${selected}`,
      );
    }

    expect(
      renderToStaticMarkup(
        createElement(OpenCookieProvider, { store }, createElement(Consumer)),
      ),
    ).toBe("<output>same:SERVER</output>");
  });

  it("fails clearly when a hook is used outside its provider", () => {
    function Consumer() {
      useOpenCookieSnapshot<
        ReturnType<ReturnType<typeof externalStore>["getSnapshot"]>
      >();
      return null;
    }

    expect(() => renderToStaticMarkup(createElement(Consumer))).toThrow(
      /OpenCookieProvider/,
    );
  });
});
