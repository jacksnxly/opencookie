// docs:consumer-path: astro.config.ts

// docs:display:start
import { createAstroOpenCookieIntegration } from "@opencookie-dev/astro";
import { defineConfig } from "astro/config";

export const openCookie = createAstroOpenCookieIntegration({
  entrypoint: "/src/opencookie.client.ts",
});

export default defineConfig({ integrations: [openCookie] });
// docs:display:end

export function run(): void {
  const injected: string[] = [];
  openCookie.hooks["astro:config:setup"]({
    injectScript: (_stage, content) => injected.push(content),
  });
  if (injected[0] !== 'import "/src/opencookie.client.ts";') {
    throw new Error(
      "The Astro integration did not inject the client entrypoint.",
    );
  }
}
