// docs:consumer-path: src/svelte-opencookie.ts
// docs:display:start
import { setOpenCookieContext } from "@opencookie-dev/svelte";

import { createOpenCookieStore } from "../opencookie.config.js";

const openCookieStore = createOpenCookieStore();

// Call this once during the root layout component's initialization.
export function provideOpenCookie() {
  return setOpenCookieContext(openCookieStore);
}
// docs:display:end

export function run(): void {
  let lifecycleGuardWorked = false;
  try {
    provideOpenCookie();
  } catch {
    lifecycleGuardWorked = true;
  }
  if (!lifecycleGuardWorked) {
    throw new Error(
      "Svelte context setup should require component initialization.",
    );
  }
}
