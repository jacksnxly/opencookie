import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://opencookie.dev",
  integrations: [
    starlight({
      title: "OpenCookie",
      description:
        "A self-hosted, typed consent runtime with explicit enforcement.",
      favicon: "/favicon.svg",
      logo: {
        alt: "OpenCookie",
        replacesTitle: true,
        src: "./src/assets/logo.svg",
      },
      customCss: ["./src/styles/opencookie.css"],
      sidebar: [
        { label: "Start", slug: "index" },
        {
          label: "Quick starts",
          items: [
            { label: "Install OpenCookie", slug: "getting-started" },
            {
              label: "Plain HTML and self-hosting",
              slug: "getting-started/plain-html",
            },
            { label: "React and Vite", slug: "getting-started/react-vite" },
            { label: "Vue and Vite", slug: "getting-started/vue-vite" },
            { label: "SvelteKit", slug: "getting-started/sveltekit" },
            { label: "Next App Router", slug: "getting-started/next-app" },
            { label: "Next Pages Router", slug: "getting-started/next-pages" },
            {
              label: "Next 15 App Router",
              slug: "getting-started/next-15-app",
            },
            { label: "Nuxt", slug: "getting-started/nuxt" },
            { label: "Astro", slug: "getting-started/astro" },
          ],
        },
        {
          label: "Recipes",
          items: [
            {
              label: "Block before consent",
              slug: "recipes/pre-consent-blocking",
            },
            { label: "Strict CSP and nonce", slug: "recipes/csp-nonce" },
            {
              label: "Expiry and withdrawal",
              slug: "recipes/decision-lifecycle",
            },
            {
              label: "SSR, hydration, and CLS",
              slug: "recipes/ssr-hydration-cls",
            },
            { label: "Policy versions", slug: "recipes/policy-versioning" },
            { label: "GPC and Consent Mode", slug: "recipes/signals" },
            { label: "Iframe blocking", slug: "recipes/iframe-blocking" },
            { label: "Subdomain scope", slug: "recipes/subdomain-scope" },
            {
              label: "Plain HTML without a build",
              slug: "recipes/no-build-modules",
            },
            { label: "Testing consent", slug: "recipes/testing" },
            {
              label: "A11y, i18n, and themes",
              slug: "recipes/a11y-i18n-theming",
            },
          ],
        },
        {
          label: "Operating",
          items: [
            { label: "Run a site", slug: "operating/run-a-site" },
            {
              label: "The operator console",
              slug: "operating/operator-console",
            },
          ],
        },
        { label: "Local playground", slug: "playground" },
        {
          label: "Reference",
          items: [
            { label: "API index", slug: "reference/api" },
            { label: "Command line", slug: "reference/cli" },
            { label: "Support policy", slug: "reference/support" },
          ],
        },
      ],
      head: [
        {
          tag: "meta",
          attrs: { name: "theme-color", content: "#e8ff5a" },
        },
      ],
      credits: false,
    }),
  ],
});
