import { Window } from "happy-dom";

// docs:consumer-path: src/plain-opencookie.ts
// docs:display:start
import { mountOpenCookie } from "@opencookie-dev/vanilla";

import { createOpenCookieStore } from "../opencookie.config.js";

const client = createOpenCookieStore();

export async function startOpenCookie(document: Document) {
  const mounted = mountOpenCookie({
    client,
    document,
  });
  await mounted.ready;
  return mounted;
}
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window();
  const mounted = await startOpenCookie(window.document as unknown as Document);
  if (!window.document.querySelector("[data-oc-root]")) {
    throw new Error("The plain HTML sample did not mount a consent root.");
  }
  mounted.destroy();
  window.close();
}
