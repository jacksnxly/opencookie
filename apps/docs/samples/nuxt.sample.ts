// docs:consumer-path: nuxt.config.ts

// docs:display:start
import { defineNuxtConfig } from "nuxt/config";

export const nuxtOpenCookie = defineNuxtConfig({
  modules: [["@opencookie-dev/nuxt", { storeModule: "~~/opencookie-store" }]],
});

export default nuxtOpenCookie;
// docs:display:end

export function run(): void {
  if (!JSON.stringify(nuxtOpenCookie).includes("~~/opencookie-store")) {
    throw new Error("The Nuxt module sample is incomplete.");
  }
}
