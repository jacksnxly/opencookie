import { describe, expect, it, vi } from "vitest";

import {
  CliConflictError,
  initializeProject,
  type CliPorts,
  type FileSystemPort,
} from "./index.js";

interface WiringCase {
  readonly entryPath: string;
  readonly expected: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly name: string;
}

function manifest(dependencies: Readonly<Record<string, string>>): string {
  return JSON.stringify({ dependencies, packageManager: "pnpm@11.22.0" });
}

function fixturePorts(initial: Readonly<Record<string, string>>): {
  readonly commands: {
    args: readonly string[];
    command: string;
    cwd: string;
  }[];
  readonly files: Map<string, string>;
  readonly ports: CliPorts;
} {
  const files = new Map(Object.entries(initial));
  const commands: { args: readonly string[]; command: string; cwd: string }[] =
    [];
  const fileSystem: FileSystemPort = {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined)
        throw new Error(`Missing fixture file: ${path}`);
      return Promise.resolve(content);
    },
    replaceFile: (path, expected, content) => {
      if (files.get(path) !== expected) {
        return Promise.reject(new Error(`Concurrent fixture edit: ${path}`));
      }
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (_path, operation) => operation(),
    writeFile: (path, content) => {
      if (files.has(path)) {
        return Promise.reject(new Error(`Fixture overwrite: ${path}`));
      }
      files.set(path, content);
      return Promise.resolve();
    },
  };
  return {
    commands,
    files,
    ports: {
      command: {
        run: (command, args, cwd) => {
          commands.push({ args, command, cwd });
          return Promise.resolve();
        },
      },
      confirm: vi.fn(() => Promise.resolve(true)),
      fileSystem,
      writeLine: vi.fn(),
    },
  };
}

