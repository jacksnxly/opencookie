// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import openCookie from "@opencookie-dev/astro";

// https://astro.build/config
export default defineConfig({
  adapter: node({ mode: "standalone" }),
  integrations: [
    openCookie({
      entrypoint: "/src/opencookie.client.ts",
      stage: "page",
    }),
  ],
  output: "server",
});
