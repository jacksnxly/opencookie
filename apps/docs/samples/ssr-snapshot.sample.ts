// docs:consumer-path: src/ssr-snapshot.ts
// docs:display:start
import { createOpenCookieStore } from "../opencookie.config.js";

export function getOpenCookieServerState() {
  const client = createOpenCookieStore();

  // No browser global or storage read occurs during construction.
  return client.getServerSnapshot();
}
// docs:display:end

export function run(): void {
  const snapshot = getOpenCookieServerState();
  if (snapshot.readiness !== "uninitialized") {
    throw new Error(
      "The SSR snapshot must be deterministic and uninitialized.",
    );
  }
}