const wiringCases: readonly WiringCase[] = [
  {
    entryPath: "index.html",
    expected: [
      '<script defer src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js" integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS" crossorigin="anonymous" data-oc-policy-version="policy-1" data-oc-storage-key="opencookie.consent" data-oc-purpose-id="analytics" data-oc-purpose-label="Analytics" data-oc-purpose-description="Understand aggregate site usage."></script>',
      '<script type="text/plain" data-src="/opencookie-demo.js" data-oc-resource="opencookie-demo-script" data-oc-category="analytics"></script>',
      "</body>",
    ],
    files: {
      "index.html":
        "<!doctype html>\n<html><head></head><body><main>Home</main></body></html>\n",
    },
    name: "plain HTML",
  },
  {
    entryPath: "src/main.tsx",
    expected: [
      'import { OpenCookieRoot } from "./opencookie.js";',
      "<OpenCookieRoot>",
      "<App />",
    ],
    files: {
      "package.json": manifest({ react: "latest", vite: "latest" }),
      "pnpm-lock.yaml": "",
      "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);
`,
    },
    name: "React with Vite",
  },
  {
    entryPath: "src/main.ts",
    expected: [
      'import { initializeOpenCookie, openCookiePlugin } from "./opencookie.js";',
      ".use(openCookiePlugin)",
      "void initializeOpenCookie();",
    ],
    files: {
      "package.json": manifest({ vite: "latest", vue: "latest" }),
      "pnpm-lock.yaml": "",
      "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
`,
    },
    name: "Vue with Vite",
  },
  {
    entryPath: "app/layout.tsx",
    expected: [
      'import { OpenCookieRoot } from "./opencookie-provider";',
      "<OpenCookieRoot>{children}</OpenCookieRoot>",
    ],
    files: {
      "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx":
        "export default function Page() { return <main>Home</main>; }\n",
      "package.json": manifest({ next: "latest", react: "latest" }),
      "pnpm-lock.yaml": "",
    },
    name: "Next.js App Router",
  },
  {
    entryPath: "pages/_app.tsx",
    expected: [
      'import { OpenCookieRoot } from "../opencookie-provider";',
      "<OpenCookieRoot>",
      "<Component {...pageProps} />",
    ],
    files: {
      "package.json": manifest({ next: "latest", react: "latest" }),
      "pages/_app.tsx": `import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`,
      "pnpm-lock.yaml": "",
    },
    name: "Next.js Pages Router",
  },
  {
    entryPath: "nuxt.config.ts",
    expected: [
      "modules:",
      '"@opencookie-dev/nuxt"',
      'storeModule: "~~/opencookie-store"',
    ],
    files: {
      "nuxt.config.ts": `export default defineNuxtConfig({
  compatibilityDate: "2026-08-22",
});
`,
      "package.json": manifest({ nuxt: "^4.5.2" }),
      "pnpm-lock.yaml": "",
    },
    name: "Nuxt 3",
  },
  {
    entryPath: "src/routes/+layout.svelte",
    expected: [
      'import OpenCookieProvider from "../lib/OpenCookieProvider.svelte";',
      "<OpenCookieProvider>",
      "{@render children()}",
    ],
    files: {
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>

{@render children()}
`,
      "svelte.config.js": "export default {};\n",
    },
    name: "SvelteKit",
  },
  {
    entryPath: "astro.config.mjs",
    expected: [
      'import openCookie from "@opencookie-dev/astro";',
      "integrations:",
      'entrypoint: "/src/opencookie.client.ts"',
    ],
    files: {
      "astro.config.mjs": `import { defineConfig } from "astro/config";

export default defineConfig({});
`,
      "package.json": manifest({ astro: "latest" }),
      "pnpm-lock.yaml": "",
    },
    name: "Astro",
  },
];

const legacyAstroConfig = `// opencookie:init
import openCookie from "@opencookie-dev/astro";
// /opencookie:init
import { defineConfig } from "astro/config";

export default defineConfig({
  // opencookie:init
  integrations: [openCookie({ entrypoint: "/src/opencookie.client.ts" })],
  // /opencookie:init
});
`;

const legacyNextPagesGeneratedContent = `// opencookie:init:generated
import { OpenCookieRoot } from "./opencookie-provider.js";
// /opencookie:init
import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <OpenCookieRoot>
      <Component {...pageProps} />
    </OpenCookieRoot>
  );
}
`;

describe("autonomous framework wiring", () => {
  it("leaves a SvelteKit layout wired by an earlier release unchanged", async () => {
    const layout = `<!-- opencookie:init:generated -->\n<script lang="ts">\n  // opencookie:init:import\n  import OpenCookieProvider from "$lib/OpenCookieProvider.svelte";\n  // /opencookie:init:import\n  let { children } = $props();\n</script>\n\n<OpenCookieProvider>\n  {@render children()}\n</OpenCookieProvider>\n<!-- /opencookie:init:generated -->\n`;
    const fixture = fixturePorts({
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte": layout,
      "svelte.config.js": "export default {};\n",
    });
    await initializeProject(fixture.ports, { projectRoot: "/app", yes: true });
    expect(fixture.files.get("src/routes/+layout.svelte")).toBe(layout);
  });

  it("leaves a SvelteKit layout edited by an earlier release unchanged", async () => {
    const layout = `<script lang="ts">\n  // opencookie:init:import\n  import OpenCookieProvider from "$lib/OpenCookieProvider.svelte";\n  // /opencookie:init:import\n  let { children } = $props();\n</script>\n\n<!-- opencookie:init:provider -->\n<OpenCookieProvider>\n  {@render children()}\n</OpenCookieProvider>\n<!-- /opencookie:init:provider -->\n`;
    const fixture = fixturePorts({
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte": layout,
      "svelte.config.js": "export default {};\n",
    });
    await initializeProject(fixture.ports, { projectRoot: "/app", yes: true });
    expect(fixture.files.get("src/routes/+layout.svelte")).toBe(layout);
  });

  it("leaves an earlier-release SvelteKit layout with a reindented import unchanged", async () => {
    const layout = `<script lang="ts">\n  // opencookie:init:import\n\timport OpenCookieProvider from "$lib/OpenCookieProvider.svelte";\n  // /opencookie:init:import\n  let { children } = $props();\n</script>\n\n<!-- opencookie:init:provider -->\n<OpenCookieProvider>\n  {@render children()}\n</OpenCookieProvider>\n<!-- /opencookie:init:provider -->\n`;
    const fixture = fixturePorts({
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte": layout,
      "svelte.config.js": "export default {};\n",
    });
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toBeDefined();
    expect(fixture.files.get("src/routes/+layout.svelte")).toBe(layout);
  });

  it("keeps a SvelteKit layout's own $lib imports and wires it once", async () => {
    const fixture = fixturePorts({
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte": `<script lang="ts">\n  import Header from "$lib/Header.svelte";\n  let { children } = $props();\n</script>\n\n<Header />\n{@render children()}\n`,
      "svelte.config.js": "export default {};\n",
    });
    await initializeProject(fixture.ports, { projectRoot: "/app", yes: true });
    expect(fixture.files.get("src/routes/+layout.svelte")).toBe(
      `<script lang="ts">\n  // opencookie:init:import\n  import OpenCookieProvider from "../lib/OpenCookieProvider.svelte";\n  // /opencookie:init:import\n  import Header from "$lib/Header.svelte";\n  let { children } = $props();\n</script>\n\n<Header />\n<!-- opencookie:init:provider -->\n<OpenCookieProvider>\n  {@render children()}\n</OpenCookieProvider>\n<!-- /opencookie:init:provider -->\n`,
    );
    const snapshot = new Map(fixture.files);
    const second = await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });
    expect(second.status).toBe("unchanged");
    expect(fixture.files).toEqual(snapshot);
  });

  it.each(wiringCases)(
    "wires $name and is byte-stable on a second run",
    async ({ entryPath, expected, files: initial }) => {
      const fixture = fixturePorts(initial);
      const first = await initializeProject(fixture.ports, {
        projectRoot: "/app",
        yes: true,
      });
      expect(first.status).toBe("initialized");
      const wired = fixture.files.get(entryPath) ?? "";
      expect(wired).toContain("opencookie:init");
      for (const fragment of expected) expect(wired).toContain(fragment);
      if (entryPath !== "index.html") {
        expect(fixture.commands[0]?.args).toContain("@opencookie-dev/vanilla");
      }

      const snapshot = new Map(fixture.files);
      const second = await initializeProject(fixture.ports, {
        projectRoot: "/app",
        yes: true,
      });
      expect(second.status).toBe("unchanged");
      expect(fixture.files).toEqual(snapshot);
      expect(fixture.commands).toHaveLength(entryPath === "index.html" ? 0 : 1);
    },
  );

  it.each([
    {
      entryPath: "src/main.tsx",
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
`,
      },
      mutate: (content: string) =>
        content.replace('from "react-dom/client"', 'from "./decoy-renderer"'),
      name: "React createRoot ownership",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      mutate: (content: string) =>
        content.replace(
          "export default function RootLayout({ children }: { children: ReactNode }) {\n",
          "export default function RootLayout({ children }: { children: ReactNode }) {\n  const OpenCookieRoot = ({ children }: { children: ReactNode }) => <>{children}</>;\n",
        ),
      name: "Next App local provider shadow",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`,
        "pnpm-lock.yaml": "",
      },
      mutate: (content: string) =>
        content.replace(
          "export default function App({ Component, pageProps }: AppProps) {\n",
          "export default function App({ Component, pageProps }: AppProps) {\n  const OpenCookieRoot = Component;\n",
        ),
      name: "Next Pages local provider shadow",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      mutate: (content: string) =>
        content.replace(
          /<!-- opencookie:init:provider -->[\s\S]*?<!-- \/opencookie:init:provider -->/u,
          "{#each [null] as OpenCookieProvider}\n$&\n{/each}",
        ),
      name: "Svelte template provider shadow",
    },
    {
      entryPath: "src/main.tsx",
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
createRoot(document.getElementById("root")!).render(<App />);
`,
      },
      mutate: (content: string) =>
        content.replace(
          "import { OpenCookieRoot }",
          "import type { OpenCookieRoot }",
        ),
      name: "React type-only provider import",
    },
    {
      entryPath: "src/main.tsx",
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
createRoot(document.getElementById("root")!).render(<App />);
`,
      },
      mutate: (content: string) =>
        content.replace(
          "import { OpenCookieRoot }",
          "import { type OpenCookieRoot }",
        ),
      name: "React type-only provider specifier",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
createApp(App).mount("#app");
`,
      },
      mutate: (content: string) =>
        content.replace(
          "import { initializeOpenCookie, openCookiePlugin }",
          "import type { initializeOpenCookie, openCookiePlugin }",
        ),
      name: "Vue type-only integration import",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      mutate: (content: string) =>
        content.replace(
          "import { OpenCookieRoot }",
          "import type { OpenCookieRoot }",
        ),
      name: "Next App type-only provider import",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      mutate: (content: string) =>
        content.replace(
          "import { OpenCookieRoot }",
          "import type { OpenCookieRoot }",
        ),
      name: "Next Pages type-only provider import",
    },
    {
      entryPath: "astro.config.mjs",
      files: {
        "astro.config.mjs": `import { defineConfig } from "astro/config";
export default defineConfig({});
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      mutate: (content: string) =>
        content.replace(
          "import openCookie from",
          "import type openCookie from",
        ),
      name: "Astro type-only integration import",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      mutate: (content: string) =>
        content.replace(
          "import OpenCookieProvider from",
          "import type OpenCookieProvider from",
        ),
      name: "Svelte type-only provider import",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      mutate: (content: string) =>
        content
          .replaceAll("<OpenCookieProvider>", "<opencookieprovider>")
          .replaceAll("</OpenCookieProvider>", "</opencookieprovider>"),
      name: "Svelte lowercase custom-element provider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      mutate: (content: string) =>
        content
          .replace(
            "<!-- opencookie:init:provider -->",
            "<!-- opencookie:init:provider -->\n{#if false}",
          )
          .replace(
            "<!-- /opencookie:init:provider -->",
            "{/if}\n<!-- /opencookie:init:provider -->",
          ),
      name: "Svelte provider hidden by an outer block",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      mutate: (content: string) =>
        content.replace(
          "  {@render children()}",
          "  {#if false}{@render children()}{/if}",
        ),
      name: "Svelte render hidden inside the provider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      mutate: (content: string) => `${content}{@render children()}\n`,
      name: "Svelte second render outside the provider",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      mutate: (content: string) =>
        content
          .replace(
            "export default function RootLayout",
            "export default (function OpenCookieRoot",
          )
          .replace(/\n\}\n$/u, "\n});\n"),
      name: "Next App managed function self-binding",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      mutate: (content: string) =>
        content
          .replace(
            "export default function App",
            "export default (function OpenCookieRoot",
          )
          .replace(/\n\}\n$/u, "\n});\n"),
      name: "Next Pages managed function self-binding",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      mutate: (content: string) =>
        content.replace(
          '<script lang="ts">',
          '<script module lang="ts">\n  const OpenCookieProvider = "consumer-owned";\n</script>\n<script lang="ts">',
        ),
      name: "Svelte managed module provider binding",
    },
  ])(
    "rejects $name introduced after the first managed run",
    async ({ entryPath, files, mutate }) => {
      const fixture = fixturePorts(files);
      await expect(
        initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
      ).resolves.toMatchObject({ status: "initialized" });
      const wired = fixture.files.get(entryPath) ?? "";
      const shadowed = mutate(wired);
      expect(shadowed).not.toBe(wired);
      fixture.files.set(entryPath, shadowed);
      const before = new Map(fixture.files);
      const commandCount = fixture.commands.length;

      await expect(
        initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
      ).rejects.toThrow(CliConflictError);
      expect(fixture.files).toEqual(before);
      expect(fixture.commands).toHaveLength(commandCount);
    },
  );

  it("refuses an unsupported custom entrypoint without changing any file", async () => {
    const fixture = fixturePorts({
      "package.json": manifest({ react: "latest", vite: "latest" }),
      "pnpm-lock.yaml": "",
      "src/main.tsx": "bootstrapApplicationThroughCustomRenderer();\n",
    });
    const before = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(before);
    expect(fixture.commands).toHaveLength(0);
  });

  it.each([
    {
      entryPath: "src/main.tsx",
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
function CustomApp() { return null; }
const example = "<App />";
createRoot(document.getElementById("root")!).render(<CustomApp />);
void example;
`,
      },
      name: "a React string decoy beside a custom renderer",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
function exampleMount() {
  createApp(App).mount("#app");
}
const app = createApp(App);
app.mount("#app");
void exampleMount;
`,
      },
      name: "an executable Vue helper decoy",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
function Example({ children }: { children: ReactNode }) {
  return <body>{children}</body>;
}
export default function RootLayout(props: { children: ReactNode }) {
  return <html><body>{props.children}</body></html>;
}
void Example;
`,
        "app/page.tsx":
          "export default function Page() { return <main>Home</main>; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "an executable Next layout helper decoy",
    },
    {
      entryPath: "nuxt.config.ts",
      files: {
        "nuxt.config.ts": `const customConfig = {};
const example = "defineNuxtConfig({";
export default defineNuxtConfig(customConfig);
void example;
`,
        "package.json": manifest({ nuxt: "4.5.2" }),
        "pnpm-lock.yaml": "",
      },
      name: "a Nuxt string decoy beside a custom config",
    },
    {
      entryPath: "astro.config.mjs",
      files: {
        "astro.config.mjs": `import { defineConfig } from "astro/config";
const customConfig = {};
const example = "defineConfig({";
export default defineConfig(customConfig);
void example;
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "an Astro string decoy beside a custom config",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";

const app = createApp(App);
app.mount("#app");
`,
      },
      name: "an assigned Vue app instance",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";

const example = \`
createApp(App).mount("#app")
\`;
const app = createApp(App);
app.mount("#app");
void example;
`,
      },
      name: "a Vue template-literal decoy",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";

const backtickPattern = /\`/;
const example = \`
createApp(App).mount("#app")
\`;
const app = createApp(App);
app.mount("#app");
void backtickPattern;
void example;
`,
      },
      name: "a Vue regex-before-template decoy",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout(props: { children: ReactNode }) {
  const {children} = props;
  return <html><body>{props.children}</body></html>;
}
`,
        "app/page.tsx":
          "export default function Page() { return <main>Home</main>; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a custom Next App layout",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";

const example = "<body>{children}</body>";

export default function RootLayout(props: { children: ReactNode }) {
  return <html><body>{props.children}</body></html>;
}

void example;
`,
        "app/page.tsx":
          "export default function Page() { return <main>Home</main>; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a Next string-literal body decoy",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";

