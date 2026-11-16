import {
  addPluginTemplate,
  addTypeTemplate,
  defineNuxtModule,
} from "@nuxt/kit";
import type { NuxtModule } from "@nuxt/schema";

/** Options accepted by the OpenCookie Nuxt module. @public */
export interface OpenCookieNuxtModuleOptions {
  /**
   * A Nuxt-resolvable module whose default export creates one external store
   * for the current Nuxt application.
   */
  readonly storeModule: string;
}

function runtimePluginSource(storeModule: string): string {
  return [
    'import { defineNuxtPlugin } from "#app/nuxt";',
    `import createOpenCookieStore from ${JSON.stringify(storeModule)};`,
    'import { createOpenCookieNuxtPlugin } from "@opencookie-dev/nuxt/runtime";',
    "",
    "export default defineNuxtPlugin(createOpenCookieNuxtPlugin(createOpenCookieStore));",
    "",
  ].join("\n");
}

function runtimeTypesSource(): string {
  return [
    'import type { InitializableOpenCookieExternalStore } from "@opencookie-dev/nuxt/runtime";',
    "",
    'declare module "#app" {',
    "  interface NuxtApp {",
    "    readonly $openCookie: InitializableOpenCookieExternalStore<unknown>;",
    "  }",
    "}",
    "",
    'declare module "vue" {',
    "  interface ComponentCustomProperties {",
    "    readonly $openCookie: InitializableOpenCookieExternalStore<unknown>;",
    "  }",
    "}",
    "",
    "export {};",
    "",
  ].join("\n");
}

/**
 * Registers OpenCookie's universal Nuxt plugin. The configured module path is
 * emitted for Nuxt and Vite to resolve; the store itself remains application
 * owned and is constructed once per Nuxt application rather than at module
 * scope.
 *
 * @public
 */
export const openCookieNuxtModule: NuxtModule<
  OpenCookieNuxtModuleOptions,
  OpenCookieNuxtModuleOptions
> = defineNuxtModule<OpenCookieNuxtModuleOptions>({
  meta: {
    name: "@opencookie-dev/nuxt",
    configKey: "openCookie",
    compatibility: {
      nuxt: ">=4.5.2 <5.0.0",
    },
  },
  setup(options): void {
    if (
      typeof options.storeModule !== "string" ||
      options.storeModule.trim().length === 0
    ) {
      throw new TypeError(
        "OpenCookie's Nuxt store module must be a non-empty module path.",
      );
    }

    addPluginTemplate({
      filename: "opencookie.plugin.mjs",
      getContents: () => runtimePluginSource(options.storeModule),
      mode: "all",
    });
    addTypeTemplate({
      filename: "types/opencookie.d.ts",
      getContents: runtimeTypesSource,
    });
  },
});

export {
  createOpenCookieNuxtPlugin,
  useOpenCookieSnapshot,
  useOpenCookieStore,
  type InitializableOpenCookieExternalStore,
  type OpenCookieNuxtApp,
  type OpenCookieNuxtPlugin,
  type OpenCookieNuxtPluginResult,
  type OpenCookieNuxtStoreFactory,
} from "./runtime.js";

export default openCookieNuxtModule;
