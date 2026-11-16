import type { OpenCookieExternalStore } from "@opencookie-dev/core";
import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

const OpenCookieStoreContext = createContext<
  OpenCookieExternalStore<unknown> | undefined
>(undefined);

/** @public */
export interface OpenCookieProviderProps<Snapshot> {
  readonly children?: ReactNode;
  readonly store: OpenCookieExternalStore<Snapshot>;
}

/** @public */
export function OpenCookieProvider<Snapshot>(
  props: OpenCookieProviderProps<Snapshot>,
): ReactElement {
  return createElement(
    OpenCookieStoreContext.Provider,
    { value: props.store },
    props.children,
  );
}

/** @public */
export function useOpenCookieStore<
  Snapshot,
>(): OpenCookieExternalStore<Snapshot> {
  const store = useContext(OpenCookieStoreContext);
  if (store === undefined) {
    throw new Error(
      "OpenCookie hooks must be used below an OpenCookieProvider.",
    );
  }
  return store as OpenCookieExternalStore<Snapshot>;
}

/** @public */
// The explicit type argument binds a provider's erased context at the call site.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function useOpenCookieSnapshot<Snapshot>(): Snapshot {
  const store = useOpenCookieStore<Snapshot>();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}

/** @public */
// Snapshot is supplied by the erased context while Selection is selector-inferred.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function useOpenCookieSelector<Snapshot, Selection>(
  selector: (snapshot: Snapshot) => Selection,
): Selection {
  return selector(useOpenCookieSnapshot<Snapshot>());
}
