import { describe, expect, it } from "vitest";

import {
  planInitialization,
  type FileSystemPort,
  type InitializationPlan,
} from "./index.js";

interface BrowserStarterCase {
  readonly assetPath: string;
  readonly expectedFiles: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly integrationPath: string;
  readonly lifecycle: readonly string[];
  readonly name: string;
}

function packageJson(dependencies: Readonly<Record<string, string>>): string {
  return JSON.stringify({
    dependencies,
    packageManager: "pnpm@11.22.0",
  });
}

function memoryFileSystem(
  initial: Readonly<Record<string, string>>,
): FileSystemPort {
  const files = new Map(Object.entries(initial));
  return {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`Missing test file: ${path}`);
      return Promise.resolve(content);
    },
    replaceFile: () => Promise.reject(new Error("Unexpected test edit.")),
    withLock: (_path, operation) => operation(),
    writeFile: () => Promise.reject(new Error("Unexpected test write.")),
  };
}

function generatedFiles(plan: InitializationPlan): ReadonlyMap<string, string> {
  return new Map(plan.files.map(({ content, path }) => [path, content]));
}

const cases: readonly BrowserStarterCase[] = [
  {
    assetPath: "public/opencookie-demo.js",
    expectedFiles: [
      ".opencookie-init.json",
      "opencookie.config.ts",
      "opencookie.policy.ts",
      "public/opencookie-demo.js",
      "src/opencookie.tsx",
    ],
    files: {
      "package.json": packageJson({ react: "latest", vite: "latest" }),
      "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
`,
    },
    integrationPath: "src/opencookie.tsx",
    lifecycle: [
      "useState(() => createOpenCookieBrowserBinding",
      "const mounted = binding.mount",
      "return mounted.destroy",
      "store={binding.client}",
    ],
    name: "React with Vite",
  },
  {
    assetPath: "public/opencookie-demo.js",
    expectedFiles: [
      ".opencookie-init.json",
      "opencookie.config.ts",
      "opencookie.policy.ts",
      "public/opencookie-demo.js",
      "src/opencookie.ts",
    ],
    files: {
      "package.json": packageJson({ vite: "latest", vue: "latest" }),
      "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
`,
    },
    integrationPath: "src/opencookie.ts",
    lifecycle: [
      "createOpenCookieBrowserBinding",
      "app.onUnmount",
      "mounted.destroy",
      "createOpenCookiePlugin(binding.client)",
    ],
    name: "Vue with Vite",
  },
  {
    assetPath: "public/opencookie-demo.js",
    expectedFiles: [
      ".opencookie-init.json",
      "app/opencookie-provider.tsx",
      "opencookie.config.ts",
      "opencookie.policy.ts",
      "public/opencookie-demo.js",
    ],
    files: {
      "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx":
        "export default function Page() { return <main>Home</main>; }\n",
      "package.json": packageJson({ next: "latest", react: "latest" }),
    },
    integrationPath: "app/opencookie-provider.tsx",
    lifecycle: [
      "useState(() => createOpenCookieBrowserBinding",
      "const mounted = binding.mount",
      "return mounted.destroy",
      "store={binding.client}",
    ],
    name: "Next.js App Router",
  },
  {
    assetPath: "public/opencookie-demo.js",
    expectedFiles: [
      ".opencookie-init.json",
      "opencookie-provider.tsx",
      "opencookie.config.ts",
      "opencookie.policy.ts",
      "public/opencookie-demo.js",
    ],
    files: {
      "package.json": packageJson({ next: "latest", react: "latest" }),
      "pages/_app.tsx": `import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`,
    },
    integrationPath: "opencookie-provider.tsx",
    lifecycle: [
      "useState(() => createOpenCookieBrowserBinding",
      "const mounted = binding.mount",
      "return mounted.destroy",
      "store={binding.client}",
    ],
    name: "Next.js Pages Router",
  },
  {
    assetPath: "public/opencookie-demo.js",
    expectedFiles: [
      ".opencookie-init.json",
      "opencookie-store.ts",
      "opencookie.config.ts",
      "opencookie.policy.ts",
      "public/opencookie-demo.js",
    ],
    files: {
      "nuxt.config.ts": "export default defineNuxtConfig({});\n",
      "package.json": packageJson({ nuxt: "^4.5.2" }),
    },
    integrationPath: "opencookie-store.ts",
    lifecycle: [
      "createOpenCookieBrowserBinding",
      'nuxtApp.hook("app:mounted"',
      "nuxtApp.vueApp.onUnmount",
      "return binding.client",
    ],
    name: "Nuxt 3",
  },
  {
    assetPath: "static/opencookie-demo.js",
    expectedFiles: [
      ".opencookie-init.json",
      "opencookie.config.ts",
      "opencookie.policy.ts",
      "src/lib/OpenCookieProvider.svelte",
      "static/opencookie-demo.js",
    ],
    files: {
      "package.json": packageJson({ "@sveltejs/kit": "latest" }),
      "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>

{@render children()}
`,
      "svelte.config.js": "export default {};\n",
    },
    integrationPath: "src/lib/OpenCookieProvider.svelte",
    lifecycle: [
      "createOpenCookieBrowserBinding",
      "setOpenCookieContext(binding.client)",
      "onMount(() =>",
      "return mounted.destroy",
    ],
    name: "SvelteKit",
  },
  {
    assetPath: "public/opencookie-demo.js",
    expectedFiles: [
      ".opencookie-init.json",
      "opencookie.astro.config.mjs",
      "opencookie.config.ts",
      "opencookie.policy.ts",
      "public/opencookie-demo.js",
      "src/opencookie.client.ts",
    ],
    files: {
      "astro.config.mjs": `import { defineConfig } from "astro/config";

export default defineConfig({});
`,
      "package.json": packageJson({ astro: "latest" }),
    },
    integrationPath: "src/opencookie.client.ts",
    lifecycle: [
      "createOpenCookieBrowserBinding",
      'document.addEventListener("astro:before-swap"',
      'document.addEventListener("astro:page-load"',
      "mounted.destroy",
    ],
    name: "Astro",
  },
];

describe("browser-enforced framework starters", () => {
  it.each(cases)(
    "generates an exact, lifecycle-owned $name browser binding",
    async ({
      assetPath,
      expectedFiles,
      files: initial,
      integrationPath,
      lifecycle,
    }) => {
      const plan = await planInitialization(memoryFileSystem(initial), "/app");
      const files = generatedFiles(plan);
      const config = files.get("opencookie.config.ts") ?? "";
      const integration = files.get(integrationPath) ?? "";

      expect([...files.keys()].sort()).toEqual([...expectedFiles].sort());
      expect(config).toContain('id: "opencookie-demo-script"');
      expect(config).toContain('serviceId: "opencookie-demo-service"');
      expect(config).toContain('services: [{ id: "opencookie-demo-service" }]');
      expect(config).toContain('purposeIds: ["analytics"]');
      expect(config).toContain("idGenerator: ports.idGenerator");
      expect(config).toContain("now: ports.now");
      expect(config).toContain("reconcile: ports.reconcile");
      expect(config).toContain("storage: ports.storage");
      expect(config).not.toContain("typeof localStorage");
      expect(config).not.toContain("crypto.randomUUID");

      expect(integration).toContain("createOpenCookieBrowserBinding");
      expect(integration).not.toContain("mountOpenCookie");
      for (const fragment of lifecycle) expect(integration).toContain(fragment);
      expect(integration).toContain('type="text/plain"');
      expect(integration).toContain('data-src="/opencookie-demo.js"');
      expect(integration).toContain(
        'data-oc-resource="opencookie-demo-script"',
      );
      expect(integration).toContain('data-oc-category="analytics"');

      expect(files.get(assetPath)).toBe(
        "globalThis.__openCookieDemoRuns =\n" +
          "  (globalThis.__openCookieDemoRuns ?? 0) + 1;\n",
      );
      expect(files.get(".opencookie-init.json")).toContain(
        JSON.stringify(assetPath),
      );
    },
  );
});
