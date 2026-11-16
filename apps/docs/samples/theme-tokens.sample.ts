import { Window } from "happy-dom";
import { mountOpenCookie } from "@opencookie-dev/vanilla";

import { createDemoClient } from "./_support.js";

// docs:consumer-path: snippets/theme-tokens.ts
// docs:display:start
export const themeTokens = String.raw`.oc-root {
  --oc-ink: #102c31;
  --oc-paper: #fffefa;
  --oc-muted: #4f6663;
  --oc-accent: #426e63;
}`;
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window({ url: "https://shop.example.test/" });
  const document = window.document as unknown as Document;
  const mounted = mountOpenCookie({ client: createDemoClient(), document });
  await mounted.ready;
  const stylesheet = Array.from(document.head.querySelectorAll("style"))
    .map((element) => element.textContent)
    .join("");
  for (const [token] of themeTokens.matchAll(/--oc-[a-z]+/gu)) {
    if (!stylesheet.includes(`${token}:`)) {
      throw new Error(`${token} is not a token OpenCookie declares.`);
    }
  }
  mounted.destroy();
  window.close();
}