const quotePattern = /"/;
const example = "<body>{children}</body>";

export default function RootLayout(props: { children: ReactNode }) {
  return <html><body>{props.children}</body></html>;
}

void quotePattern;
void example;
`,
        "app/page.tsx":
          "export default function Page() { return <main>Home</main>; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a Next regex-before-string body decoy",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";

if (globalThis.name) /"/.test(globalThis.name);
const example = "<body>{children}</body>";

export default function RootLayout(props: { children: ReactNode }) {
  return <html><body>{props.children}</body></html>;
}

void example;
`,
        "app/page.tsx":
          "export default function Page() { return <main>Home</main>; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a Next statement-position regex decoy",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  const page = <Component {...pageProps} />;
  return page;
}
`,
        "pnpm-lock.yaml": "",
      },
      name: "a custom Next Pages renderer",
    },
  ])("refuses $name before installation", async ({ entryPath, files }) => {
    const fixture = fixturePorts(files);
    const before = new Map(fixture.files);

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);

    expect(fixture.files).toEqual(before);
    expect(fixture.files.get(entryPath)).toBe(before.get(entryPath));
    expect(fixture.commands).toHaveLength(0);
  });

  it("preserves a supported Next directive prologue before injected imports", async () => {
    const fixture = fixturePorts({
      "app/layout.tsx": `"use client";

