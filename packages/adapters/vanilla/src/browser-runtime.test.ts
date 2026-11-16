import { existsSync, readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { startAutoBootstrap } from "./auto-bootstrap.js";
import {
  bootstrapOpenCookie,
  type BootstrappedOpenCookie,
} from "./bootstrap.js";

function idGenerator(): (kind: "record" | "transition") => string {
  let sequence = 0;
  return (kind) => `${kind}-${String(++sequence)}`;
}

async function settleDom(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function startBrowserRuntime(
  kind: "auto" | "generic",
  window: Window,
  document: Document,
  script: HTMLScriptElement,
  googleCalls: unknown[][],
): BootstrappedOpenCookie {
  const runtime = {
    idGenerator: idGenerator(),
    now: () => 1_700_000_000_000,
    storage: window.localStorage,
  };
  if (kind === "auto") {
    Object.assign(window, {
      gtag: (...call: unknown[]) => googleCalls.push(call),
    });
    script.dataset["ocGoogleAnalyticsResource"] = "analytics-script";
    script.dataset["ocGoogleConsentMode"] = "basic";
    return startAutoBootstrap(document, script, runtime);
  }
  return bootstrapOpenCookie({
    ...runtime,
    document,
    googleConsentMode: {
      command: (...call) => googleCalls.push(call),
      mapping: { analyticsStorageResourceIds: ["analytics-script"] },
      mode: "basic",
    },
  });
}

describe("shared vanilla browser orchestration", () => {
  it("keeps one core-agnostic lifecycle owner behind generic and auto composition", () => {
    const runtimeUrl = new URL("./browser-runtime.ts", import.meta.url);

    expect(existsSync(runtimeUrl)).toBe(true);
    if (!existsSync(runtimeUrl)) return;

    const runtimeSource = readFileSync(runtimeUrl, "utf8");
    const genericSource = readFileSync(
      new URL("./bootstrap.ts", import.meta.url),
      "utf8",
    );
    const autoSource = readFileSync(
      new URL("./auto-bootstrap.ts", import.meta.url),
      "utf8",
    );
    const compositionSource = readFileSync(
      new URL("./product-composition.ts", import.meta.url),
      "utf8",
    );

    expect(genericSource).toContain('from "./browser-runtime.js"');
    expect(genericSource).toMatch(/createVanillaBrowserRuntime\(/u);
    expect(genericSource).toMatch(/prepareVanillaBrowserRuntime\(/u);
    expect(genericSource).toContain('from "./product-composition.js"');
    expect(autoSource).toContain('from "./browser-runtime.js"');
    expect(autoSource).toMatch(/createVanillaBrowserRuntime\(/u);
    expect(autoSource).toContain('from "@opencookie-dev/core/auto"');
    expect(autoSource).toContain('from "./product-composition.js"');
    expect(autoSource).not.toContain('"./bootstrap.js"');
    expect(autoSource).not.toContain("prepareVanillaBrowserRuntime");
    expect(autoSource).not.toContain("@opencookie-dev/core/infrastructure");
    expect(autoSource).not.toContain("@opencookie-dev/core/domain");
    expect(autoSource).not.toMatch(/from "@opencookie-dev\/core";/u);
    expect(autoSource).not.toContain("resolveGpcSignal");
    expect(autoSource).not.toContain("resolveGpcRestrictions");
    expect(autoSource).not.toContain("createCookieDecisionStore");
    expect(compositionSource).not.toContain("@opencookie-dev/core");
    expect(runtimeSource).not.toContain("@opencookie-dev/core");
    expect(runtimeSource).not.toContain('from "./bootstrap.js"');
    expect(runtimeSource).not.toContain("definePolicy");
    expect(runtimeSource).not.toContain("defineResourcePolicy");
    expect(runtimeSource).not.toContain("createLocalStorageDecisionStore");
    expect(runtimeSource).not.toContain("createOpenCookie");
    expect(runtimeSource).not.toContain("createPolicySnapshot");
    expect(runtimeSource).not.toContain("createAccessEnforcementReconciler");
    expect(runtimeSource).not.toContain("createGoogleConsentModeBroadcaster");
    expect(runtimeSource).toContain("prepareProduct");
    expect(genericSource).toContain("defineResourcePolicy");
    expect(genericSource).toContain("createLocalStorageDecisionStore");
    expect(genericSource).toContain("createOpenCookie");
    expect(genericSource).toContain("createPolicySnapshot");
    expect(genericSource).toContain("createAccessEnforcementReconciler");
    expect(genericSource).toContain("createGoogleConsentModeBroadcaster");
    expect(runtimeSource).toContain("createBlockedScriptController");
    expect(runtimeSource).toContain("createBlockedIframeController");
    expect(runtimeSource).toContain("mountOpenCookie");
    expect(runtimeSource).toContain("MutationObserver");
    expect(runtimeSource).toContain("reportError");
    expect(runtimeSource).toContain("resourceLifecycle.abort");
    expect(runtimeSource).toContain("mounted.destroy");
  });

  it.each(["generic", "auto"] as const)(
    "%s bootstrap owns discovery, presentation, observation, updates, and complete teardown",
    async (kind) => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      const mutationDisconnect = vi.spyOn(
        window.MutationObserver.prototype,
        "disconnect",
      );
      const lifecycleAbort = vi.spyOn(
        window.AbortController.prototype,
        "abort",
      );
      const first = document.createElement("script");
      first.type = "text/plain";
      first.dataset["ocCategory"] = "analytics";
      first.dataset["ocResource"] = "analytics-script";
      first.dataset["src"] = "https://tracker.example.test/first.js";
      const legacyFrame = document.createElement("iframe");
      legacyFrame.dataset["ocCategory"] = "analytics";
      legacyFrame.dataset["ocResource"] = "product-video";
      legacyFrame.dataset["src"] = "https://tracker.example.test/frame";
      const script = document.createElement("script");
      document.head.append(first, script);
      document.body.append(legacyFrame);
      const googleCalls: unknown[][] = [];
      const started = startBrowserRuntime(
        kind,
        window,
        document,
        script,
        googleCalls,
      );

      expect(googleCalls.map((call) => call[1])).toEqual(["default"]);
      await started.ready;
      expect(document.querySelector("[data-oc-root]")).not.toBeNull();
      expect(document.querySelector("style[data-opencookie]")).not.toBeNull();

      await started.client.acceptAll();
      expect(googleCalls.map((call) => call[1])).toEqual(["default", "update"]);
      expect(
        document.querySelectorAll("[data-oc-active-resource]"),
      ).toHaveLength(2);

      const second = document.createElement("script");
      second.type = "text/plain";
      second.dataset["ocCategory"] = "analytics";
      second.dataset["ocResource"] = "analytics-script";
      second.dataset["src"] = "https://tracker.example.test/second.js";
      document.head.append(second);
      await settleDom();
      expect(
        document.querySelectorAll("[data-oc-active-resource]"),
      ).toHaveLength(3);

      started.destroy();
      started.destroy();
      await settleDom();

      expect(mutationDisconnect).toHaveBeenCalledTimes(1);
      expect(lifecycleAbort).toHaveBeenCalledTimes(1);
      expect(document.querySelector("[data-oc-root]")).toBeNull();
      expect(document.querySelector("style[data-opencookie]")).toBeNull();
      expect(
        document.querySelectorAll("[data-oc-active-resource]"),
      ).toHaveLength(0);
      expect(legacyFrame.isConnected).toBe(true);
      expect(legacyFrame.hidden).toBe(false);

      started.client.openPreferences();
      const afterDestroy = document.createElement("script");
      afterDestroy.type = "text/plain";
      afterDestroy.dataset["ocCategory"] = "analytics";
      afterDestroy.dataset["ocResource"] = "analytics-script";
      afterDestroy.textContent = "globalThis.__afterDestroy = true";
      document.head.append(afterDestroy);
      const pageHide = new window.Event("pagehide");
      Object.defineProperty(pageHide, "persisted", { value: false });
      window.dispatchEvent(pageHide);
      await settleDom();

      expect(document.querySelector("[data-oc-root]")).toBeNull();
      expect(document.querySelector("style[data-opencookie]")).toBeNull();
      expect(
        document.querySelectorAll("[data-oc-active-resource]"),
      ).toHaveLength(0);
      expect(legacyFrame.isConnected).toBe(true);

      mutationDisconnect.mockRestore();
      lifecycleAbort.mockRestore();
      window.close();
    },
  );

  it("cleans an activation that fails after destruction starts", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const delayed = document.createElement("script");
    delayed.type = "text/plain";
    delayed.dataset["ocCategory"] = "analytics";
    delayed.dataset["ocResource"] = "a-delayed-script";
    delayed.textContent = "globalThis.__delayed = true";
    const failing = document.createElement("script");
    failing.type = "text/plain";
    failing.dataset["ocCategory"] = "analytics";
    failing.dataset["ocResource"] = "z-failing-script";
    failing.textContent = "globalThis.__failing = true";
    document.head.append(delayed, failing);

    const nativeQuerySelectorAll = Reflect.get(document, "querySelectorAll");
    if (typeof nativeQuerySelectorAll !== "function") {
      throw new TypeError("Document querySelectorAll is unavailable.");
    }
    const nativeInsertBefore = document.head.insertBefore.bind(document.head);
    let destroyDuringDiscovery = false;
    Reflect.set(document, "querySelectorAll", (selector: string): unknown => {
      if (destroyDuringDiscovery && selector === "script[data-oc-resource]") {
        destroyDuringDiscovery = false;
        started.destroy();
      }
      const result: unknown = Reflect.apply(nativeQuerySelectorAll, document, [
        selector,
      ]);
      return result;
    });
    document.head.insertBefore = ((node: Node, child: Node | null) => {
      if (
        (node as HTMLElement).dataset["ocActiveResource"] === "z-failing-script"
      ) {
        throw new Error("simulated controller failure");
      }
      return nativeInsertBefore(node, child);
    }) as typeof document.head.insertBefore;

    const started: BootstrappedOpenCookie = bootstrapOpenCookie({
      document,
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;
    destroyDuringDiscovery = true;

    await started.client.acceptAll();
    await settleDom();

    const activeResources = document.querySelectorAll(
      "[data-oc-active-resource]",
    ).length;
    for (const active of document.querySelectorAll(
      "[data-oc-active-resource]",
    )) {
      active.remove();
    }
    window.close();

    expect(activeResources).toBe(0);
  });

  it("keeps the auto module import safe without a browser document", async () => {
    expect(typeof globalThis.document).toBe("undefined");
    await expect(import("./auto.js")).resolves.toBeDefined();
  });
});
