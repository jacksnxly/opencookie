import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import ts from "typescript";

import {
  CliConflictError,
  buildInstallCommand,
  initializeProject,
  planInitialization,
  type CliPorts,
  type FileSystemPort,
} from "./index.js";

function packageJson(dependencies: Readonly<Record<string, string>>): string {
  return JSON.stringify({ dependencies });
}

function sha384Integrity(content: string): `sha384-${string}` {
  return `sha384-${createHash("sha384")
    .update(content, "utf8")
    .digest("base64")}`;
}

const reactEntrypoint = `import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
`;

const vueEntrypoint = `import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
`;

function memoryPorts(initial: Readonly<Record<string, string>>): {
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
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing test file: ${path}`);
      return Promise.resolve(value);
    },
    replaceFile: (path, expected, content) => {
      if (files.get(path) !== expected) {
        return Promise.reject(new Error(`Concurrent test edit: ${path}`));
      }
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (_path, operation) => operation(),
    writeFile: (path, content) => {
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

function generatedTypeScriptDiagnostics(
  files: Readonly<Record<string, string>>,
): readonly string[] {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const virtualFiles = new Map(
    Object.entries({
      "/app/opencookie-core.d.ts": `declare module "@opencookie-dev/core" {
  export const CONSENT_RECORD_SCHEMA_VERSION: number;
  export interface DecisionStore {
    clear(): Promise<void>;
    clearIfCurrent(...args: any[]): Promise<unknown>;
    compareAndSet(...args: any[]): Promise<unknown>;
    read(...args: any[]): Promise<unknown>;
  }
  export function createLocalStorageDecisionStore(options: unknown): DecisionStore;
  export function createOpenCookie(options: unknown): unknown;
  export function createPolicySnapshot(policy: unknown): unknown;
  export function definePolicy(input: unknown):
    | { ok: true; policy: { purposes: readonly { disclosure: string; id: string }[] } }
    | { ok: false; issues: readonly { readonly code: string; readonly path: string }[] };
  export function defineResourcePolicy(input: unknown):
    | { ok: true; resourcePolicy: unknown }
    | { ok: false; issues: readonly { readonly code: string; readonly path: string }[] };
}
`,
      "/app/opencookie-vanilla.d.ts": `declare module "@opencookie-dev/vanilla" {
  export interface OpenCookieBrowserClientPorts {
    readonly idGenerator: (kind: never) => string;
    readonly now: () => number;
    readonly reconcile: (...args: readonly unknown[]) => Promise<void>;
    readonly storage: Storage;
  }
}
`,
      ...files,
    }),
  );
  const defaultHost = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...defaultHost,
    directoryExists: (directoryName) =>
      directoryName === "/app" ||
      defaultHost.directoryExists?.(directoryName) === true,
    fileExists: (fileName) =>
      virtualFiles.has(fileName) || defaultHost.fileExists(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const source =
        virtualFiles.get(fileName) ?? defaultHost.readFile(fileName);
      return source === undefined
        ? undefined
        : ts.createSourceFile(fileName, source, languageVersion, true);
    },
    readFile: (fileName) =>
      virtualFiles.get(fileName) ?? defaultHost.readFile(fileName),
  };
  const program = ts.createProgram({
    host,
    options,
    rootNames: [...virtualFiles.keys()],
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

describe("buildInstallCommand", () => {
  it.each([
    ["pnpm", "pnpm", ["add", "@opencookie-dev/core", "@opencookie-dev/react"]],
    [
      "npm",
      "npm",
      ["install", "@opencookie-dev/core", "@opencookie-dev/react"],
    ],
    ["yarn", "yarn", ["add", "@opencookie-dev/core", "@opencookie-dev/react"]],
    ["bun", "bun", ["add", "@opencookie-dev/core", "@opencookie-dev/react"]],
  ] as const)("selects the %s add command", (manager, command, args) => {
    expect(
      buildInstallCommand(manager, [
        "@opencookie-dev/core",
        "@opencookie-dev/react",
      ]),
    ).toEqual({ args, command });
  });
});

describe("planInitialization", () => {
  it.each([
    [
      "react-vite",
      { react: "latest", vite: "latest" },
      "@opencookie-dev/react",
      "src/opencookie.tsx",
    ],
    [
      "vue-vite",
      { vite: "latest", vue: "latest" },
      "@opencookie-dev/vue",
      "src/opencookie.ts",
    ],
    ["nuxt", { nuxt: "^4.5.2" }, "@opencookie-dev/nuxt", "opencookie-store.ts"],
    [
      "sveltekit",
      { "@sveltejs/kit": "latest" },
      "@opencookie-dev/svelte",
      "src/lib/OpenCookieProvider.svelte",
    ],
    [
      "astro",
      { astro: "latest" },
      "@opencookie-dev/astro",
      "src/opencookie.client.ts",
    ],
  ] as const)(
    "plans %s with its adapter and integration file",
    async (_framework, dependencies, adapter, integrationPath) => {
      const { ports } = memoryPorts({
        "package.json": packageJson(dependencies),
        ...(!("react" in dependencies) || !("vite" in dependencies)
          ? {}
          : { "src/main.tsx": reactEntrypoint }),
        ...(!("vue" in dependencies) || !("vite" in dependencies)
          ? {}
          : { "src/main.ts": vueEntrypoint }),
        ...(!("nuxt" in dependencies)
          ? {}
          : { "nuxt.config.ts": "export default defineNuxtConfig({});\n" }),
        ...(!("@sveltejs/kit" in dependencies)
          ? {}
          : { "svelte.config.js": "" }),
        ...(!("astro" in dependencies)
          ? {}
          : {
              "astro.config.mjs":
                'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n',
            }),
      });
      const plan = await planInitialization(ports.fileSystem, "/app");
      expect(plan.packages).toContain(adapter);
      expect(plan.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([
          ".opencookie-init.json",
          "opencookie.config.ts",
          "opencookie.policy.ts",
          integrationPath,
        ]),
      );
      expect(plan.nextSteps.join("\n")).toContain(integrationPath);
    },
  );

  it("plans correct src-relative Next integration paths for both routers", async () => {
    const app = memoryPorts({
      "package.json": packageJson({ next: "latest", react: "latest" }),
      "src/app/layout.tsx":
        "export default function Layout({ children }) { return <body>{children}</body>; }\n",
      "src/app/page.tsx": "",
    });
    const pages = memoryPorts({
      "package.json": packageJson({ next: "latest", react: "latest" }),
      "pages/index.tsx": "",
    });
    const appPlan = await planInitialization(app.ports.fileSystem, "/app");
    expect(appPlan.framework).toBe("next-app");
    expect(appPlan.files.map((file) => file.path)).toContain(
      "src/app/opencookie-provider.tsx",
    );
    const pagesPlan = await planInitialization(pages.ports.fileSystem, "/app");
    expect(pagesPlan.framework).toBe("next-pages");
    expect(pagesPlan.files.map((file) => file.path)).toContain(
      "opencookie-provider.tsx",
    );
  });

  it("keeps Next JavaScript router integrations under src", async () => {
    const manifest = packageJson({ next: "latest", react: "latest" });
    const app = memoryPorts({
      "package.json": manifest,
      "src/app/layout.js":
        "export default function Layout({ children }) { return <body>{children}</body>; }\n",
      "src/app/page.js": "",
    });
    const pages = memoryPorts({
      "package.json": manifest,
      "src/pages/_app.jsx":
        "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }\n",
    });
    const appPlan = await planInitialization(app.ports.fileSystem, "/app");
    const pagesPlan = await planInitialization(pages.ports.fileSystem, "/app");
    expect(appPlan.files.map((file) => file.path)).toContain(
      "src/app/opencookie-provider.tsx",
    );
    expect(pagesPlan.files.map((file) => file.path)).toContain(
      "src/opencookie-provider.tsx",
    );
  });

  it("uses extensionless local imports in Next source files", async () => {
    const manifest = packageJson({ next: "latest", react: "latest" });
    const app = memoryPorts({
      "package.json": manifest,
      "src/app/layout.tsx":
        "export default function Layout({ children }) { return <body>{children}</body>; }\n",
      "src/app/page.tsx": "",
    });
    const pages = memoryPorts({
      "package.json": manifest,
      "src/pages/_app.tsx":
        "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }\n",
    });

    const appPlan = await planInitialization(app.ports.fileSystem, "/app");
    const pagesPlan = await planInitialization(pages.ports.fileSystem, "/app");
    const appProvider = appPlan.files.find(
      ({ path }) => path === "src/app/opencookie-provider.tsx",
    );
    const pagesProvider = pagesPlan.files.find(
      ({ path }) => path === "src/opencookie-provider.tsx",
    );
    const appConfig = appPlan.files.find(
      ({ path }) => path === "opencookie.config.ts",
    );
    const pagesConfig = pagesPlan.files.find(
      ({ path }) => path === "opencookie.config.ts",
    );

    expect(appPlan.edits[0]?.content).toContain(
      'from "./opencookie-provider";',
    );
    expect(pagesPlan.edits[0]?.content).toContain(
      'from "../opencookie-provider";',
    );
    expect(appProvider?.content).toContain('from "../../opencookie.config";');
    expect(pagesProvider?.content).toContain('from "../opencookie.config";');
    expect(appConfig?.content).toContain('from "./opencookie.policy";');
    expect(pagesConfig?.content).toContain('from "./opencookie.policy";');
    for (const source of [
      appPlan.edits[0]?.content,
      pagesPlan.edits[0]?.content,
      appProvider?.content,
      pagesProvider?.content,
      appConfig?.content,
      pagesConfig?.content,
    ]) {
      expect(source).not.toMatch(
        /opencookie-(?:provider|config)[.]js|opencookie[.]policy[.]js/u,
      );
    }
  });

  it("keeps Next Pages support modules outside the route directory", async () => {
    const manifest = packageJson({ next: "latest", react: "latest" });
    const root = memoryPorts({
      "package.json": manifest,
      "pages/_app.tsx":
        "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }\n",
    });
    const source = memoryPorts({
      "package.json": manifest,
      "src/pages/_app.tsx":
        "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }\n",
    });

    const rootPlan = await planInitialization(root.ports.fileSystem, "/app");
    const sourcePlan = await planInitialization(
      source.ports.fileSystem,
      "/app",
    );
    expect(rootPlan.files.map(({ path }) => path)).toContain(
      "opencookie-provider.tsx",
    );
    expect(sourcePlan.files.map(({ path }) => path)).toContain(
      "src/opencookie-provider.tsx",
    );
    for (const plan of [rootPlan, sourcePlan]) {
      expect(plan.files.map(({ path }) => path)).not.toEqual(
        expect.arrayContaining([
          "pages/opencookie-provider.tsx",
          "src/pages/opencookie-provider.tsx",
        ]),
      );
      expect(plan.edits[0]?.content).toContain(
        'from "../opencookie-provider";',
      );
    }
  });

  it("plans the no-install CDN path and inert demo for plain HTML", async () => {
    const { ports } = memoryPorts({
      "index.html": "<!doctype html><html><body></body></html>\n",
    });
    const plan = await planInitialization(ports.fileSystem, "/site");
    expect(plan.framework).toBe("plain-html");
    expect(plan.installCommand).toBeUndefined();
    expect(plan.packages).toEqual(["@opencookie-dev/vanilla"]);
    expect(
      plan.files.find((file) => file.path === ".opencookie/snippet.html")
        ?.content,
    ).toBe(
      '<script defer src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js" integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS" crossorigin="anonymous" data-oc-policy-version="policy-1" data-oc-storage-key="opencookie.consent" data-oc-purpose-id="analytics" data-oc-purpose-label="Analytics" data-oc-purpose-description="Understand aggregate site usage."></script>\n<script type="text/plain" data-src="/opencookie-demo.js" data-oc-resource="opencookie-demo-script" data-oc-category="analytics"></script>\n',
    );
    expect(plan.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "opencookie-demo.js" }),
      ]),
    );
    expect(plan.files.map((file) => file.path)).not.toEqual(
      expect.arrayContaining([
        ".opencookie/init.js",
        "opencookie.config.ts",
        "opencookie.policy.ts",
      ]),
    );
  });

  it("plans an integrity-bound same-origin bundle for self-hosted plain HTML", async () => {
    const { ports } = memoryPorts({
      "index.html": "<!doctype html><html><body></body></html>\n",
    });
    const bundle = "globalThis.__openCookieSelfHost = true;\n";
    const integrity = sha384Integrity(bundle);
    const plan = await planInitialization(ports.fileSystem, "/site", {
      loadVanillaBrowserAsset: () =>
        Promise.resolve({
          content: bundle,
          integrity,
        }),
      selfHost: true,
    });

    expect(plan.installCommand).toBeUndefined();
    expect(plan.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: bundle,
          path: "vendor/opencookie/auto.iife.js",
        }),
        expect.objectContaining({ path: "opencookie-demo.js" }),
      ]),
    );
    const snippet =
      plan.files.find(({ path }) => path === ".opencookie/snippet.html")
        ?.content ?? "";
    expect(snippet).toContain('src="/vendor/opencookie/auto.iife.js"');
    expect(snippet).toContain(`integrity="${integrity}"`);
    expect(snippet).toContain('data-src="/opencookie-demo.js"');
    expect(snippet).not.toContain("cdn.jsdelivr.net");
    expect(plan.edits[0]?.content).toContain(snippet.trim());
    expect(plan.nextSteps.join("\n")).toMatch(/same-origin|self-host/iu);
  });

  it("rejects missing, malformed, or mismatched installed assets before planning self-hosted plain HTML", async () => {
    const plain = memoryPorts({
      "index.html": "<!doctype html><html><body></body></html>\n",
    });
    await expect(
      planInitialization(plain.ports.fileSystem, "/site", { selfHost: true }),
    ).rejects.toThrow(/installed vanilla browser asset/iu);
    await expect(
      planInitialization(plain.ports.fileSystem, "/site", {
        loadVanillaBrowserAsset: () =>
          Promise.resolve({ content: "bundle", integrity: "sha384-short" }),
        selfHost: true,
      }),
    ).rejects.toThrow(/browser asset is invalid/iu);
    await expect(
      planInitialization(plain.ports.fileSystem, "/site", {
        loadVanillaBrowserAsset: () =>
          Promise.resolve({
            content: "bundle",
            integrity: `sha384-${"A".repeat(64)}`,
          }),
        selfHost: true,
      }),
    ).rejects.toThrow(/integrity does not match/iu);
    await expect(
      planInitialization(plain.ports.fileSystem, "/site", {
        loadVanillaBrowserAsset: () =>
          Promise.resolve({
            content: "",
            integrity: `sha384-${"A".repeat(64)}`,
          }),
        selfHost: true,
      }),
    ).rejects.toThrow(/browser asset is invalid/iu);
  });

  it("rejects the plain-only self-host flag for module applications", async () => {
    const react = memoryPorts({
      "package.json": packageJson({ react: "latest", vite: "latest" }),
      "src/main.tsx": reactEntrypoint,
    });
    await expect(
      planInitialization(react.ports.fileSystem, "/app", {
        loadVanillaBrowserAsset: () =>
          Promise.resolve({ content: "bundle", integrity: "sha384-test" }),
        selfHost: true,
      }),
    ).rejects.toThrow(/plain HTML/u);
  });

  it("keeps required processing out of the rejectable starter purpose set", async () => {
    const react = memoryPorts({
      "package.json": packageJson({ react: "latest", vite: "latest" }),
      "src/main.tsx": reactEntrypoint,
    });
    const plain = memoryPorts({
      "index.html": "<!doctype html><html><body></body></html>\n",
    });
    for (const plan of [
      await planInitialization(react.ports.fileSystem, "/app"),
      await planInitialization(plain.ports.fileSystem, "/site"),
    ]) {
      const generated = plan.files.map((file) => file.content).join("\n");
      expect(generated).toContain("analytics");
      expect(generated).not.toContain('id: "essential"');
      expect(generated).not.toContain("required: true");
    }
  });

  it("emits the current policy snapshot as policy history", async () => {
    const react = memoryPorts({
      "package.json": packageJson({ react: "latest", vite: "latest" }),
      "src/main.tsx": reactEntrypoint,
    });
    const plan = await planInitialization(react.ports.fileSystem, "/app");
    const generatedConfig =
      plan.files.find(({ path }) => path === "opencookie.config.ts")?.content ??
      "";

    expect(generatedConfig).toContain("policyHistory: [policySnapshot],");
  });

  it("emits domain-owned presentation grouping in module starters", async () => {
    const react = memoryPorts({
      "package.json": packageJson({ react: "latest", vite: "latest" }),
      "src/main.tsx": reactEntrypoint,
    });
    const plan = await planInitialization(react.ports.fileSystem, "/app");
    const generatedPolicy =
      plan.files.find(({ path }) => path === "opencookie.policy.ts")?.content ??
      "";

    expect(generatedPolicy).toContain(
      'categories: [\n    { id: "optional", purposeIds: ["analytics"] },\n  ],',
    );
    expect(generatedPolicy).toContain(
      'presentationRootCategoryIds: ["optional"],',
    );
  });

  // This one runs a real strict TypeScript compile over the generated files.
  // It takes 212 ms on its own and 712 ms under coverage, so the default five
  // seconds is not tight; it has timed out only when the whole suite is
  // competing for the machine, which has happened twice under the aggregate
  // gate. The allowance absorbs that contention. It is not a time budget:
  // nothing here measures speed, and a real slowdown would show up in the
  // performance gate rather than here.
  it("emits a starter policy and config that pass strict TypeScript", async () => {
    const react = memoryPorts({
      "package.json": packageJson({ react: "latest", vite: "latest" }),
      "src/main.tsx": reactEntrypoint,
    });
    const plan = await planInitialization(react.ports.fileSystem, "/app");
    const generated = new Map(
      plan.files.map(({ content, path }) => [`/app/${path}`, content]),
    );
    const generatedPolicy = generated.get("/app/opencookie.policy.ts") ?? "";
    const generatedConfig = generated.get("/app/opencookie.config.ts") ?? "";
    for (const requiredDeclaration of [
      "dataCategoryIds",
      "disclosure",
      "operationIds",
      "providerIds",
      "recipientIds",
      "retentionIds",
    ]) {
      expect(generatedPolicy).toContain(requiredDeclaration);
    }
    expect(generatedPolicy).toContain("export const consentDurationMs");
    expect(generatedPolicy).toContain('label: "Analytics"');
    expect(generatedPolicy).toContain("duration-${consentDurationMs}-ms");
    expect(generatedPolicy).not.toContain("180-days");
    expect(generatedConfig).toContain("consentDurationMs,");
    expect(generatedConfig).not.toContain("openCookiePurposes");
    expect(generatedConfig).not.toContain("180 * 24 * 60 * 60 * 1000");

    expect(
      generatedTypeScriptDiagnostics({
        "/app/opencookie.config.ts":
          generated.get("/app/opencookie.config.ts") ?? "",
        "/app/opencookie.policy.ts":
          generated.get("/app/opencookie.policy.ts") ?? "",
        "/app/opencookie.policy.d.ts":
          "export const openCookiePolicy: { purposes: readonly { disclosure: string; id: string }[] };\n",
      }),
    ).toEqual([]);
  }, 120_000);
});

describe("initializeProject", () => {
  const reactFixture = {
    "package.json": packageJson({ react: "latest", vite: "latest" }),
    "pnpm-lock.yaml": "",
    "src/main.tsx": reactEntrypoint,
  };

  it("uses --yes without prompting, installs once, writes files, and prints deterministic next steps", async () => {
    const fixture = memoryPorts(reactFixture);
    const result = await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });
    expect(result.status).toBe("initialized");
    expect(fixture.ports.confirm).not.toHaveBeenCalled();
    expect(fixture.commands).toEqual([
      {
        args: [
          "add",
          "@opencookie-dev/core",
          "@opencookie-dev/react",
          "@opencookie-dev/vanilla",
        ],
        command: "pnpm",
        cwd: "/app",
      },
    ]);
    expect(fixture.files.has("opencookie.config.ts")).toBe(true);
    expect(fixture.ports.writeLine).toHaveBeenCalledWith(
      "OpenCookie initialized for React with Vite.",
    );
  });

  it("asks before changing an app when --yes is absent and can cancel cleanly", async () => {
    const fixture = memoryPorts(reactFixture);
    vi.mocked(fixture.ports.confirm).mockResolvedValue(false);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: false }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.files.has("opencookie.config.ts")).toBe(false);
  });

  // @covers PP-30 REQ-DIAGNOSTIC-DX / TEST-DX-INIT-IDEMPOTENT: a repeated
  // noninteractive init is a no-op rather than a hidden rewrite.
  it("is idempotent and performs no command or write on a second run", async () => {
    const fixture = memoryPorts(reactFixture);
    await initializeProject(fixture.ports, { projectRoot: "/app", yes: true });
    const writesAfterFirstRun = fixture.files.size;
    const second = await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });
    expect(second).toEqual({ framework: "react-vite", status: "unchanged" });
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.files.size).toBe(writesAfterFirstRun);
  });

  // The next steps tell the operator to replace the starter policy, and policy
  // install rewrites that module. Neither makes the project uninitialized, so
  // running init again must leave their files alone rather than refuse.
  it("stays a no-op after the operator changes files it generated", async () => {
    const fixture = memoryPorts(reactFixture);
    await initializeProject(fixture.ports, { projectRoot: "/app", yes: true });
    const installed =
      "// Generated by opencookie policy install from publication p1.\n";
    fixture.files.set("opencookie.policy.ts", installed);
    fixture.files.set(
      "opencookie.config.ts",
      `${fixture.files.get("opencookie.config.ts") ?? ""}// edited\n`,
    );

    const second = await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });

    expect(second).toEqual({ framework: "react-vite", status: "unchanged" });
    expect(fixture.files.get("opencookie.policy.ts")).toBe(installed);
    expect(fixture.files.get("opencookie.config.ts")).toContain("// edited");
    expect(fixture.commands).toHaveLength(1);
  });

  // A write can fail halfway, for example in a read-only directory. The error
  // must say what was already written, and the record that marks a project as
  // initialized must not claim a run that did not finish.
  it("names the files it wrote when a later write fails, and records nothing", async () => {
    const fixture = memoryPorts(reactFixture);
    const writeFile = fixture.ports.fileSystem.writeFile;
    const ports = {
      ...fixture.ports,
      fileSystem: {
        ...fixture.ports.fileSystem,
        writeFile: (
          path: string,
          content: string,
          options?: { readonly mode?: number },
        ) =>
          path.startsWith("src/")
            ? Promise.reject(
                new Error(`EACCES: permission denied, open '${path}'`),
              )
            : writeFile(path, content, options),
      },
    };

    const failed = initializeProject(ports, { projectRoot: "/app", yes: true });

    await expect(failed).rejects.toThrow(/opencookie\.config\.ts/u);
    await expect(failed).rejects.toThrow(/EACCES/u);
    expect(fixture.files.has(".opencookie-init.json")).toBe(false);
  });

  it("still refuses a file of the same name that init did not create", async () => {
    const fixture = memoryPorts({
      ...reactFixture,
      "opencookie.policy.ts": "export const mine = true;\n",
    });

    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(/opencookie.policy.ts/u);
  });

  it("keeps self-hosted plain bytes idempotent and refuses bundle drift", async () => {
    const fixture = memoryPorts({
      "index.html": "<!doctype html><html><body></body></html>\n",
    });
    let asset = {
      content: "globalThis.__openCookieBundle = 1;\n",
      integrity: sha384Integrity("globalThis.__openCookieBundle = 1;\n"),
    };
    const ports: CliPorts = {
      ...fixture.ports,
      loadVanillaBrowserAsset: () => Promise.resolve(asset),
    };

    await expect(
      initializeProject(ports, {
        projectRoot: "/site",
        selfHost: true,
        yes: true,
      }),
    ).resolves.toEqual({ framework: "plain-html", status: "initialized" });
    const afterFirstRun = new Map(fixture.files);
    await expect(
      initializeProject(ports, {
        projectRoot: "/site",
        selfHost: true,
        yes: true,
      }),
    ).resolves.toEqual({ framework: "plain-html", status: "unchanged" });

    asset = {
      content: "globalThis.__openCookieBundle = 2;\n",
      integrity: sha384Integrity("globalThis.__openCookieBundle = 2;\n"),
    };
    await expect(
      initializeProject(ports, {
        projectRoot: "/site",
        selfHost: true,
        yes: true,
      }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.files).toEqual(afterFirstRun);
  });

  it("refuses any conflicting generated file before installing or writing", async () => {
    const fixture = memoryPorts({
      ...reactFixture,
      "opencookie.config.ts": "// user-owned configuration\n",
    });
    const before = new Map(fixture.files);
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow(CliConflictError);
    expect(fixture.commands).toHaveLength(0);
    expect(fixture.files).toEqual(before);
  });

  it("does not write generated files when dependency installation fails", async () => {
    const fixture = memoryPorts(reactFixture);
    fixture.ports.command.run = vi.fn(() =>
      Promise.reject(new Error("install failed")),
    );
    await expect(
      initializeProject(fixture.ports, { projectRoot: "/app", yes: true }),
    ).rejects.toThrow("install failed");
    expect(fixture.files.has("opencookie.config.ts")).toBe(false);
  });

  // Every generated file is already on disk, and only the entrypoint edit is
  // left. An install failure must not invent an empty "it then creates" list.
  it("says to finish when an install fails and only an entrypoint edit remains", async () => {
    const fixture = memoryPorts(reactFixture);
    await initializeProject(fixture.ports, { projectRoot: "/app", yes: true });
    fixture.files.set("src/main.tsx", reactEntrypoint);
    fixture.ports.command.run = () =>
      Promise.reject(new Error("npm exited with code 1."));

    const error = await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toBe(
      "npm exited with code 1. Init wrote nothing. Fix the install and run init again to finish.",
    );
    expect(fixture.files.get("src/main.tsx")).toBe(reactEntrypoint);
  });

  it("holds one project-wide lock before running a package manager", async () => {
    const fixture = memoryPorts(reactFixture);
    let locked = false;
    const fileSystem = fixture.ports.fileSystem;
    Object.defineProperty(fileSystem, "withLock", {
      value: async <Result>(
        _path: string,
        operation: () => Promise<Result>,
      ): Promise<Result> => {
        if (locked) {
          throw new Error("OpenCookie initialization is already running.");
        }
        locked = true;
        try {
          return await operation();
        } finally {
          locked = false;
        }
      },
    });

    let releaseFirst = (): void => undefined;
    const firstCommand = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalStarted = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let calls = 0;
    const runCommand = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        signalStarted();
        return firstCommand;
      }
      return Promise.resolve();
    });
    fixture.ports.command.run = runCommand;

    const first = initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    });
    await firstStarted;
    try {
      await expect(
        initializeProject(fixture.ports, {
          projectRoot: "/app",
          yes: true,
        }),
      ).rejects.toThrow(/already running/i);
      expect(runCommand).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      await first;
    }
  });
});

describe("the installed policy is the one enforced", () => {
  // opencookie policy install rewrites opencookie.policy.ts from the published
  // policy. If the generated config hard-codes a version and a catalogue
  // revision of its own, the runtime keeps enforcing the starter policy and the
  // two drift apart silently.
  it("takes the policy version and catalogue revision from the policy module", async () => {
    const fixture = memoryPorts({
      "package.json": packageJson({ react: "latest", vite: "latest" }),
      "pnpm-lock.yaml": "",
      "src/main.tsx": reactEntrypoint,
    });

    const plan = await planInitialization(fixture.ports.fileSystem, "/app");
    const config = plan.files.find(
      ({ path }) => path === "opencookie.config.ts",
    );
    const policy = plan.files.find(
      ({ path }) => path === "opencookie.policy.ts",
    );

    expect(policy?.content).toContain("export const policyVersion");
    expect(policy?.content).toContain("export const catalogueRevision");
    expect(config?.content).toContain("catalogueRevision,");
    expect(config?.content).toContain("policyVersion,");
    expect(config?.content).not.toContain('"policy-1"');
    expect(config?.content).not.toContain('"catalogue-1"');
  });
});