import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx":
        "export default function Page() { return <main>Home</main>; }\n",
      "package.json": manifest({ next: "latest", react: "latest" }),
      "pnpm-lock.yaml": "",
    });

    await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });

    expect(fixture.files.get("app/layout.tsx")).toMatch(
      /^"use client";\n\n\/\/ opencookie:init:import\n/u,
    );
  });

  it("preserves a Next directive prologue after a leading license comment", async () => {
    const fixture = fixturePorts({
      "app/layout.tsx": `/* Copyright Example Corp. Licensed MIT. */
"use client";

import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx":
        "export default function Page() { return <main>Home</main>; }\n",
      "package.json": manifest({ next: "latest", react: "latest" }),
      "pnpm-lock.yaml": "",
    });

    await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });

    expect(fixture.files.get("app/layout.tsx")).toMatch(
      /^\/\* Copyright Example Corp\. Licensed MIT\. \*\/\n"use client";\n\n\/\/ opencookie:init:import\n/u,
    );
  });

  it.each([
    {
      name: "leading blank and line-comment trivia",
      prologue: '\n// Licensed MIT.\n"use client";\n\n',
    },
    {
      name: "a trailing directive comment",
      prologue: '"use client"; // client boundary\n\n',
    },
    {
      name: "an inter-directive block comment",
      prologue:
        '"use strict";\n/* Keep directives contiguous. */\n"use client";\n\n',
    },
  ])("preserves Next directives with $name", async ({ prologue }) => {
    const fixture = fixturePorts({
      "app/layout.tsx": `${prologue}import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
      "app/page.tsx":
        "export default function Page() { return <main>Home</main>; }\n",
      "package.json": manifest({ next: "latest", react: "latest" }),
      "pnpm-lock.yaml": "",
    });

    await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });

    expect(fixture.files.get("app/layout.tsx")).toMatch(
      new RegExp(
        `^${prologue.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}// opencookie:init:import\\n`,
        "u",
      ),
    );
  });

  it("refuses an incomplete initialization marker", async () => {
    const fixture = fixturePorts({
      "package.json": manifest({ react: "latest", vite: "latest" }),
      "pnpm-lock.yaml": "",
      "src/main.tsx": `// opencookie:init
import { OpenCookieRoot } from "./opencookie.js";
createRoot(root).render(<OpenCookieRoot><App /></OpenCookieRoot>);
`,
    });
    const before = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(before);
    expect(fixture.commands).toHaveLength(0);
  });

  it("rejects swapped Astro marker ownership on a managed rerun", async () => {
    const fixture = fixturePorts({
      "astro.config.mjs": `import { defineConfig } from "astro/config";
export default defineConfig({});
`,
      "package.json": manifest({ astro: "latest" }),
      "pnpm-lock.yaml": "",
    });
    await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });
    const managed = fixture.files.get("astro.config.mjs") ?? "";
    fixture.files.set(
      "astro.config.mjs",
      managed
        .replaceAll(":import", ":temporary")
        .replaceAll(":config", ":import")
        .replaceAll(":temporary", ":config"),
    );
    const before = new Map(fixture.files);

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(before);
  });

  it("rejects a React import detached from its managed marker", async () => {
    const fixture = fixturePorts({
      "package.json": manifest({ react: "latest", vite: "latest" }),
      "pnpm-lock.yaml": "",
      "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
createRoot(document.getElementById("root")).render(<App />);
`,
    });
    await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });
    const managed = fixture.files.get("src/main.tsx") ?? "";
    const importLine = 'import { OpenCookieRoot } from "./opencookie.js";';
    fixture.files.set(
      "src/main.tsx",
      managed.replace(
        `// opencookie:init:import\n${importLine}\n// /opencookie:init:import`,
        `${importLine}\n// opencookie:init:import\nconst consumerOwned = true;\n// /opencookie:init:import`,
      ),
    );
    const before = new Map(fixture.files);

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(before);
  });

  it("rejects a React marker containing only an import comment decoy", async () => {
    const fixture = fixturePorts({
      "package.json": manifest({ react: "latest", vite: "latest" }),
      "pnpm-lock.yaml": "",
      "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
createRoot(document.getElementById("root")).render(<App />);
`,
    });
    await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });
    const managed = fixture.files.get("src/main.tsx") ?? "";
    const importLine = 'import { OpenCookieRoot } from "./opencookie.js";';
    fixture.files.set(
      "src/main.tsx",
      managed.replace(
        `// opencookie:init:import\n${importLine}\n// /opencookie:init:import`,
        `${importLine}\n// opencookie:init:import\n/* ${importLine} */\n// /opencookie:init:import`,
      ),
    );
    const before = new Map(fixture.files);

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(before);
  });

  it.each([
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App";
import CustomApp from "./CustomApp";

const condition = globalThis.name.length > 0;
createRoot(document.getElementById("root")!).render(
  condition ? <App /> : <CustomApp />,
);
`,
      },
      name: "a conditional React render root",
    },
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /><aside>Unexpected sibling</aside></StrictMode>,
);
`,
      },
      name: "a React StrictMode root with an extra sibling",
    },
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />, onRendered);
`,
      },
      name: "a React render call with a second argument",
    },
    {
      files: {
        "app/layout.tsx": `export default function RootLayout(props) {
  function Example({ children }) {
    return <html><body>{children}</body></html>;
  }
  void Example;
  return <html><body>{props.children}</body></html>;
}
`,
        "app/page.tsx":
          "export default function Page() { return <main>Home</main>; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a canonical-looking nested Next App helper",
    },
    {
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `export default function App({ Component, pageProps }) {
  function Example() {
    return <Component {...pageProps} />;
  }
  void Example;
  return renderApplication(Component, pageProps);
}
`,
        "pages/index.tsx":
          "export default function Page() { return <main>Home</main>; }\n",
        "pnpm-lock.yaml": "",
      },
      name: "a canonical-looking nested Next Pages helper",
    },
    {
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
  const example = "{@render children()}";
</script>
<CustomRenderer>{children}</CustomRenderer>
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "a Svelte render string inside script",
    },
    {
      files: {
        "index.html":
          '<!doctype html><html><head></head><script>const example = "</body>";</script></html>\n',
      },
      name: "an HTML closing-body string without a body end tag",
    },
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `// opencookie:init
// /opencookie:init
const docs = 'import { OpenCookieRoot } from "./opencookie.js"; <OpenCookieRoot>';
createRoot(root).render(<App />);
void docs;
`,
      },
      name: "balanced markers disconnected from the React root",
    },
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `// opencookie:init:import
import { OpenCookieRoot } from "./opencookie.js";
// /opencookie:init:import
// opencookie:init:import
// /opencookie:init:import
createRoot(root).render(<OpenCookieRoot><App /></OpenCookieRoot>);
`,
      },
      name: "duplicate named initialization markers",
    },
    {
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({
  "modules": [],
});
`,
        "package.json": manifest({ nuxt: "4.5.2" }),
        "pnpm-lock.yaml": "",
      },
      name: "a quoted Nuxt modules key",
    },
    {
      files: {
        "nuxt.config.ts": `export default defineNuxtConfig({
  [\`modules\`]: [],
});
`,
        "package.json": manifest({ nuxt: "4.5.2" }),
        "pnpm-lock.yaml": "",
      },
      name: "a computed static Nuxt modules key",
    },
    {
      files: {
        "nuxt.config.ts": `const key = "modules";
export default defineNuxtConfig({ [key]: [] });
`,
        "package.json": manifest({ nuxt: "4.5.2" }),
        "pnpm-lock.yaml": "",
      },
      name: "a dynamic Nuxt config key",
    },
    {
      files: {
        "nuxt.config.ts": `const custom = {};
export default defineNuxtConfig({ ...custom });
`,
        "package.json": manifest({ nuxt: "4.5.2" }),
        "pnpm-lock.yaml": "",
      },
      name: "a Nuxt spread that may override modules",
    },
    {
      files: {
        "astro.config.mjs": `import { defineConfig } from "astro/config";
export default defineConfig({ "integrations": [] });
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a quoted Astro integrations key",
    },
    {
      files: {
        "astro.config.mjs": `import { defineConfig } from "astro/config";
export default defineConfig({ ["integrations"]: [] });
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a computed static Astro integrations key",
    },
    {
      files: {
        "astro.config.mjs": `import { defineConfig } from "astro/config";
const custom = {};
export default defineConfig({ ...custom });
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "an Astro spread that may override integrations",
    },
  ])("refuses $name before any command or write", async ({ files }) => {
    const fixture = fixturePorts(files);
    const before = new Map(fixture.files);

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);

    expect(fixture.files).toEqual(before);
    expect(fixture.commands).toHaveLength(0);
  });

  it.each([
    {
      entryPath: "src/main.tsx",
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
interface createRoot { readonly example: true }
type App = { readonly example: true };
interface OpenCookieRoot { readonly example: true }
createRoot(document.getElementById("root")).render(<App />);
`,
      },
      expected: "<OpenCookieRoot>",
      name: "React with same-name type declarations",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
interface createApp { readonly example: true }
type App = { readonly example: true };
interface initializeOpenCookie { readonly example: true }
type openCookiePlugin = { readonly example: true };
createApp(App).mount("#app");
`,
      },
      expected: ".use(openCookiePlugin)",
      name: "Vue with same-name type declarations",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
interface OpenCookieRoot { readonly example: true }
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      expected: "<OpenCookieRoot>{children}</OpenCookieRoot>",
      name: "Next App with a same-name provider interface",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
export default function RootLayout({ children }: { children: ReactNode }) {
  interface OpenCookieRoot { readonly example: true }
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      expected: "<OpenCookieRoot>{children}</OpenCookieRoot>",
      name: "Next App with a function-local provider interface",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `type OpenCookieRoot = { readonly example: true };
export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      expected: "<OpenCookieRoot>",
      name: "Next Pages with a same-name provider type",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `export default function App({ Component, pageProps }) {
  type OpenCookieRoot = { readonly example: true };
  return <Component {...pageProps} />;
}
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      expected: "<OpenCookieRoot>",
      name: "Next Pages with a function-local provider type",
    },
    {
      entryPath: "astro.config.ts",
      files: {
        "astro.config.ts": `import { defineConfig } from "astro/config";
interface defineConfig { readonly example: true }
type openCookie = { readonly example: true };
export default defineConfig({});
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      expected: "integrations: [openCookie(",
      name: "Astro with same-name type declarations",
    },
    {
      entryPath: "nuxt.config.ts",
      files: {
        "nuxt.config.ts": `const docs = "modules:";
// modules: is discussed in the migration guide.
export default defineNuxtConfig({ runtimeConfig: { modules: [] } });
void docs;
`,
        "package.json": manifest({ nuxt: "4.5.2" }),
        "pnpm-lock.yaml": "",
      },
      expected: 'modules: [["@opencookie-dev/nuxt"',
      name: "Nuxt config with nested and inert modules decoys",
    },
    {
      entryPath: "astro.config.mjs",
      files: {
        "astro.config.mjs": `import { defineConfig } from "astro/config";
const docs = "integrations:";
// integrations: is discussed in the migration guide.
export default defineConfig({ vite: { integrations: [] } });
void docs;
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      expected: "integrations: [openCookie(",
      name: "Astro config with nested and inert integrations decoys",
    },
    {
      entryPath: "index.html",
      files: {
        "index.html": `<!doctype html>
<html><head>
  <!-- </body> -->
  <script>const example = "</body>";</script>
</head><body data-example="</body>"><main>Home</main></body></html>
`,
      },
      expected: "<!-- opencookie:init:script -->",
      name: "HTML with inert closing-body decoys and one real end tag",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
  const scriptDecoy = "{@render children()}";
</script>
<style>.example::after { content: "{@render children()}"; }</style>
<!-- {@render children()} -->
<div data-example={'{@render children()}'}>{@render children()}</div>
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with script style comment and attribute decoys",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const text = "";
  let { children } = $props();
</script>
<p>{[.../}{@render children()}/.exec(text) ?? []].length}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a render decoy in a regex spread operand",
      preserved: "/}{@render children()}/.exec(text)",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const state = { return: 4 };
  let { children } = $props();
</script>
<p>{state.return / 2}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with division after a keyword property",
      preserved: "{state.return / 2}",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const of = 4;
  let { children } = $props();
</script>
<p>{of / 2}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with division after a contextual identifier",
      preserved: "{of / 2}",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const text = "";
  let { children } = $props();
</script>
<p>{(() => { if (true) /}}{@render children()}/.test(text); return 1; })()}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a render decoy after a control head",
      preserved: "/}}{@render children()}/.test(text)",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const text = "";
  let { children } = $props();
</script>
<p>{(() => { {} /}}{@render children()}/.test(text); return 1; })()}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a render decoy after a statement block",
      preserved: "/}}{@render children()}/.test(text)",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script module lang="ts">
  type OpenCookieProvider = { readonly example: true };
</script>
<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a module-only provider type",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script module lang="ts">
  const example = <number>1;
</script>
<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a module-script angle assertion",
      preserved: "const example = <number>1;",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const example = <number>1;
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an instance-script angle assertion",
      preserved: "const example = <number>1;",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  type OpenCookieProvider = { readonly example: true };
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an instance-script provider type",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  interface OpenCookieProvider { readonly example: true }
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an instance-script provider interface",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  interface OpenCookieProvider { readonly example: true }
  let { children } = $props();
</script>
{#snippet row(item: OpenCookieProvider)}<span>{item}</span>{/snippet}
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a provider type in a snippet parameter",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const rows = [{ OpenCookieProvider: 1 }];
  let { children } = $props();
</script>
{#each rows as { OpenCookieProvider: item }}<span>{item}</span>{/each}
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a provider property in an each pattern",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const rows = { OpenCookieProvider: [1] };
  let { children } = $props();
</script>
{#each rows.OpenCookieProvider as item}<span>{item}</span>{/each}
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a provider property in an each iterable",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<p>{"<div>"}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an HTML-like string expression",
      preserved: '{"<div>"}',
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<p>{"😀<div>"}</p>
<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an astral expression before its script",
      preserved: '{"😀<div>"}',
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<p>{"😀<div>"}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an astral expression after its script",
      preserved: '{"😀<div>"}',
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const text = "";
  let { children } = $props();
</script>
<p>{text.includes("<script>")}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an HTML-like script string expression",
      preserved: '{text.includes("<script>")}',
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{#snippet row<T>(item: T)}<span>{item}</span>{/snippet}
{@html "<b>x</b>"}
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with generic snippets and raw HTML strings",
      preserved: '{@html "<b>x</b>"}',
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<p>{(<number>1) + 1}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a TypeScript angle assertion",
      preserved: "{(<number>1) + 1}",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<p>{(<T>(value: T) => value)(1)}</p>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a TypeScript generic arrow",
      preserved: "{(<T>(value: T) => value)(1)}",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const count = 2;
  let { children } = $props();
</script>
<div title="{count > 1 ? "many" : "one"}">{count}</div>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with a quoted attribute expression",
      preserved: 'title="{count > 1 ? "many" : "one"}"',
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<div title="{text.includes("<script>") ? "<div>" : ""}">x</div>
<script lang="ts">
  const text = "";
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      expected: "<OpenCookieProvider>",
      name: "Svelte with an HTML-like quoted attribute expression",
      preserved: 'title="{text.includes("<script>") ? "<div>" : ""}"',
    },
  ])("wires $name at the structural root", async (scenario) => {
    const { entryPath, expected, files } = scenario;
    const fixture = fixturePorts(files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "initialized" });
    expect(fixture.files.get(entryPath)).toContain(expected);
    if ("preserved" in scenario) {
      expect(fixture.files.get(entryPath)).toContain(scenario.preserved);
    }
    const snapshot = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "unchanged" });
    expect(fixture.files).toEqual(snapshot);
  });

  it("keeps a compact Svelte instance script valid and byte-stable", async () => {
    const fixture = fixturePorts({
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte":
        '<script lang="ts">let { children } = $props();</script>{@render children()}\n',
      "svelte.config.js": "export default {};\n",
    });

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "initialized" });
    const wired = fixture.files.get("src/routes/+layout.svelte") ?? "";
    expect(wired).toContain(
      "// /opencookie:init:import\nlet { children } = $props();",
    );
    const snapshot = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "unchanged" });
    expect(fixture.files).toEqual(snapshot);
  });

  it("ignores nested Svelte JSON-LD and raw script payloads", async () => {
    const fixture = fixturePorts({
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte": `<script context="module" lang="ts">
  const schemaEnabled = true;
</script>
<script lang="ts">
  let { children } = $props();
</script>
<svelte:head>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>
  <script type="text/plain">not valid JavaScript = ; // opencookie:init:raw</script>
</svelte:head>
{@render children()}
`,
      "svelte.config.js": "export default {};\n",
    });

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "initialized" });
    const snapshot = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "unchanged" });
    expect(fixture.files).toEqual(snapshot);
  });

  it.each([
    {
      nested: `{#if true}
  <script type="application/ld+json">{"x":1}</script>
{/if}`,
      shape: "an if-block JSON-LD script",
    },
    {
      nested: `{#snippet schema()}
  <script type="text/plain">not valid JavaScript = ;</script>
{/snippet}`,
      shape: "a snippet raw script",
    },
    {
      nested: `{#if count++ / 2}
  <script type="text/plain">not valid JavaScript = ;</script>
{/if}`,
      shape: "a raw script below postfix division",
    },
  ])("ignores $shape when locating component scripts", async ({ nested }) => {
    const fixture = fixturePorts({
      "package.json": manifest({ "@sveltejs/kit": "latest" }),
      "pnpm-lock.yaml": "",
      "src/routes/+layout.svelte": `<script lang="ts">
  let count = 0;
  let { children } = $props();
</script>
${nested}
{@render children()}
`,
      "svelte.config.js": "export default {};\n",
    });

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "initialized" });
    const snapshot = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).resolves.toMatchObject({ status: "unchanged" });
    expect(fixture.files).toEqual(snapshot);
  });

  it.each([
    {
      expression: '<p>{"{@render children()}"}</p>',
      shape: "a quoted expression string",
    },
    {
      expression: "<p>{`{@render children()}`}</p>",
      shape: "a template-literal expression",
    },
    {
      expression: '<p>{foo! / 2 ? "{@render children()}" : ""}</p>',
      shape: "a quoted expression after TypeScript non-null division",
    },
    {
      expression:
        "<p>{[.../}{@render children()}/.exec(text) ?? []].length}</p>",
      shape: "a regex expression after spread",
    },
    {
      expression:
        "<p>{(() => { if (true) /}}{@render children()}/.test(text); return 1; })()}</p>",
      shape: "a regex expression after a control head",
    },
    {
      expression:
        "<p>{(() => { {} /}}{@render children()}/.test(text); return 1; })()}</p>",
      shape: "a regex expression after a statement block",
    },
  ])(
    "does not rewrite $shape as a Svelte render tag",
    async ({ expression }) => {
      const fixture = fixturePorts({
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const text = "";
  let { children } = $props();
</script>
${expression}
`,
        "svelte.config.js": "export default {};\n",
      });
      const before = new Map(fixture.files);

      await expect(
        initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
      ).rejects.toThrow(CliConflictError);
      expect(fixture.files).toEqual(before);
      expect(fixture.commands).toHaveLength(0);
    },
  );

  it.each([
    {
      entryPath: "src/main.tsx",
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
const OpenCookieRoot = ({ children }) => children;
createRoot(document.getElementById("root")).render(<App />);
`,
      },
      name: "React OpenCookieRoot",
    },
    {
      entryPath: "src/main.tsx",
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
if (globalThis.name) {
  var OpenCookieRoot = undefined;
}
createRoot(document.getElementById("root")).render(<App />);
void OpenCookieRoot;
`,
      },
      name: "module-hoisted React OpenCookieRoot",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
const openCookiePlugin = {};
createApp(App).mount("#app");
`,
      },
      name: "Vue openCookiePlugin",
    },
    {
      entryPath: "src/main.ts",
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
function initializeOpenCookie() {}
createApp(App).mount("#app");
`,
      },
      name: "Vue initializeOpenCookie",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
const OpenCookieRoot = ({ children }: { children: ReactNode }) => children;
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "Next OpenCookieRoot",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
export default function RootLayout({ children, OpenCookieRoot }: {
  children: ReactNode;
  OpenCookieRoot: ({ children }: { children: ReactNode }) => ReactNode;
}) {
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "Next App parameter OpenCookieRoot",
    },
    {
      entryPath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `import type { ReactNode } from "react";
export default (function OpenCookieRoot({ children }: { children: ReactNode }) {
  return <html><body>{children}</body></html>;
});
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "Next App function self-binding OpenCookieRoot",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `export default function App({ Component, pageProps }) {
  const OpenCookieRoot = Component;
  return <Component {...pageProps} />;
}
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      name: "Next Pages local OpenCookieRoot",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `export default (function OpenCookieRoot({ Component, pageProps }) {
  return <Component {...pageProps} />;
});
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      name: "Next Pages function self-binding OpenCookieRoot",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const OpenCookieProvider = "consumer-owned";
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<Wrapper let:item={OpenCookieProvider}>
  {@render children()}
</Wrapper>
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte aliased slot OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<Wrapper let:item={OpenCookieProvider!}>
  {@render children()}
</Wrapper>
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte non-null aliased slot OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<Wrapper let:item={OpenCookieProvider as any}>
  {@render children()}
</Wrapper>
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte asserted aliased slot OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<Wrapper let:item={({ OpenCookieProvider } as any)}>
  {@render children()}
</Wrapper>
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte object-pattern slot OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
<Wrapper let:item={([OpenCookieProvider] as any)}>
  {@render children()}
</Wrapper>
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte array-pattern slot OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script module lang="ts">
  const OpenCookieProvider = "consumer-owned";
</script>
<script lang="ts">
  let { children } = $props();
</script>
{@render children()}
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte module OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{#each [null] as OpenCookieProvider}
  {@render children()}
{/each}
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte each-block OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const foo = 4;
  const items = [null];
  let { children } = $props();
</script>
{#each (foo! / 2 ? items : []) as OpenCookieProvider}
  {@render children()}
{/each}
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte non-null division each OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const foo = null;
  const items = [{}];
  let { children } = $props();
</script>
{#each items as { OpenCookieProvider = foo as unknown }}
  {@render children()}
{/each}
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte typed each-pattern OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  const items = [null];
  let { children } = $props();
</script>
{#each items as OpenCookieProvider (OpenCookieProvider as object)}
  {@render children()}
{/each}
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte keyed typed each OpenCookieProvider",
    },
    {
      entryPath: "src/routes/+layout.svelte",
      files: {
        "package.json": manifest({ "@sveltejs/kit": "latest" }),
        "pnpm-lock.yaml": "",
        "src/routes/+layout.svelte": `<script lang="ts">
  let { children } = $props();
</script>
{#if true}
  {@const { x = 1, OpenCookieProvider } = { x: 1, OpenCookieProvider: null }}
  {@render children()}
{/if}
`,
        "svelte.config.js": "export default {};\n",
      },
      name: "Svelte const-pattern OpenCookieProvider",
    },
    {
      entryPath: "astro.config.mjs",
      files: {
        "astro.config.mjs": `import { defineConfig } from "astro/config";
const openCookie = () => ({ name: "consumer-owned" });
export default defineConfig({});
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "Astro openCookie",
    },
  ])(
    "refuses a consumer-owned $name binding before writes",
    async ({ entryPath, files }) => {
      const fixture = fixturePorts(files);
      const before = new Map(fixture.files);
      await expect(
        initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
      ).rejects.toThrow(CliConflictError);
      expect(fixture.files.get(entryPath)).toBe(before.get(entryPath));
      expect(fixture.files).toEqual(before);
      expect(fixture.commands).toHaveLength(0);
    },
  );

  it.each([
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "./custom-renderer";
import App from "./App.tsx";
createRoot(document.getElementById("root")).render(<App />);
`,
      },
      name: "React createRoot imported from another module",
    },
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
function App() { return null; }
createRoot(document.getElementById("root")).render(<App />);
`,
      },
      name: "React App declared locally",
    },
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
function App() { return null; }
createRoot(document.getElementById("root")).render(<App />);
`,
      },
      name: "React App duplicated after the correct import",
    },
    {
      files: {
        "package.json": manifest({ react: "latest", vite: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App.tsx";
if (globalThis.name) {
  var createRoot = () => ({ render: () => undefined });
}
createRoot(document.getElementById("root")).render(<App />);
`,
      },
      name: "React createRoot shadowed after the correct import",
    },
    {
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "./custom-vue";
import App from "./App.vue";
createApp(App).mount("#app");
`,
      },
      name: "Vue createApp imported from another module",
    },
    {
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
const App = {};
createApp(App).mount("#app");
`,
      },
      name: "Vue App declared locally",
    },
    {
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
const App = {};
createApp(App).mount("#app");
`,
      },
      name: "Vue App duplicated after the correct import",
    },
    {
      files: {
        "package.json": manifest({ vite: "latest", vue: "latest" }),
        "pnpm-lock.yaml": "",
        "src/main.ts": `import { createApp } from "vue";
import App from "./App.vue";
if (globalThis.name) {
  var createApp = () => ({ mount: () => undefined, use: () => undefined });
}
createApp(App).mount("#app");
`,
      },
      name: "Vue createApp shadowed after the correct import",
    },
  ])("refuses $name before writes", async ({ files }) => {
    const fixture = fixturePorts(files);
    const before = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(before);
    expect(fixture.commands).toHaveLength(0);
  });

  it.each([
    {
      activePath: "app/layout.tsx",
      files: {
        "app/layout.tsx": `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
        "app/page.tsx": "export default function Page() { return null; }\n",
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pnpm-lock.yaml": "",
        "src/app/layout.tsx":
          "export default function Stale() { return null; }\n",
        "src/app/page.tsx":
          "export default function StalePage() { return null; }\n",
      },
      ignoredPath: "src/app/layout.tsx",
      providerPath: "app/opencookie-provider.tsx",
    },
    {
      activePath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
        "src/pages/_app.tsx":
          "export default function Stale() { return null; }\n",
        "src/pages/index.tsx":
          "export default function StalePage() { return null; }\n",
      },
      ignoredPath: "src/pages/_app.tsx",
      providerPath: "opencookie-provider.tsx",
    },
  ])(
    "wires $activePath and ignores the stale src tree",
    async ({ activePath, files, ignoredPath, providerPath }) => {
      const fixture = fixturePorts(files);
      const ignoredBefore = fixture.files.get(ignoredPath);
      await expect(
        initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
      ).resolves.toMatchObject({ status: "initialized" });
      expect(fixture.files.get(activePath)).toContain("opencookie:init");
      expect(fixture.files.get(ignoredPath)).toBe(ignoredBefore);
      expect(fixture.files.has(providerPath)).toBe(true);
      expect(fixture.files.has(`src/${providerPath}`)).toBe(false);
    },
  );

  it.each([
    {
      entryPath: "astro.config.mjs",
      files: {
        "astro.config.mjs": legacyAstroConfig,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      expectedMarkers: [
        "// opencookie:init:import",
        "// /opencookie:init:import",
        "// opencookie:init:config",
        "// /opencookie:init:config",
      ],
      name: "Astro",
    },
    {
      entryPath: "pages/_app.tsx",
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": legacyNextPagesGeneratedContent,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      expectedMarkers: [
        "// opencookie:init:generated",
        "// /opencookie:init:generated",
      ],
      name: "Next Pages",
    },
  ])(
    "migrates exact legacy $name markers and is stable thereafter",
    async ({ entryPath, expectedMarkers, files }) => {
      const fixture = fixturePorts(files);
      await expect(
        initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
      ).resolves.toMatchObject({ status: "initialized" });
      const migrated = fixture.files.get(entryPath) ?? "";
      for (const marker of expectedMarkers) expect(migrated).toContain(marker);
      const snapshot = new Map(fixture.files);
      await expect(
        initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
      ).resolves.toMatchObject({ status: "unchanged" });
      expect(fixture.files).toEqual(snapshot);
    },
  );

  it.each([
    {
      files: {
        "astro.config.mjs": legacyAstroConfig.replace(
          'entrypoint: "/src/opencookie.client.ts"',
          'entrypoint: "/src/consumer.client.ts"',
        ),
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "an altered Astro legacy block",
    },
    {
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `${legacyNextPagesGeneratedContent}export const consumerOwned = true;\n`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      name: "an altered Next Pages legacy file",
    },
    {
      files: {
        "astro.config.mjs": `// opencookie:init
import openCookie from "@opencookie-dev/astro";
// /opencookie:init
import { defineConfig } from "astro/config";
export default defineConfig({
  integrations: [openCookie({ entrypoint: "/src/opencookie.client.ts" })],
});
`,
        "package.json": manifest({ astro: "latest" }),
        "pnpm-lock.yaml": "",
      },
      name: "a malformed single-pair Astro legacy block",
    },
    {
      files: {
        "package.json": manifest({ next: "latest", react: "latest" }),
        "pages/_app.tsx": `// opencookie:init
import { OpenCookieRoot } from "./opencookie-provider.js";
// /opencookie:init
export default function App({ Component, pageProps }) {
  return <OpenCookieRoot><Component {...pageProps} /></OpenCookieRoot>;
}
`,
        "pages/index.tsx": "export default function Page() { return null; }\n",
        "pnpm-lock.yaml": "",
      },
      name: "a malformed single-pair Next Pages legacy block",
    },
  ])("refuses $name instead of broad legacy acceptance", async ({ files }) => {
    const fixture = fixturePorts(files);
    const before = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(before);
    expect(fixture.commands).toHaveLength(0);
  });
});

