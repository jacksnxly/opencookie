const snapshot = Object.freeze({ readiness: "uninitialized" as const });

export default function createOpenCookieStore() {
  return {
    getServerSnapshot: () => snapshot,
    getSnapshot: () => snapshot,
    initialize: async () => snapshot,
    subscribe: () => () => undefined,
  };
}
