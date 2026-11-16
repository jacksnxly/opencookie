import type {
  VanillaBrowserProduct,
  VanillaBrowserRefreshLifecycle,
} from "./browser-runtime.js";

/**
 * Core-free product-composition seam shared by the generic and auto
 * bootstrap preparations. It owns the browser-facing composition contract:
 * current-access reconciliation hand-off and the refresh lifecycle every
 * product derives from its client. The browser runtime stays core-agnostic and
 * receives this composition by injection.
 *
 * @internal
 */
export interface VanillaProductCompositionOptions {
  readonly client: VanillaBrowserProduct[0];
  readonly enforceCurrentAccess: () => Promise<void>;
  readonly now: (minimum?: number) => number;
}

/** Default lifetime shared with the classic-script storage adapter. @internal */
export const DEFAULT_CONSENT_DURATION_MS = 180 * 24 * 60 * 60 * 1000;

/** Monotonic fallback sequence that can outlive individual mounts. @internal */
export function createBrowserIdFallbackSequence(): () => number {
  let sequence = 0;
  return () => ++sequence;
}

/** Browser identifier source shared by generic and auto preparation. @internal */
export function defaultBrowserIdGenerator(
  document: Document,
  now: () => number,
  nextFallbackSequence = createBrowserIdFallbackSequence(),
): (kind: "record" | "transition") => string {
  return (kind) => {
    const crypto = document.defaultView?.crypto as
      { readonly randomUUID?: () => string } | undefined;
    const uuid = crypto?.randomUUID?.();
    return uuid === undefined
      ? `${kind}-${String(now())}-${String(nextFallbackSequence())}`
      : `${kind}-${uuid}`;
  };
}

/** The default Web Storage, with a read for watching it. @internal */
export interface DefaultBrowserStorage extends Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
> {
  /**
   * Reads a key without permitting a write, so watching storage never lets the
   * store write over a value it has not read. Undefined if unreadable.
   */
  readonly peek: (key: string) => string | null | undefined;
}

/** Lazy Web Storage default shared by generic and auto preparation. @internal */
export function defaultBrowserStorage(
  document: Document,
): DefaultBrowserStorage {
  let resolvedStorage: Storage | undefined;
  let writePermitted = false;
  const storage = (): Storage => {
    if (resolvedStorage !== undefined) return resolvedStorage;
    const resolved = document.defaultView?.localStorage;
    if (resolved === undefined) {
      throw new Error("Browser local storage is unavailable.");
    }
    resolvedStorage = resolved;
    return resolvedStorage;
  };
  const writableStorage = (): Storage => {
    if (!writePermitted || resolvedStorage === undefined) {
      throw new Error(
        "Browser local storage must be read successfully before it is changed.",
      );
    }
    writePermitted = false;
    return resolvedStorage;
  };
  return Object.freeze({
    getItem: (key: string) => {
      let resolved: Storage;
      try {
        resolved = storage();
      } catch {
        writePermitted = false;
        return null;
      }
      writePermitted = false;
      const value = resolved.getItem(key);
      writePermitted = true;
      return value;
    },
    removeItem: (key: string) => {
      writePermitted = false;
      storage().removeItem(key);
    },
    setItem: (key: string, value: string) => {
      writableStorage().setItem(key, value);
    },
    peek: (key: string) => {
      try {
        return storage().getItem(key);
      } catch {
        return undefined;
      }
    },
  });
}

/** Browser wall clock advanced by elapsed time and explicit record floors. @internal */
export function createVanillaBrowserClock(
  document: Document,
  now: () => number,
): (minimum?: number) => number {
  const performance = document.defaultView?.performance;
  let previousElapsed: number | undefined;
  let logicalNow: number | undefined;

  return function (this: unknown, minimum = 0): number {
    const wallNow = Reflect.apply(now, this, []);
    let elapsedNow: number | undefined;
    try {
      const observed = performance?.now();
      if (
        observed !== undefined &&
        Number.isFinite(observed) &&
        observed >= 0
      ) {
        const wholeMilliseconds = Math.floor(observed);
        if (Number.isSafeInteger(wholeMilliseconds)) {
          elapsedNow = wholeMilliseconds;
        }
      }
    } catch {
      elapsedNow = undefined;
    }

    const elapsedSincePrevious =
      elapsedNow !== undefined &&
      previousElapsed !== undefined &&
      elapsedNow >= previousElapsed
        ? elapsedNow - previousElapsed
        : 0;
    if (logicalNow !== undefined && elapsedSincePrevious > 0) {
      logicalNow += elapsedSincePrevious;
    }
    if (logicalNow === undefined && minimum > wallNow) {
      logicalNow = minimum + elapsedSincePrevious;
    } else if (logicalNow !== undefined) {
      logicalNow = Math.max(logicalNow, wallNow, minimum);
    }
    if (elapsedNow !== undefined) previousElapsed = elapsedNow;
    return logicalNow ?? Math.max(wallNow, minimum);
  };
}

function refreshLifecycleFor(
  client: VanillaBrowserProduct[0],
  now: (minimum?: number) => number,
): VanillaBrowserRefreshLifecycle {
  return {
    now: () => {
      const record = client.getSnapshot().record;
      return now(record?.withdrawnAt ?? record?.decidedAt ?? 0);
    },
    refresh: async () => {
      await client.refresh();
    },
    refreshAt: () => {
      const snapshot = client.getSnapshot();
      const reconciliationStatus =
        snapshot.runtime.policyReconciliation?.status;
      const accessStatus = snapshot.runtime.accessConsent.status;
      const refreshable =
        (reconciliationStatus === "current" && accessStatus === "active") ||
        (reconciliationStatus === "requires-reconsent" &&
          accessStatus === "requires-reconsent");
      return refreshable ? snapshot.record?.expiresAt : undefined;
    },
  };
}

/** Composes one product for the shared browser lifecycle owner. @internal */
export function composeVanillaProduct(
  options: VanillaProductCompositionOptions,
): VanillaBrowserProduct {
  return [
    options.client,
    options.enforceCurrentAccess,
    refreshLifecycleFor(options.client, options.now),
  ];
}
