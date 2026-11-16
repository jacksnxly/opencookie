export default defineNuxtConfig({
  app: {
    head: {
      htmlAttrs: { lang: "en" },
      link: [{ href: "/fixture.css", rel: "stylesheet" }],
      meta: [
        { charset: "utf-8" },
        { content: "width=device-width, initial-scale=1", name: "viewport" },
        {
          "data-oc-csp": "",
          content: "nonce-marker",
          name: "opencookie-csp",
        },
      ],
      title: "OpenCookie Nuxt fixture",
    },
  },
  compatibilityDate: "2025-07-15",
  devtools: { enabled: false },
  modules: [
    [
      "@opencookie-dev/nuxt",
      {
        storeModule: "~~/opencookie-store",
      },
    ],
  ],
  nitro: { preset: "node-server" },
  ssr: true,
});
