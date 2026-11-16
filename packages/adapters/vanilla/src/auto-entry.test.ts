import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import {
  startAutoBootstrap,
  startAutoBootstrapInTurns,
} from "./auto-bootstrap.js";

function idGenerator(): (kind: "record" | "transition") => string {
  let sequence = 0;
  return (kind) => `${kind}-${String(++sequence)}`;
}

async function settleDom(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function valueImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const fromPattern =
    /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?from\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(fromPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  const sideEffectPattern = /(?:^|\n)\s*import\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(sideEffectPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function walkDropInGraph(): {
  readonly coreSpecifiers: readonly string[];
  readonly files: ReadonlySet<string>;
} {
  const coreSpecifiers = new Set<string>();
  const files = new Set<string>();
  const queue = [new URL("./auto.ts", import.meta.url).href];
  while (queue.length > 0) {
    const moduleUrl = queue.pop();
    if (moduleUrl === undefined || files.has(moduleUrl)) continue;
    files.add(moduleUrl);
    const source = readFileSync(new URL(moduleUrl), "utf8");
    for (const specifier of valueImportSpecifiers(source)) {
      if (specifier.startsWith("@opencookie-dev/")) {
        coreSpecifiers.add(specifier);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      queue.push(new URL(specifier.replace(/\.js$/u, ".ts"), moduleUrl).href);
    }
  }
  return { coreSpecifiers: [...coreSpecifiers].sort(), files };
}

describe("the drop-in auto entry", () => {
  it("rejects a hidden purpose identifier before drop-in effects", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const script = document.createElement("script");
    script.dataset["ocPurposeId"] = "ana\u200Blytics";
    let started: ReturnType<typeof startAutoBootstrap> | undefined;
    let thrown: unknown;
    let returned = false;

    try {
      started = startAutoBootstrap(document, script, {
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
        storage: window.localStorage,
      });
      returned = true;
      await started.ready;
    } catch (error) {
      thrown = error;
    }

    const effects = {
      root: document.querySelector("[data-oc-root]") !== null,
      style: document.querySelector("style[data-opencookie]") !== null,
    };
    started?.destroy();
    window.close();

    expect({ effects, returned }).toEqual({
      effects: { root: false, style: false },
      returned: false,
    });
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toHaveProperty("message", "Invalid auto policy definition.");
  });

  it("keeps exactly one runtime core specifier in the drop-in graph", () => {
    const { coreSpecifiers, files } = walkDropInGraph();

    expect(coreSpecifiers).toEqual(["@opencookie-dev/core/auto"]);
    expect(
      [...files].some((file) => file.endsWith("/bootstrap.ts")),
      "the drop-in graph must not include the generic bootstrap",
    ).toBe(false);
    expect(
      [...files].some((file) => file.endsWith("/index.ts")),
      "the drop-in graph must not include the programmatic barrel",
    ).toBe(false);
  });

  it("defines a truthy OpenCookie global with exactly zero own keys", async () => {
    await import("./auto.js");

    const globalValue = (globalThis as { OpenCookie?: unknown }).OpenCookie;
    expect(globalValue).toBeTruthy();
    expect(typeof globalValue).toBe("object");
    expect(Reflect.ownKeys(globalValue as object)).toEqual([]);
    expect(Object.isFrozen(globalValue)).toBe(true);
    for (const legacyMethod of [
      "bootstrapOpenCookie",
      "mountOpenCookie",
      "createBlockedScriptController",
      "createBlockedIframeController",
    ]) {
      expect(
        (globalValue as Record<string, unknown>)[legacyMethod],
        `the side-effect-only IIFE must not expose ${legacyMethod}`,
      ).toBeUndefined();
    }
  });

  // The plain-HTML route must reach the German experience too: an attribute
  // chooses it, and anything but a supported language is refused.
  it("speaks German when the script asks for it", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const script = document.createElement("script");
    script.dataset["ocLocale"] = "de";
    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;

    expect(document.querySelector(".oc-bar")?.textContent).toContain(
      "Alle ablehnen",
    );
    expect(document.querySelector("[data-oc-root]")?.getAttribute("lang")).toBe(
      "de",
    );
    started.destroy();

    const unsupported = document.createElement("script");
    unsupported.dataset["ocLocale"] = "fr";
    expect(() =>
      startAutoBootstrap(document, unsupported, {
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
        storage: window.localStorage,
      }),
    ).toThrow(/data-oc-locale/u);
    window.close();
  });

  // One mistaken declaration must not take away every visitor's choice. The
  // valid resources still mount and obey the decision; a refused one stays
  // blocked, including every element that shares its identifier.
  it("mounts around a bad declaration and keeps it blocked", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const declare = (resourceId: string, category: string, src: string) => {
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = category;
      resource.dataset["ocResource"] = resourceId;
      resource.dataset["src"] = src;
      document.head.append(resource);
    };
    declare(
      "analytics-script",
      "analytics",
      "https://tracker.example.test/ok.js",
    );
    declare("ads-script", "marketing", "https://tracker.example.test/ads.js");
    declare("Upper-Script", "analytics", "https://tracker.example.test/up.js");
    declare("shared-script", "analytics", "https://tracker.example.test/a.js");
    declare("shared-script", "marketing", "https://tracker.example.test/m.js");
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const started = startAutoBootstrap(
      document,
      document.createElement("script"),
      {
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
        storage: window.localStorage,
      },
    );
    await started.ready;
    expect(document.querySelector(".oc-bar")).not.toBeNull();
    await started.client.acceptAll();
    await settleDom();

    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);
    for (const refused of ["ads-script", "Upper-Script", "shared-script"]) {
      expect(
        document.querySelector(`[data-oc-active-resource="${refused}"]`),
      ).toBeNull();
    }
    expect(reported).toHaveBeenCalledTimes(3);

    reported.mockRestore();
    started.destroy();
    window.close();
  });

  // A second copy of the drop-in on the same page would mount a second bar
  // with duplicate ids, and a decision in one copy would go stale in the other.
  it("starts once when the drop-in is loaded twice", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const options = {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    };
    const first = startAutoBootstrap(
      document,
      document.createElement("script"),
      options,
    );
    await first.ready;

    expect(() =>
      startAutoBootstrap(document, document.createElement("script"), options),
    ).toThrow(/already running/u);
    expect(document.querySelectorAll("[data-oc-root]")).toHaveLength(1);

    first.destroy();
    window.close();
  });

  // The drop-in presents a task after it starts, so a second copy that runs in
  // between must still find the first one rather than an empty page.
  it("starts once when a second copy runs before the first presents", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const options = {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    };
    const first = startAutoBootstrap(
      document,
      document.createElement("script"),
      options,
    );

    expect(() =>
      startAutoBootstrap(document, document.createElement("script"), options),
    ).toThrow(/already running/u);
    await first.ready;
    expect(document.querySelectorAll("[data-oc-root]")).toHaveLength(1);
    expect(document.querySelectorAll(".oc-bar")).toHaveLength(1);

    await first.destroyAndWait();
    const again = startAutoBootstrap(
      document,
      document.createElement("script"),
      options,
    );
    await again.ready;
    expect(document.querySelectorAll("[data-oc-root]")).toHaveLength(1);
    again.destroy();
    window.close();
  });

  it.each(["close control", "Escape key"])(
    "dismisses the first-visit bar with its %s without deciding anything",
    async (how) => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = "analytics";
      resource.dataset["ocResource"] = "analytics-script";
      resource.dataset["src"] = "https://tracker.example.test/first.js";
      document.head.append(resource);
      const started = startAutoBootstrap(
        document,
        document.createElement("script"),
        {
          idGenerator: idGenerator(),
          now: () => 1_700_000_000_000,
          storage: window.localStorage,
        },
      );
      await started.ready;
      const bar = document.querySelector<HTMLElement>(".oc-bar");
      expect(bar).not.toBeNull();

      if (how === "close control") {
        document
          .querySelector<HTMLButtonElement>(
            '.oc-bar [data-oc-action="dismiss"]',
          )
          ?.click();
      } else {
        bar
          ?.querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
          ?.dispatchEvent(
            new window.KeyboardEvent("keydown", {
              bubbles: true,
              key: "Escape",
            }) as unknown as Event,
          );
      }
      await settleDom();

      const launcher = document.querySelector<HTMLButtonElement>(
        '[data-oc-action="open"]',
      );
      expect(document.querySelector(".oc-bar")).toBeNull();
      expect(launcher).not.toBeNull();
      expect(document.activeElement).toBe(launcher);
      expect(started.client.getSnapshot().record).toBeUndefined();
      expect(window.localStorage.length).toBe(0);
      expect(
        document.querySelectorAll("[data-oc-active-resource]"),
      ).toHaveLength(0);

      started.destroy();
      window.close();
    },
  );

  // WCAG 2.4.11: a fixed bar must not hide the control that has focus. While
  // the bar shows, the page scrolls focus clear of it and has room to do so
  // at its end; the page's own settings come back when the bar goes.
  it.each(["a decision", "closing the bar", "destroying the runtime"])(
    "keeps focus clear of the bar and restores the page after %s",
    async (ending) => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      document.documentElement.style.scrollPaddingBottom = "10px";
      document.body.append(document.createElement("main"));
      const started = startAutoBootstrap(
        document,
        document.createElement("script"),
        {
          idGenerator: idGenerator(),
          now: () => 1_700_000_000_000,
          storage: window.localStorage,
        },
      );
      await started.ready;

      const reserve = document.body.lastElementChild as HTMLElement | null;
      expect(document.documentElement.style.scrollPaddingBottom).not.toBe(
        "10px",
      );
      expect(reserve?.hasAttribute("data-oc-reserve")).toBe(true);
      expect(reserve?.getAttribute("aria-hidden")).toBe("true");

      if (ending === "a decision") {
        await started.client.rejectAll();
        await settleDom();
      } else if (ending === "closing the bar") {
        document
          .querySelector<HTMLButtonElement>('[data-oc-action="dismiss"]')
          ?.click();
        await settleDom();
      } else {
        await started.destroyAndWait();
      }

      expect(document.documentElement.style.scrollPaddingBottom).toBe("10px");
      expect(document.querySelector("[data-oc-reserve]")).toBeNull();
      if (ending !== "destroying the runtime") started.destroy();
      window.close();
    },
  );

  // A decision made in another tab must reach this one: its optional resources
  // would otherwise keep running after a withdrawal there. The page reloads,
  // which re-reads the stored decision. The tab's own decisions reload it only
  // when they turn off a script it ran (withdrawal-teardown.test.ts).
  describe("a decision changed in another tab", () => {
    const activeResource = (document: Document) => {
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = "analytics";
      resource.dataset["ocResource"] = "analytics-script";
      resource.dataset["src"] = "https://tracker.example.test/first.js";
      document.head.append(resource);
    };

    it("reloads when another tab rewrites the stored decision", async () => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      activeResource(document);
      const reloads: string[] = [];
      const started = startAutoBootstrap(
        document,
        document.createElement("script"),
        {
          idGenerator: idGenerator(),
          now: () => 1_700_000_000_000,
          reload: () => reloads.push("reload"),
          storage: window.localStorage,
        },
      );
      await started.ready;
      await started.client.acceptAll();
      await settleDom();
      window.localStorage.setItem("unrelated", "x");
      window.dispatchEvent(
        new window.StorageEvent("storage", {
          key: "unrelated",
          newValue: "x",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(reloads).toEqual([]);

      window.localStorage.setItem("opencookie.consent", "written elsewhere");
      window.dispatchEvent(
        new window.StorageEvent("storage", {
          key: "opencookie.consent",
          newValue: "written elsewhere",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(reloads).toEqual(["reload"]);
      started.destroy();
      window.close();
    });

    it("reloads through the default storage without unlocking its writes", async () => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      activeResource(document);
      const reloads: string[] = [];
      const started = startAutoBootstrap(
        document,
        document.createElement("script"),
        {
          idGenerator: idGenerator(),
          now: () => 1_700_000_000_000,
          reload: () => reloads.push("reload"),
        },
      );
      await started.ready;
      await started.client.acceptAll();
      await settleDom();
      expect(reloads).toEqual([]);

      window.localStorage.setItem("opencookie.consent", "written elsewhere");
      window.dispatchEvent(
        new window.StorageEvent("storage", {
          key: "opencookie.consent",
          newValue: "written elsewhere",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(reloads).toEqual(["reload"]);
      started.destroy();
      window.close();
    });

    it("reloads when the page returns to view and the stored cookie changed", async () => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      activeResource(document);
      let jar = "";
      const script = document.createElement("script");
      script.dataset["ocStorage"] = "cookie";
      const reloads: string[] = [];
      const started = startAutoBootstrap(document, script, {
        cookieJar: {
          read: () => jar,
          write: (serialized) => {
            const [pair = ""] = serialized.split(";");
            const [name = ""] = pair.split("=");
            const others = jar
              .split("; ")
              .filter((entry) => entry !== "" && !entry.startsWith(`${name}=`));
            jar = [...others, ...(pair.endsWith("=") ? [] : [pair])].join("; ");
          },
        },
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
        reload: () => reloads.push("reload"),
      });
      await started.ready;
      await started.client.acceptAll();
      await settleDom();
      document.dispatchEvent(
        new window.Event("visibilitychange") as unknown as Event,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(reloads).toEqual([]);

      // Change the value of the cookie the store actually wrote.
      const written = /(?:^|; )([^=;]+)=/u.exec(jar)?.[1];
      expect(written).toBeDefined();
      jar = jar.replace(
        /(^|; )[^=;]+=[^;]*/u,
        `$1${String(written)}=written-elsewhere`,
      );
      document.dispatchEvent(
        new window.Event("visibilitychange") as unknown as Event,
      );

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(reloads).toEqual(["reload"]);
      started.destroy();
      window.close();
    });
  });

  it("shows a stored grant that a privacy signal restricts as blocked, not granted", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const runtime = {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    };
    const granting = startAutoBootstrap(
      document,
      document.createElement("script"),
      runtime,
    );
    await granting.ready;
    await granting.client.acceptAll();
    await granting.destroyAndWait();

    const script = document.createElement("script");
    script.dataset["ocGpcPurposeId"] = "analytics";
    script.dataset["ocServerGpc"] = "enabled";
    const restricted = startAutoBootstrap(document, script, {
      ...runtime,
      idGenerator: idGenerator(),
    });
    await restricted.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="open"]')
      ?.click();

    const purpose = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-purpose"][value="analytics"]',
    );
    const category = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="optional"]',
    );
    const description = document.getElementById(
      purpose?.getAttribute("aria-describedby") ?? "",
    );
    expect(purpose?.checked).toBe(false);
    expect(purpose?.disabled).toBe(true);
    expect(category?.checked).toBe(false);
    expect(description?.textContent).toMatch(/privacy signal/iu);

    // Saving other choices leaves the restricted grant as it was recorded.
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settleDom();
    expect(
      restricted.client.getSnapshot().runtime.accessConsent.decisions,
    ).toEqual([{ decision: "granted", purposeId: "analytics" }]);

    restricted.destroy();
    window.close();
  });

  it("starts the denied-state kernel at once and presents in a later task", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/first.js";
    const script = document.createElement("script");
    script.dataset["ocGoogleAnalyticsResource"] = "analytics-script";
    script.dataset["ocGoogleConsentMode"] = "basic";
    document.head.append(resource, script);
    const googleCalls: unknown[][] = [];
    Object.assign(window, {
      gtag: (...call: unknown[]) => googleCalls.push(call),
    });

    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });

    // Consent Mode defaults go out before any later page script can run.
    expect(googleCalls).toEqual([
      [
        "consent",
        "default",
        {
          ad_personalization: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          analytics_storage: "denied",
        },
      ],
    ]);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    // Microtasks alone never present: the bar waits for a later task, and
    // nothing optional starts while it waits.
    expect(document.querySelector("[data-oc-root]")).toBeNull();
    expect(document.querySelector("style[data-opencookie]")).toBeNull();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );

    await started.ready;
    expect(document.querySelector("[data-oc-root]")).not.toBeNull();
    expect(document.querySelector(".oc-bar")).not.toBeNull();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );

    started.destroy();
    window.close();
  });

  it("never presents a drop-in destroyed before its presentation task", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/first.js";
    const script = document.createElement("script");
    document.head.append(resource, script);

    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.destroyAndWait();
    await started.ready;
    await settleDom();

    expect(document.querySelector("[data-oc-root]")).toBeNull();
    expect(document.querySelector("style[data-opencookie]")).toBeNull();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );
    expect(resource.isConnected).toBe(true);
    window.close();
  });

  it("keeps a stored grant blocked when presentation fails", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const addResource = (source: string): HTMLScriptElement => {
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = "analytics";
      resource.dataset["ocResource"] = "analytics-script";
      resource.dataset["src"] = source;
      document.head.append(resource);
      return resource;
    };
    addResource("https://tracker.example.test/first.js");
    const runtime = {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    };
    const granting = startAutoBootstrap(
      document,
      document.createElement("script"),
      runtime,
    );
    await granting.ready;
    await granting.client.acceptAll();
    await granting.destroyAndWait();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );

    const nativePrepend = document.head.prepend.bind(document.head);
    document.head.prepend = (...nodes: (Node | string)[]) => {
      if (
        nodes.some(
          (node) =>
            typeof node !== "string" &&
            "dataset" in node &&
            (node as HTMLElement).dataset["opencookie"] !== undefined,
        )
      ) {
        throw new Error("simulated presentation failure");
      }
      nativePrepend(...nodes);
    };
    const failing = startAutoBootstrap(
      document,
      document.createElement("script"),
      { ...runtime, idGenerator: idGenerator() },
    );

    await expect(failing.ready).rejects.toThrow(
      "simulated presentation failure",
    );
    addResource("https://tracker.example.test/later.js");
    await settleDom();

    expect(document.querySelector("[data-oc-root]")).toBeNull();
    expect(document.querySelectorAll("[data-oc-active-resource]")).toHaveLength(
      0,
    );
    failing.destroy();
    window.close();
  });

  // On a cold browser the script's own task measured 59 to 115 ms at the
  // gate's 4x CPU, because it built the factory and the client there. Only the
  // Consent Mode default has to precede later page scripts, so the drop-in
  // sends that first and builds everything else in later tasks.
  describe("started in turns", () => {
    const consentModePage = () => {
      const window = new Window({ url: "https://shop.example.test/" });
      const document = window.document as unknown as Document;
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = "analytics";
      resource.dataset["ocResource"] = "analytics-script";
      resource.dataset["src"] = "https://tracker.example.test/first.js";
      const script = document.createElement("script");
      script.dataset["ocGoogleAnalyticsResource"] = "analytics-script";
      script.dataset["ocGoogleConsentMode"] = "basic";
      document.head.append(resource, script);
      const googleCalls: unknown[][] = [];
      Object.assign(window, {
        gtag: (...call: unknown[]) => googleCalls.push(call),
      });
      const runtime = {
        idGenerator: idGenerator(),
        now: () => 1_700_000_000_000,
        storage: window.localStorage,
      };
      return { document, googleCalls, runtime, script, window };
    };
    const deniedDefault = [
      "consent",
      "default",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "denied",
      },
    ];

    it("sends the Consent Mode default at once and builds the rest later", async () => {
      const { document, googleCalls, runtime, script, window } =
        consentModePage();

      const starting = startAutoBootstrapInTurns(document, script, runtime);

      expect(googleCalls).toEqual([deniedDefault]);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(document.querySelector("[data-oc-root]")).toBeNull();

      const started = await starting;
      await started.ready;
      expect(document.querySelector(".oc-bar")).not.toBeNull();
      expect(
        googleCalls.filter(([, action]) => action === "default"),
      ).toHaveLength(1);
      expect(
        document.querySelectorAll("[data-oc-active-resource]"),
      ).toHaveLength(0);

      started.destroy();
      window.close();
    });

    // A tag manager's inline snippet after the drop-in's tag in <head> runs
    // before the body exists, and must find the default already sent.
    it("sends the Consent Mode default from <head>, before the body exists", async () => {
      const { document, googleCalls, runtime, script, window } =
        consentModePage();
      const body = document.body;
      body.remove();
      let readyState: DocumentReadyState = "loading";
      Object.defineProperty(document, "readyState", {
        configurable: true,
        get: () => readyState,
      });

      const starting = startAutoBootstrapInTurns(document, script, runtime);
      expect(googleCalls).toEqual([deniedDefault]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.querySelector("[data-oc-root]")).toBeNull();

      document.documentElement.append(body);
      readyState = "interactive";
      document.dispatchEvent(
        new window.Event("DOMContentLoaded") as unknown as Event,
      );
      const started = await starting;
      await started.ready;
      expect(document.querySelector(".oc-bar")).not.toBeNull();
      expect(
        googleCalls.filter(([, action]) => action === "default"),
      ).toHaveLength(1);
      started.destroy();
      window.close();
    });

    it("refuses a second copy before it sends anything", async () => {
      const { document, googleCalls, runtime, script, window } =
        consentModePage();

      const starting = startAutoBootstrapInTurns(document, script, runtime);
      expect(() =>
        startAutoBootstrapInTurns(document, script, runtime),
      ).toThrow(/already running/u);
      expect(googleCalls).toEqual([deniedDefault]);

      const started = await starting;
      await started.ready;
      expect(document.querySelectorAll("[data-oc-root]")).toHaveLength(1);
      started.destroy();
      window.close();
    });

    it("stays denied and frees the page when a later task fails", async () => {
      const { document, googleCalls, runtime, script, window } =
        consentModePage();
      script.dataset["ocPurposeId"] = "ana\u200Blytics";

      await expect(
        startAutoBootstrapInTurns(document, script, runtime),
      ).rejects.toThrow("Invalid auto policy definition.");
      expect(googleCalls).toEqual([deniedDefault]);
      expect(document.querySelector("[data-oc-root]")).toBeNull();
      expect(document.querySelector("style[data-opencookie]")).toBeNull();

      delete script.dataset["ocPurposeId"];
      const started = await startAutoBootstrapInTurns(document, script, {
        ...runtime,
        idGenerator: idGenerator(),
      });
      await started.ready;
      expect(document.querySelector(".oc-bar")).not.toBeNull();
      started.destroy();
      window.close();
    });

    it("is how the drop-in starts", () => {
      const source = readFileSync(
        new URL("./auto.ts", import.meta.url),
        "utf8",
      );
      expect(source).toContain("startAutoBootstrapInTurns(");
      expect(source).not.toMatch(/\bstartAutoBootstrap\(/u);
      // Waiting for the body here would send the default after <head>.
      expect(source).not.toContain("DOMContentLoaded");
    });
  });

  it("projects its compact policy as an operable optional category", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const script = document.createElement("script");
    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const category = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="optional"]',
    );
    expect(category?.closest("label")?.textContent).toContain("optional");
    expect(category?.checked).toBe(false);

    const purpose = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-purpose"][value="analytics"]',
    );
    category?.click();
    expect(category?.checked).toBe(true);
    expect(purpose?.checked).toBe(true);

    category?.click();
    expect(category?.checked).toBe(false);
    expect(category?.indeterminate).toBe(false);
    expect(purpose?.checked).toBe(false);

    category?.click();
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settleDom();
    expect(
      started.client.getSnapshot().runtime.accessConsent.decisions,
    ).toEqual([{ decision: "granted", purposeId: "analytics" }]);

    started.destroy();
    window.close();
  });

  it("expires active consent through the shared refresh lifecycle", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const resource = document.createElement("script");
    resource.type = "text/plain";
    resource.dataset["ocCategory"] = "analytics";
    resource.dataset["ocResource"] = "analytics-script";
    resource.dataset["src"] = "https://tracker.example.test/first.js";
    const script = document.createElement("script");
    script.dataset["ocConsentDurationMs"] = "60000";
    document.head.append(resource, script);
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let sequence = 0;
    const timerWindow = window as unknown as {
      setTimeout: (callback: () => void, delay?: number) => number;
      clearTimeout: (identifier: number) => void;
    };
    const nativeSetTimeout = timerWindow.setTimeout.bind(timerWindow);
    timerWindow.setTimeout = (callback, delay) => {
      if (delay === undefined || delay < 1_000) {
        return nativeSetTimeout(callback, delay);
      }
      const identifier = ++sequence;
      timers.set(identifier, { callback, delay });
      return identifier;
    };
    timerWindow.clearTimeout = (identifier) => {
      timers.delete(identifier);
    };
    let now = 1_700_000_000_000;
    const started = startAutoBootstrap(document, script, {
      idGenerator: idGenerator(),
      now: () => now,
      storage: window.localStorage,
    });

    await started.ready;
    await started.client.acceptAll();
    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);
    expect([...timers.values()].map(({ delay }) => delay)).toEqual([60_000]);

    now += 60_000;
    const [identifier, timer] = [...timers.entries()][0] ?? [];
    if (identifier === undefined || timer === undefined) {
      throw new Error("The product must arm an expiry timer.");
    }
    timers.delete(identifier);
    timer.callback();
    await settleDom();

    expect(started.client.getSnapshot()).toMatchObject({
      record: { method: "accept-all" },
      runtime: { consentEvaluation: { status: "expired" } },
    });
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(timers.size).toBe(0);

    started.destroy();
    window.close();
  });
});
