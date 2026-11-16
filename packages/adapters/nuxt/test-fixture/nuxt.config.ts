import openCookie from "@opencookie-dev/nuxt";

if (typeof openCookie !== "function") {
  throw new TypeError(
    "The packed OpenCookie Nuxt root export is not a module.",
  );
}

export default defineNuxtConfig({
  devtools: { enabled: false },
  modules: ["@opencookie-dev/nuxt"],
  openCookie: { storeModule: "~~/opencookie-store" },
});
