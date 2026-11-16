import type {
  OpenCookieExternalStore,
  OpenCookieSnapshot,
} from "@opencookie-dev/core";
import { bootstrapOpenCookieFixture } from "$lib/fixture-client";

type FixtureSnapshot = Pick<OpenCookieSnapshot, "readiness"> &
  Partial<Pick<OpenCookieSnapshot, "runtime">>;

const SERVER_SNAPSHOT: FixtureSnapshot = Object.freeze({
  readiness: "uninitialized",
});

export function createFixtureOpenCookieStore(): OpenCookieExternalStore<FixtureSnapshot> & {
  readonly initialize: () => Promise<void>;
} {
  const listeners = new Set<() => void>();
  let initialized = false;
  let snapshot = SERVER_SNAPSHOT;
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return Object.freeze({
    getServerSnapshot: () => SERVER_SNAPSHOT,
    getSnapshot: () => snapshot,
    async initialize(): Promise<void> {
      if (initialized || typeof document === "undefined") return;
      initialized = true;
      const nonce =
        document.querySelector<HTMLElement>("meta[data-oc-csp]")?.nonce;
      try {
        const mounted = bootstrapOpenCookieFixture(
          document,
          nonce === undefined || nonce.length === 0 ? undefined : nonce,
        );
        snapshot = mounted.client.getSnapshot();
        mounted.client.subscribe(() => {
          snapshot = mounted.client.getSnapshot();
          notify();
        });
        await mounted.ready;
        snapshot = mounted.client.getSnapshot();
        document.documentElement.setAttribute("data-oc-ready", "true");
        notify();
      } catch (error) {
        document.documentElement.dataset.ocError =
          error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
