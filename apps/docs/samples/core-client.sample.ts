import { createDemoOptions } from "./_support.js";

// docs:consumer-path: src/create-consent-client.ts
// docs:display:start
import { createOpenCookie, type OpenCookieOptions } from "@opencookie-dev/core";

export function createConsentClient(options: OpenCookieOptions) {
  const client = createOpenCookie(options);

  // Construction is SSR-safe. Initialize only when the host runtime is ready.
  return client;
}
// docs:display:end

export async function run(): Promise<void> {
  const client = createConsentClient(createDemoOptions());
  if (client.getServerSnapshot().readiness !== "uninitialized") {
    throw new Error("Server construction must remain uninitialized.");
  }
  await client.initialize();
  if (client.getSnapshot().readiness !== "ready") {
    throw new Error("The runnable client did not initialize.");
  }
}
