import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import {
  createOpenCookiePlugin,
  useOpenCookieSnapshot,
  useOpenCookieStore,
} from "@opencookie-dev/vue";
import type { App } from "vue";

/**
 * An external store that may hydrate browser-only state after Nuxt mounts.
 * @public
 */
export type InitializableOpenCookieExternalStore<Snapshot> =
  OpenCookieExternalStore<Snapshot> & {
    readonly initialize?: () => PromiseLike<unknown>;
  };

/**
 * The Nuxt application surface used by the runtime binding. Keeping this
 * structural avoids importing Nuxt Kit into browser runtime code.
 *
 * @public
 */
export interface OpenCookieNuxtApp {
  /** Registers post-hydration work with the Nuxt application lifecycle. */
  readonly hook: (
    name: "app:mounted",
    callback: () => Promise<void> | void,
  ) => unknown;
  /** The request-local Vue application that receives the shared binding. */
  readonly vueApp: App;
}

/** Creates one OpenCookie store for one Nuxt application. @public */
export type OpenCookieNuxtStoreFactory<Snapshot> = (
  nuxtApp: OpenCookieNuxtApp,
) => InitializableOpenCookieExternalStore<Snapshot>;

/** The Nuxt plugin result exposed as `$openCookie`. @public */
export interface OpenCookieNuxtPluginResult<Snapshot> {
  /** Values Nuxt injects into its application context. */
  readonly provide: {
    /** The request-local external store. */
    readonly openCookie: InitializableOpenCookieExternalStore<Snapshot>;
  };
}

/** A universal Nuxt runtime plugin backed by the shared Vue binding. @public */
export type OpenCookieNuxtPlugin<Snapshot> = (
  nuxtApp: OpenCookieNuxtApp,
) => OpenCookieNuxtPluginResult<Snapshot>;

/**
 * Creates a universal Nuxt plugin around the shared Vue binding. Server
 * execution only installs the request-local store. Browser initialization is
 * deferred until `app:mounted`, after hydration has completed.
 *
 * @public
 */
export function createOpenCookieNuxtPlugin<Snapshot>(
  createStore: OpenCookieNuxtStoreFactory<Snapshot>,
): OpenCookieNuxtPlugin<Snapshot> {
  return (nuxtApp) => {
    const store = createStore(nuxtApp);
    nuxtApp.vueApp.use(createOpenCookiePlugin(store));

    if (typeof window !== "undefined" && store.initialize !== undefined) {
      nuxtApp.hook("app:mounted", async (): Promise<void> => {
        await store.initialize?.();
      });
    }

    return Object.freeze({
      provide: Object.freeze({ openCookie: store }),
    });
  };
}

export { useOpenCookieSnapshot, useOpenCookieStore };
