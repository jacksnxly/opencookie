/** @public */
export interface OpenCookieExternalStore<Snapshot> {
  readonly getServerSnapshot: () => Snapshot;
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
}
