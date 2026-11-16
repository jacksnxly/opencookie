import { beforeEach, describe, expect, it, vi } from "vitest";

const nuxtKit = vi.hoisted(() => ({
  addPluginTemplate: vi.fn<(template: unknown) => void>(),
  addTypeTemplate: vi.fn<(template: unknown) => void>(),
  defineNuxtModule: vi.fn((definition: unknown) => definition),
}));

vi.mock("@nuxt/kit", () => nuxtKit);

import openCookieNuxtModule from "./index.js";

interface ModuleDefinition {
  readonly meta: {
    readonly compatibility: { readonly nuxt: string };
    readonly configKey: string;
    readonly name: string;
  };
  readonly setup: (options: {
    readonly storeModule: string;
  }) => Promise<void> | void;
}

interface PluginTemplate {
  readonly filename: string;
  readonly getContents: () => string;
  readonly mode: string;
}

const definition = openCookieNuxtModule as unknown as ModuleDefinition;

function registeredTemplate(): PluginTemplate {
  const template = nuxtKit.addPluginTemplate.mock.calls[0]?.[0];
  if (template === undefined) throw new Error("plugin template not registered");
  return template as PluginTemplate;
}

function registeredTypeTemplate(): PluginTemplate {
  const template = nuxtKit.addTypeTemplate.mock.calls[0]?.[0];
  if (template === undefined) throw new Error("type template not registered");
  return template as PluginTemplate;
}

describe("OpenCookie Nuxt module", () => {
  beforeEach(() => {
    nuxtKit.addPluginTemplate.mockClear();
    nuxtKit.addTypeTemplate.mockClear();
  });

  it("registers typed Nuxt and Vue injection surfaces", async () => {
    await definition.setup({ storeModule: "~/opencookie/store" });

    expect(nuxtKit.addTypeTemplate).toHaveBeenCalledOnce();
    const template = registeredTypeTemplate();
    expect(template.filename).toBe("types/opencookie.d.ts");
    expect(template.getContents()).toContain('declare module "#app"');
    expect(template.getContents()).toContain(
      "readonly $openCookie: InitializableOpenCookieExternalStore<unknown>;",
    );
    expect(template.getContents()).toContain('declare module "vue"');
  });

  it("registers one universal plugin for a serializable store-module path", async () => {
    expect(definition.meta).toEqual({
      compatibility: { nuxt: ">=4.5.2 <5.0.0" },
      configKey: "openCookie",
      name: "@opencookie-dev/nuxt",
    });

    await definition.setup({ storeModule: "~/opencookie/store" });

    expect(nuxtKit.addPluginTemplate).toHaveBeenCalledOnce();
    const template = registeredTemplate();
    expect(template.filename).toBe("opencookie.plugin.mjs");
    expect(template.mode).toBe("all");
    expect(template.getContents()).toContain(
      'import createOpenCookieStore from "~/opencookie/store";',
    );
    expect(template.getContents()).toContain(
      'from "@opencookie-dev/nuxt/runtime";',
    );
    expect(template.getContents()).toContain(
      "defineNuxtPlugin(createOpenCookieNuxtPlugin(createOpenCookieStore))",
    );
  });

  it("serializes the module path as a JavaScript string literal", async () => {
    const storeModule = 'store";\nglobalThis.compromised = true;\n//';

    await definition.setup({ storeModule });

    expect(registeredTemplate().getContents()).toContain(
      `import createOpenCookieStore from ${JSON.stringify(storeModule)};`,
    );
  });

  it("rejects an empty store module before registering runtime code", () => {
    expect(() => definition.setup({ storeModule: "   " })).toThrow(
      /store module/i,
    );
    expect(nuxtKit.addPluginTemplate).not.toHaveBeenCalled();
  });
});
