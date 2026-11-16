import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import {
  inject,
  onScopeDispose,
  shallowRef,
  type App,
  type InjectionKey,
  type Plugin,
  type ShallowRef,
} from "vue";

const openCookieStoreKey = Symbol("opencookie.store") as InjectionKey<
  OpenCookieExternalStore<unknown>
>;

/** @public */
export function createOpenCookiePlugin<Snapshot>(
  store: OpenCookieExternalStore<Snapshot>,
): Plugin {
  return Object.freeze({
    install(app: App): void {
      app.provide(openCookieStoreKey, store);
    },
  });
}

/** @public */
export function useOpenCookieStore<
  Snapshot,
>(): OpenCookieExternalStore<Snapshot> {
  const store = inject(openCookieStoreKey);
  if (store === undefined) {
    throw new Error(
      "OpenCookie composables require the OpenCookie plugin to be installed.",
    );
  }
  return store as OpenCookieExternalStore<Snapshot>;
}

/** @public */
// The explicit type argument binds the plugin's erased injection at the call site.
export function useOpenCookieSnapshot<Snapshot>(): ShallowRef<Snapshot> {
  const store = useOpenCookieStore<Snapshot>();
  const isServer = typeof window === "undefined";
  const snapshot = shallowRef(
    isServer ? store.getServerSnapshot() : store.getSnapshot(),
  ) as ShallowRef<Snapshot>;

  if (!isServer) {
    const unsubscribe = store.subscribe(() => {
      snapshot.value = store.getSnapshot();
    });
    onScopeDispose(unsubscribe);
  }

  return snapshot;
}
