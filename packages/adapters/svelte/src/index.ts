import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import { createContext, onMount } from "svelte";
import { readonly, writable, type Readable } from "svelte/store";

/** @public */
export interface SvelteOpenCookieBinding<Snapshot> {
  readonly framework: "svelte";
  readonly snapshot: Readable<Snapshot>;
  readonly store: OpenCookieExternalStore<Snapshot>;
}

const [readOpenCookieContext, writeOpenCookieContext] =
  createContext<SvelteOpenCookieBinding<unknown>>();

function connectExternalStore<Snapshot>(
  store: OpenCookieExternalStore<Snapshot>,
  publish: (snapshot: Snapshot) => void,
): () => void {
  let active = true;
  const publishCurrentSnapshot = (): void => {
    if (active) {
      publish(store.getSnapshot());
    }
  };
  const unsubscribe = store.subscribe(publishCurrentSnapshot);

  try {
    publishCurrentSnapshot();
  } catch (error: unknown) {
    active = false;
    unsubscribe();
    throw error;
  }

  return (): void => {
    if (!active) {
      return;
    }
    active = false;
    unsubscribe();
  };
}

/**
 * Installs an OpenCookie store for the current component tree.
 *
 * Call this during a provider component's initialization. The returned Svelte
 * store starts with the server snapshot and connects to the client store only
 * after the provider mounts.
 *
 * @public
 */
export function setOpenCookieContext<Snapshot>(
  store: OpenCookieExternalStore<Snapshot>,
): SvelteOpenCookieBinding<Snapshot> {
  const state = writable(store.getServerSnapshot());
  const binding: SvelteOpenCookieBinding<Snapshot> = Object.freeze({
    framework: "svelte",
    snapshot: readonly(state),
    store,
  });

  writeOpenCookieContext(binding);
  onMount(() => connectExternalStore(store, state.set));

  return binding;
}

/**
 * Returns the closest OpenCookie binding in the current component tree.
 *
 * Call this during component initialization below a component that called
 * {@link setOpenCookieContext}.
 *
 * @public
 */
// Snapshot binds the erased context type at the call site.
export function getOpenCookieContext<
  Snapshot,
>(): SvelteOpenCookieBinding<Snapshot> {
  try {
    return readOpenCookieContext() as SvelteOpenCookieBinding<Snapshot>;
  } catch (cause: unknown) {
    throw new Error(
      "OpenCookie context is unavailable. Call getOpenCookieContext during component initialization below a component that called setOpenCookieContext.",
      { cause },
    );
  }
}
