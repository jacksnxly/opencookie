import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import { describe, expect, it, vi } from "vitest";

import openCookie, {
  type AstroOpenCookieConfigSetupContext,
  type AstroOpenCookieIntegration,
  createAstroOpenCookieIntegration,
  createAstroServerBinding,
} from "./index.js";

async function runConfigSetup(
  integration: AstroOpenCookieIntegration,
  injectScript: AstroOpenCookieConfigSetupContext["injectScript"],
): Promise<void> {
  await integration.hooks["astro:config:setup"]({ injectScript });
}

describe("Astro integration", () => {
  it("injects a bundled page entrypoint that also runs without hydrated islands", async () => {
    const injectScript =
      vi.fn<AstroOpenCookieConfigSetupContext["injectScript"]>();
    const integration = openCookie({
      entrypoint: "./src/opencookie.client.ts",
    });

    expect(openCookie).toBe(createAstroOpenCookieIntegration);
    expect(integration.name).toBe("@opencookie-dev/astro");

    await runConfigSetup(integration, injectScript);

    expect(injectScript).toHaveBeenCalledOnce();
    expect(injectScript).toHaveBeenCalledWith(
      "page",
      'import "./src/opencookie.client.ts";',
    );
  });

  it("can run the entrypoint before framework island hydration", async () => {
    const injectScript =
      vi.fn<AstroOpenCookieConfigSetupContext["injectScript"]>();
    const integration = createAstroOpenCookieIntegration({
      entrypoint: "@site/opencookie-client",
      stage: "before-hydration",
    });

    await runConfigSetup(integration, injectScript);

    expect(injectScript).toHaveBeenCalledWith(
      "before-hydration",
      'import "@site/opencookie-client";',
    );
  });

  it("serializes the entrypoint as a JavaScript string literal", async () => {
    const injectScript =
      vi.fn<AstroOpenCookieConfigSetupContext["injectScript"]>();
    const entrypoint = './client";\nglobalThis.compromised = true;\n//';
    const integration = createAstroOpenCookieIntegration({ entrypoint });

    await runConfigSetup(integration, injectScript);

    expect(injectScript).toHaveBeenCalledWith(
      "page",
      `import ${JSON.stringify(entrypoint)};`,
    );
  });

  it("rejects an empty browser entrypoint during configuration", () => {
    expect(() =>
      createAstroOpenCookieIntegration({ entrypoint: "  " }),
    ).toThrow(/entrypoint/i);
  });
});

describe("Astro server binding", () => {
  it("reads only the stable server snapshot and has no browser dependency", () => {
    const store: OpenCookieExternalStore<{ readonly state: "server" }> = {
      getServerSnapshot: vi.fn(() => ({ state: "server" as const })),
      getSnapshot: vi.fn(() => {
        throw new Error("client snapshot must not be read during SSR");
      }),
      subscribe: vi.fn(() => {
        throw new Error("SSR must not subscribe");
      }),
    };

    expect(typeof document).toBe("undefined");

    const binding = createAstroServerBinding(store);

    expect(binding).toEqual({
      framework: "astro",
      interactive: false,
      snapshot: { state: "server" },
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(store.getServerSnapshot).toHaveBeenCalledOnce();
    expect(store.getSnapshot).not.toHaveBeenCalled();
    expect(store.subscribe).not.toHaveBeenCalled();
  });
});