describe("browser binding integration", () => {
  it.each([
    "src/opencookie.tsx",
    "src/opencookie.ts",
    "app/opencookie-provider.tsx",
    "opencookie-provider.tsx",
    "opencookie-store.ts",
    "src/lib/OpenCookieProvider.svelte",
    "src/opencookie.client.ts",
  ])("owns the vanilla browser lifecycle from %s", async (integrationPath) => {
    const matchingCase = wiringCases.find(({ entryPath }) => {
      const mapping: Readonly<Record<string, string>> = {
        "src/main.tsx": "src/opencookie.tsx",
        "src/main.ts": "src/opencookie.ts",
        "app/layout.tsx": "app/opencookie-provider.tsx",
        "pages/_app.tsx": "opencookie-provider.tsx",
        "nuxt.config.ts": "opencookie-store.ts",
        "src/routes/+layout.svelte": "src/lib/OpenCookieProvider.svelte",
        "astro.config.mjs": "src/opencookie.client.ts",
      };
      return mapping[entryPath] === integrationPath;
    });
    if (matchingCase === undefined) throw new Error("Missing wiring fixture");
    const fixture = fixturePorts(matchingCase.files);
    await initializeProject(fixture.ports, { projectRoot: "/app", yes: true });
    const integration = fixture.files.get(integrationPath) ?? "";
    expect(integration).toContain("createOpenCookieBrowserBinding");
    expect(integration).not.toContain("mountOpenCookie");
  });

  it("wires the pinned deferred bootstrap and inert demo into plain HTML", async () => {
    const fixture = fixturePorts(wiringCases[0]?.files ?? {});
    await initializeProject(fixture.ports, { projectRoot: "/site", yes: true });
    const html = fixture.files.get("index.html") ?? "";
    expect(html).toContain(
      '<script defer src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js" integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS" crossorigin="anonymous" data-oc-policy-version="policy-1" data-oc-storage-key="opencookie.consent" data-oc-purpose-id="analytics" data-oc-purpose-label="Analytics" data-oc-purpose-description="Understand aggregate site usage."></script>',
    );
    expect(html).toContain(
      '<script type="text/plain" data-src="/opencookie-demo.js" data-oc-resource="opencookie-demo-script" data-oc-category="analytics"></script>',
    );
    expect(fixture.files.get("opencookie-demo.js")).toContain(
      "__openCookieDemoRuns",
    );
    expect(html).not.toContain("/.opencookie/init.js");
    expect(fixture.files.has(".opencookie/init.js")).toBe(false);
  });
});
