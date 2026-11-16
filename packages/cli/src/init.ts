import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { parseSync, visitorKeys } from "oxc-parser";
import { parse, parseFragment } from "parse5";

import type {
  FileSystemPort,
  PackageManager,
  SupportedFramework,
} from "./contracts.js";
import { detectFramework, detectPackageManager } from "./detect.js";

/** A command selected for the consumer's package manager. @public */
export interface CommandInvocation {
  readonly args: readonly string[];
  readonly command: PackageManager;
}

/** Runs a package-manager command without a shell. @public */
export interface CommandPort {
  run(command: string, args: readonly string[], cwd: string): Promise<void>;
}

/** Runtime capabilities used by the initializer. @public */
export interface CliPorts {
  readonly command: CommandPort;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly fileSystem: FileSystemPort;
  readonly loadVanillaBrowserAsset?: () => Promise<VanillaBrowserAsset>;
  readonly writeLine: (line: string) => void;
}

/** Exact installed browser bytes used by plain HTML self-hosting. @public */
export interface VanillaBrowserAsset {
  readonly content: string;
  readonly integrity: `sha384-${string}`;
}

/** One file that the initializer intends to create. @public */
export interface GeneratedFile {
  readonly content: string;
  readonly path: string;
}

/** One existing file replacement guarded by its exact prior contents. @public */
export interface ExistingFileEdit {
  readonly content: string;
  readonly expectedContent: string;
  readonly path: string;
}

/** A complete, inspectable initialization plan. @public */
export interface InitializationPlan {
  readonly edits: readonly ExistingFileEdit[];
  readonly files: readonly GeneratedFile[];
  readonly framework: SupportedFramework;
  readonly installCommand?: CommandInvocation;
  readonly nextSteps: readonly string[];
  readonly packages: readonly string[];
  readonly packageManager: PackageManager;
  readonly projectRoot: string;
}

/** Options accepted by the `init` workflow. @public */
export interface InitializeProjectOptions {
  readonly projectRoot: string;
  readonly selfHost?: boolean;
  readonly yes: boolean;
}

/** Optional delivery mode and asset source for an initialization plan. @public */
export interface PlanInitializationOptions {
  readonly loadVanillaBrowserAsset?: () => Promise<VanillaBrowserAsset>;
  readonly selfHost?: boolean;
}

/** Result of an initialization attempt. @public */
export type InitializeProjectResult =
  | { readonly status: "cancelled" }
  | {
      readonly framework: SupportedFramework;
      readonly status: "initialized" | "unchanged";
    };

/** Existing project files differ from the safe generated contents. @public */
export class CliConflictError extends Error {
  public readonly paths: readonly string[];
  public readonly hint?: string;

  public constructor(paths: readonly string[], hint?: string) {
    const message =
      `OpenCookie did not overwrite existing files: ${paths.join(", ")}. Move or reconcile them, then run init again.` +
      (hint === undefined ? "" : ` ${hint}`);
    super(message);
    this.name = "CliConflictError";
    this.paths = Object.freeze([...paths]);
    if (hint !== undefined) this.hint = hint;
  }
}

/** Maps a package manager to its argument-safe dependency command. @public */
export function buildInstallCommand(
  packageManager: PackageManager,
  packages: readonly string[],
): CommandInvocation {
  return {
    args: [packageManager === "npm" ? "install" : "add", ...packages],
    command: packageManager,
  };
}

const frameworkLabels: Readonly<Record<SupportedFramework, string>> = {
  astro: "Astro",
  "next-app": "Next.js App Router",
  "next-pages": "Next.js Pages Router",
  nuxt: "Nuxt",
  "plain-html": "plain HTML",
  "react-vite": "React with Vite",
  sveltekit: "SvelteKit",
  "vue-vite": "Vue with Vite",
};

const frameworkPackages: Readonly<
  Record<SupportedFramework, readonly string[]>
> = {
  astro: [
    "@opencookie-dev/core",
    "@opencookie-dev/astro",
    "@opencookie-dev/vanilla",
  ],
  "next-app": [
    "@opencookie-dev/core",
    "@opencookie-dev/next",
    "@opencookie-dev/vanilla",
  ],
  "next-pages": [
    "@opencookie-dev/core",
    "@opencookie-dev/next",
    "@opencookie-dev/vanilla",
  ],
  nuxt: [
    "@opencookie-dev/core",
    "@opencookie-dev/nuxt",
    "@opencookie-dev/vanilla",
  ],
  "plain-html": ["@opencookie-dev/vanilla"],
  "react-vite": [
    "@opencookie-dev/core",
    "@opencookie-dev/react",
    "@opencookie-dev/vanilla",
  ],
  sveltekit: [
    "@opencookie-dev/core",
    "@opencookie-dev/svelte",
    "@opencookie-dev/vanilla",
  ],
  "vue-vite": [
    "@opencookie-dev/core",
    "@opencookie-dev/vanilla",
    "@opencookie-dev/vue",
  ],
};

const policyTemplate = `import { definePolicy } from "@opencookie-dev/core";

export const consentDurationMs = 180 * 24 * 60 * 60 * 1000;
const retentionId = \`duration-\${consentDurationMs}-ms\`;

// opencookie policy install replaces this file with the policy you published,
// keeping these two exports, so the runtime always enforces that policy.
export const catalogueRevision = "catalogue-1";
export const policyVersion = "policy-1";

const result = definePolicy({
  categories: [
    { id: "optional", purposeIds: ["analytics"] },
  ],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "aggregate-measurement" }],
  presentationRootCategoryIds: ["optional"],
  providers: [{ id: "site-operator" }],
  purposes: [
    {
      dataCategoryIds: ["usage-event"],
      id: "analytics",
      label: "Analytics",
      disclosure: "Helps understand aggregate site usage when consent is granted.",
      operationIds: ["aggregate-measurement"],
      providerIds: ["site-operator"],
      recipientIds: ["site-operator"],
      retentionIds: [retentionId],
    },
  ],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: retentionId }],
});

if (!result.ok) {
  const issues = result.issues
    .map((issue) => \`\${issue.code} at \${issue.path}\`)
    .join(", ");
  throw new Error(\`The OpenCookie starter policy is invalid: \${issues}.\`);
}

export const openCookiePolicy = result.policy;
`;

const configTemplate = `import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  defineResourcePolicy,
} from "@opencookie-dev/core";
import type { OpenCookieBrowserClientPorts } from "@opencookie-dev/vanilla";

import {
  catalogueRevision,
  consentDurationMs,
  openCookiePolicy,
  policyVersion,
} from "./opencookie.policy.js";

const resourceResult = defineResourcePolicy({
  policy: openCookiePolicy,
  resources: [
    {
      access: "optional",
      id: "opencookie-demo-script",
      purposeIds: ["analytics"],
      serviceId: "opencookie-demo-service",
    },
  ],
  services: [{ id: "opencookie-demo-service" }],
});

if (!resourceResult.ok) {
  const issues = resourceResult.issues
    .map((issue) => \`\${issue.code} at \${issue.path}\`)
    .join(", ");
  throw new Error(
    \`The OpenCookie starter resource policy is invalid: \${issues}.\`,
  );
}
const resourcePolicy = resourceResult.resourcePolicy;

const policySnapshot = createPolicySnapshot({
  catalogueRevision,
  policy: openCookiePolicy,
  policyVersion,
});

export function createOpenCookieClient(ports: OpenCookieBrowserClientPorts) {
  return createOpenCookie({
    consentDurationMs,
    idGenerator: ports.idGenerator,
    now: ports.now,
    policyHistory: [policySnapshot],
    policySnapshot,
    reconcile: ports.reconcile,
    resourcePolicy,
    store: createLocalStorageDecisionStore({
      key: "opencookie.consent",
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      storage: ports.storage,
    }),
  });
}
`;

function configurationTemplate(framework: SupportedFramework): string {
  return framework === "next-app" || framework === "next-pages"
    ? configTemplate.replace(
        'from "./opencookie.policy.js";',
        'from "./opencookie.policy";',
      )
    : configTemplate;
}

function demoScriptAssetPath(framework: SupportedFramework): string {
  return framework === "sveltekit"
    ? "static/opencookie-demo.js"
    : "public/opencookie-demo.js";
}

const plainCdnBootstrapScript =
  '<script defer src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js" integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS" crossorigin="anonymous" data-oc-policy-version="policy-1" data-oc-storage-key="opencookie.consent" data-oc-purpose-id="analytics" data-oc-purpose-label="Analytics" data-oc-purpose-description="Understand aggregate site usage."></script>';

const plainDemoResource =
  '<script type="text/plain" data-src="/opencookie-demo.js" data-oc-resource="opencookie-demo-script" data-oc-category="analytics"></script>';

interface PlainHtmlAssets {
  readonly bootstrapIntegrity: string;
  readonly bootstrapSource: string;
  readonly files: readonly GeneratedFile[];
  readonly includesDemoResource: boolean;
  readonly markup: string;
  readonly selfHosted: boolean;
}

async function plainHtmlAssets(
  options: PlanInitializationOptions,
): Promise<PlainHtmlAssets> {
  if (options.selfHost !== true) {
    return {
      bootstrapIntegrity:
        "sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS",
      bootstrapSource:
        "https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js",
      files: [{ content: demoScriptAsset, path: "opencookie-demo.js" }],
      includesDemoResource: true,
      markup: `${plainCdnBootstrapScript}\n${plainDemoResource}`,
      selfHosted: false,
    };
  }
  if (options.loadVanillaBrowserAsset === undefined) {
    throw new Error(
      "Self-hosted plain HTML initialization requires the installed vanilla browser asset.",
    );
  }
  const asset = await options.loadVanillaBrowserAsset();
  if (
    asset.content.length === 0 ||
    !/^sha384-[A-Za-z\d+/]{64}$/u.test(asset.integrity)
  ) {
    throw new Error("The installed vanilla browser asset is invalid.");
  }
  const actualIntegrity = `sha384-${createHash("sha384")
    .update(asset.content, "utf8")
    .digest("base64")}`;
  if (asset.integrity !== actualIntegrity) {
    throw new Error(
      "The installed vanilla browser asset integrity does not match its content.",
    );
  }
  const bootstrap = `<script defer src="/vendor/opencookie/auto.iife.js" integrity="${asset.integrity}" crossorigin="anonymous" data-oc-policy-version="policy-1" data-oc-storage-key="opencookie.consent" data-oc-purpose-id="analytics" data-oc-purpose-label="Analytics" data-oc-purpose-description="Understand aggregate site usage."></script>`;
  return {
    bootstrapIntegrity: asset.integrity,
    bootstrapSource: "/vendor/opencookie/auto.iife.js",
    files: [
      { content: asset.content, path: "vendor/opencookie/auto.iife.js" },
      { content: demoScriptAsset, path: "opencookie-demo.js" },
    ],
    includesDemoResource: true,
    markup: `${bootstrap}\n${plainDemoResource}`,
    selfHosted: true,
  };
}

const demoScriptAsset = `globalThis.__openCookieDemoRuns =
  (globalThis.__openCookieDemoRuns ?? 0) + 1;
`;

const imperativeDemoResource = `const openCookieDemoResourceSelector =
  'script[type="text/plain"][data-src="/opencookie-demo.js"][data-oc-resource="opencookie-demo-script"][data-oc-category="analytics"]';

function installOpenCookieDemoResource(): () => void {
  if (document.querySelector(openCookieDemoResourceSelector) !== null) {
    return () => undefined;
  }
  const source = document.createElement("script");
  source.type = "text/plain";
  source.dataset["src"] = "/opencookie-demo.js";
  source.dataset["ocResource"] = "opencookie-demo-script";
  source.dataset["ocCategory"] = "analytics";
  document.body.append(source);
  return () => source.remove();
}
`;

function reactIntegration(importPath: string, packageName: string): string {
  return `"use client";

import { OpenCookieProvider } from "${packageName}";
import { createOpenCookieBrowserBinding } from "@opencookie-dev/vanilla";
import { useEffect, useState, type ReactNode } from "react";

import { createOpenCookieClient } from "${importPath}";

function reportOpenCookieError(error: unknown): void {
  console.error("OpenCookie browser initialization failed.", error);
}

export function OpenCookieRoot({ children }: { children: ReactNode }) {
  const [binding] = useState(() => createOpenCookieBrowserBinding({
    createClient: createOpenCookieClient,
  }));
  useEffect(() => {
    const mounted = binding.mount({ onError: reportOpenCookieError });
    void mounted.ready.catch(reportOpenCookieError);
    return mounted.destroy;
  }, [binding]);
  return (
    <OpenCookieProvider store={binding.client}>
      {children}
      <script
        type="text/plain"
        data-src="/opencookie-demo.js"
        data-oc-resource="opencookie-demo-script"
        data-oc-category="analytics"
      ></script>
    </OpenCookieProvider>
  );
}
`;
}

const NEXT_APP_ROOT_ENTRYPOINTS = [
  "app/page.js",
  "app/page.jsx",
  "app/page.ts",
  "app/page.tsx",
] as const;
const NEXT_APP_SRC_ENTRYPOINTS = NEXT_APP_ROOT_ENTRYPOINTS.map(
  (path) => `src/${path}`,
);
const NEXT_PAGES_ROOT_ENTRYPOINTS = [
  "pages/_app.js",
  "pages/_app.jsx",
  "pages/_app.ts",
  "pages/_app.tsx",
  "pages/index.js",
  "pages/index.jsx",
  "pages/index.ts",
  "pages/index.tsx",
] as const;
const NEXT_PAGES_SRC_ENTRYPOINTS = NEXT_PAGES_ROOT_ENTRYPOINTS.map(
  (path) => `src/${path}`,
);

async function existingPaths(
  fileSystem: FileSystemPort,
  paths: readonly string[],
): Promise<readonly string[]> {
  const found: string[] = [];
  for (const path of paths) {
    if (await fileSystem.exists(path)) found.push(path);
  }
  return found;
}

async function nextRouterRoot(
  fileSystem: FileSystemPort,
  router: "app" | "pages",
): Promise<"app" | "pages" | "src/app" | "src/pages"> {
  const rootCandidates =
    router === "app" ? NEXT_APP_ROOT_ENTRYPOINTS : NEXT_PAGES_ROOT_ENTRYPOINTS;
  const srcCandidates =
    router === "app" ? NEXT_APP_SRC_ENTRYPOINTS : NEXT_PAGES_SRC_ENTRYPOINTS;
  const [rootDirectory, srcDirectory, rootFiles, srcFiles] = await Promise.all([
    fileSystem.exists(router),
    fileSystem.exists(`src/${router}`),
    existingPaths(fileSystem, rootCandidates),
    existingPaths(fileSystem, srcCandidates),
  ]);
  if (rootDirectory || rootFiles.length > 0) return router;
  if (srcDirectory || srcFiles.length > 0) return `src/${router}`;
  throw new CliConflictError([`${router}/page.tsx`]);
}

function integrationFiles(
  framework: SupportedFramework,
  fileSystem: FileSystemPort,
  plainAssets?: PlainHtmlAssets,
): Promise<readonly GeneratedFile[]> {
  switch (framework) {
    case "react-vite":
      return Promise.resolve([
        {
          content: reactIntegration(
            "../opencookie.config.js",
            "@opencookie-dev/react",
          ),
          path: "src/opencookie.tsx",
        },
      ]);
    case "vue-vite":
      return Promise.resolve([
        {
          content: `import { createOpenCookiePlugin } from "@opencookie-dev/vue";
import {
  createOpenCookieBrowserBinding,
  type MountedOpenCookie,
  type OpenCookieBrowserBinding,
} from "@opencookie-dev/vanilla";
import type { App, Plugin } from "vue";

import { createOpenCookieClient } from "../opencookie.config.js";

${imperativeDemoResource}
let latestReady: Promise<void> | undefined;

function reportOpenCookieError(error: unknown): void {
  console.error("OpenCookie browser initialization failed.", error);
}

export const openCookiePlugin: Plugin = Object.freeze({
  install(app: App): void {
    const binding: OpenCookieBrowserBinding = createOpenCookieBrowserBinding({
      createClient: createOpenCookieClient,
    });
    app.use(createOpenCookiePlugin(binding.client));
    const removeDemoResource = installOpenCookieDemoResource();
    let mounted: MountedOpenCookie;
    try {
      mounted = binding.mount({ onError: reportOpenCookieError });
    } catch (error) {
      removeDemoResource();
      throw error;
    }
    const ready = mounted.ready.catch(reportOpenCookieError);
    latestReady = ready;
    app.onUnmount(() => {
      mounted.destroy();
      removeDemoResource();
      if (latestReady === ready) latestReady = undefined;
    });
  },
});

export function initializeOpenCookie(): Promise<void> {
  return latestReady ?? Promise.reject(
    new Error("Install the OpenCookie Vue plugin before initialization."),
  );
}
`,
          path: "src/opencookie.ts",
        },
      ]);
    case "next-app":
      return nextRouterRoot(fileSystem, "app").then((root) => {
        const usesSrc = root.startsWith("src/");
        const path = `${root}/opencookie-provider.tsx`;
        return [
          {
            content: reactIntegration(
              usesSrc ? "../../opencookie.config" : "../opencookie.config",
              "@opencookie-dev/next",
            ),
            path,
          },
        ];
      });
    case "next-pages":
      return nextRouterRoot(fileSystem, "pages").then((root) => {
        const usesSrc = root.startsWith("src/");
        const path = usesSrc
          ? "src/opencookie-provider.tsx"
          : "opencookie-provider.tsx";
        return [
          {
            content: reactIntegration(
              usesSrc ? "../opencookie.config" : "./opencookie.config",
              "@opencookie-dev/next",
            ),
            path,
          },
        ];
      });
    case "nuxt":
      return Promise.resolve([
        {
          content: `import type { OpenCookieNuxtApp } from "@opencookie-dev/nuxt/runtime";
import {
  createOpenCookieBrowserBinding,
  type MountedOpenCookie,
} from "@opencookie-dev/vanilla";

import { createOpenCookieClient } from "./opencookie.config.js";

${imperativeDemoResource}
function reportOpenCookieError(error: unknown): void {
  console.error("OpenCookie browser initialization failed.", error);
}

export default function createOpenCookieStore(nuxtApp: OpenCookieNuxtApp) {
  const binding = createOpenCookieBrowserBinding({
    createClient: createOpenCookieClient,
  });
  let mounted: MountedOpenCookie | undefined;
  let removeDemoResource: (() => void) | undefined;

  nuxtApp.hook("app:mounted", () => {
    removeDemoResource = installOpenCookieDemoResource();
    try {
      mounted = binding.mount({ onError: reportOpenCookieError });
    } catch (error) {
      removeDemoResource();
      removeDemoResource = undefined;
      throw error;
    }
    return mounted.ready.catch(reportOpenCookieError);
  });
  nuxtApp.vueApp.onUnmount(() => {
    mounted?.destroy();
    removeDemoResource?.();
    mounted = undefined;
    removeDemoResource = undefined;
  });

  return binding.client;
}
`,
          path: "opencookie-store.ts",
        },
      ]);
    case "sveltekit":
      return Promise.resolve([
        {
          content: `<script lang="ts">
  import { setOpenCookieContext } from "@opencookie-dev/svelte";
  import { createOpenCookieBrowserBinding } from "@opencookie-dev/vanilla";
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import { createOpenCookieClient } from "../../opencookie.config.js";

  let { children }: { children: Snippet } = $props();

  const binding = createOpenCookieBrowserBinding({
    createClient: createOpenCookieClient,
  });
  setOpenCookieContext(binding.client);

  function reportOpenCookieError(error: unknown): void {
    console.error("OpenCookie browser initialization failed.", error);
  }

  onMount(() => {
    const mounted = binding.mount({ onError: reportOpenCookieError });
    void mounted.ready.catch(reportOpenCookieError);
    return mounted.destroy;
  });
</script>

<svelte:element
  this={"script"}
  type="text/plain"
  data-src="/opencookie-demo.js"
  data-oc-resource="opencookie-demo-script"
  data-oc-category="analytics"
></svelte:element>
{@render children()}
`,
          path: "src/lib/OpenCookieProvider.svelte",
        },
      ]);
    case "astro":
      return Promise.resolve([
        {
          content: `import {
  createOpenCookieBrowserBinding,
  type MountedOpenCookie,
} from "@opencookie-dev/vanilla";

import { createOpenCookieClient } from "../opencookie.config.js";

${imperativeDemoResource}
const binding = createOpenCookieBrowserBinding({
  createClient: createOpenCookieClient,
});
let mounted: MountedOpenCookie | undefined;
let removeDemoResource: (() => void) | undefined;

function reportOpenCookieError(error: unknown): void {
  console.error("OpenCookie browser initialization failed.", error);
}

function startOpenCookiePage(): void {
  if (mounted !== undefined) return;
  removeDemoResource = installOpenCookieDemoResource();
  try {
    mounted = binding.mount({ onError: reportOpenCookieError });
  } catch (error) {
    removeDemoResource();
    removeDemoResource = undefined;
    throw error;
  }
  void mounted.ready.catch(reportOpenCookieError);
}

function stopOpenCookiePage(): void {
  if (mounted !== undefined) mounted.destroy();
  removeDemoResource?.();
  mounted = undefined;
  removeDemoResource = undefined;
}

document.addEventListener("astro:before-swap", stopOpenCookiePage);
document.addEventListener("astro:page-load", startOpenCookiePage);
startOpenCookiePage();
`,
          path: "src/opencookie.client.ts",
        },
        {
          content: `import openCookie from "@opencookie-dev/astro";

export default openCookie({ entrypoint: "/src/opencookie.client.ts" });
`,
          path: "opencookie.astro.config.mjs",
        },
      ]);
    case "plain-html":
      if (plainAssets === undefined) {
        throw new Error("Plain HTML assets were not prepared.");
      }
      return Promise.resolve([
        {
          content: `${plainAssets.markup}\n`,
          path: ".opencookie/snippet.html",
        },
      ]);
  }
}

interface WiringChanges {
  readonly edits: readonly ExistingFileEdit[];
  readonly files: readonly GeneratedFile[];
  readonly managedPaths?: readonly string[];
}

function edit(
  path: string,
  expectedContent: string,
  content: string,
): ExistingFileEdit {
  return { content, expectedContent, path };
}

function validateExistingMarker(
  path: string,
  content: string,
  expectedFragments: Readonly<Record<string, string>>,
  validateWiring: () => boolean,
): boolean {
  const markers = sourceMarkers(path, content);
  if (markers.length === 0) return false;
  const stack: SourceMarker[] = [];
  const seen = new Set<string>();
  const ownedRanges = new Map<string, SourceRange>();
  for (const marker of markers) {
    if (!marker.closing) {
      if (seen.has(marker.label)) throw new CliConflictError([path]);
      seen.add(marker.label);
      stack.push(marker);
    } else {
      const opening = stack.pop();
      if (opening?.label !== marker.label) {
        throw new CliConflictError([path]);
      }
      ownedRanges.set(marker.label, {
        end: marker.start,
        start: opening.end,
      });
    }
  }
  if (stack.length > 0) {
    throw new CliConflictError([path]);
  }
  const expectedLabels = Object.keys(expectedFragments);
  if (
    seen.size !== expectedLabels.length ||
    expectedLabels.some((label) => !seen.has(label))
  ) {
    throw new CliConflictError([path]);
  }
  for (const [label, fragment] of Object.entries(expectedFragments)) {
    const range = ownedRanges.get(label);
    if (
      range === undefined ||
      content.slice(range.start, range.end).trim() !== fragment.trim()
    ) {
      throw new CliConflictError([path]);
    }
  }
  if (validateWiring()) return true;
  throw new CliConflictError([path]);
}

function replacePatternExactlyOnce(
  path: string,
  content: string,
  pattern: RegExp,
  replacement: (match: RegExpMatchArray) => string,
  eligible: (
    match: RegExpMatchArray,
    parsed: ParsedJavaScript,
  ) => boolean = () => true,
): string {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const parsed = parseJavaScript(path, content);
  const matches = [
    ...content.matchAll(new RegExp(pattern.source, flags)),
  ].filter(
    (match) =>
      !parsed.protectedRanges.some((range) =>
        rangeContains(range, match.index, match.index + match[0].length),
      ) && eligible(match, parsed),
  );
  if (matches.length !== 1) throw new CliConflictError([path]);
  const match = matches[0] as RegExpMatchArray;
  const matchIndex = match.index ?? 0;
  return `${content.slice(0, matchIndex)}${replacement(match)}${content.slice(matchIndex + match[0].length)}`;
}

interface SourceRange {
  readonly end: number;
  readonly start: number;
}

interface ParsedJavaScript {
  readonly comments: readonly SourceComment[];
  readonly nodes: readonly SyntaxNodeVisit[];
  readonly parentByNode: WeakMap<SyntaxNode, SyntaxNode>;
  readonly protectedRanges: readonly SourceRange[];
  readonly program: SyntaxNode;
}

interface SourceComment extends SourceRange {
  readonly value: string;
}

type SyntaxNode = Readonly<Record<string, unknown>> & {
  readonly end: number;
  readonly start: number;
  readonly type: string;
};

interface SyntaxNodeVisit {
  readonly node: SyntaxNode;
  readonly parent?: SyntaxNode;
}

const PROTECTED_SYNTAX_NODES = new Set([
  "JSXText",
  "RegExpLiteral",
  "StringLiteral",
  "TemplateElement",
  "TemplateLiteral",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isProtectedSyntaxNode(
  value: Readonly<Record<string, unknown>>,
): boolean {
  const type = value["type"];
  if (typeof type !== "string") return false;
  if (PROTECTED_SYNTAX_NODES.has(type)) return true;
  return (
    type === "Literal" &&
    (typeof value["value"] === "string" || "regex" in value)
  );
}

function sourceRange(
  value: Readonly<Record<string, unknown>>,
): SourceRange | undefined {
  const start = value["start"];
  const end = value["end"];
  return typeof start === "number" && typeof end === "number"
    ? { end, start }
    : undefined;
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    isRecord(value) &&
    typeof value["type"] === "string" &&
    typeof value["start"] === "number" &&
    typeof value["end"] === "number"
  );
}

function rangeContains(
  range: SourceRange,
  start: number,
  end: number,
): boolean {
  return range.start <= start && end <= range.end;
}

function syntaxVisits(program: SyntaxNode): {
  readonly parentByNode: WeakMap<SyntaxNode, SyntaxNode>;
  readonly visits: readonly SyntaxNodeVisit[];
} {
  const visits: SyntaxNodeVisit[] = [];
  const parentByNode = new WeakMap<SyntaxNode, SyntaxNode>();
  const pending: { readonly parent?: SyntaxNode; readonly node: SyntaxNode }[] =
    [{ node: program }];
  const visited = new WeakSet();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    if (visited.has(current.node)) continue;
    visited.add(current.node);
    if (current.parent !== undefined) {
      parentByNode.set(current.node, current.parent);
    }
    visits.push({
      node: current.node,
      ...(current.parent === undefined ? {} : { parent: current.parent }),
    });
    for (const key of visitorKeys[current.node.type] ?? []) {
      const value = current.node[key];
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          const child: unknown = value[index];
          if (isSyntaxNode(child)) {
            pending.push({ node: child, parent: current.node });
          }
        }
      } else if (isSyntaxNode(value)) {
        pending.push({ node: value, parent: current.node });
      }
    }
  }
  return { parentByNode, visits };
}

function parseJavaScript(
  path: string,
  content: string,
  language: "ts" | "tsx" = "tsx",
): ParsedJavaScript {
  const parsed = parseSync(path, content, {
    lang: language,
    range: false,
    sourceType: "unambiguous",
  });
  if (parsed.errors.length > 0) throw new CliConflictError([path]);
  if (!isSyntaxNode(parsed.program)) throw new CliConflictError([path]);

  const comments = parsed.comments.map(({ end, start, value }) => ({
    end,
    start,
    value,
  }));
  const traversal = syntaxVisits(parsed.program);
  const ranges: SourceRange[] = [
    ...comments,
    ...traversal.visits.flatMap(({ node }) => {
      if (!isProtectedSyntaxNode(node)) return [];
      const range = sourceRange(node);
      return range === undefined ? [] : [range];
    }),
  ];
  return {
    comments,
    nodes: traversal.visits,
    parentByNode: traversal.parentByNode,
    program: parsed.program,
    protectedRanges: ranges,
  };
}

function matchRange(match: RegExpMatchArray): SourceRange {
  const start = match.index ?? 0;
  return { end: start + match[0].length, start };
}

function childNode(node: SyntaxNode, key: string): SyntaxNode | undefined {
  const value = node[key];
  return isSyntaxNode(value) ? value : undefined;
}

function identifierName(node: SyntaxNode | undefined): string | undefined {
  return node?.type === "Identifier" && typeof node["name"] === "string"
    ? node["name"]
    : undefined;
}

function callArguments(node: SyntaxNode): readonly SyntaxNode[] {
  const values = node["arguments"];
  return Array.isArray(values) ? values.filter(isSyntaxNode) : [];
}

function nodeArray(node: SyntaxNode, key: string): readonly SyntaxNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isSyntaxNode) : [];
}

const EXPRESSION_WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function unwrapExpression(
  node: SyntaxNode | undefined,
): SyntaxNode | undefined {
  let current = node;
  const seen = new Set<SyntaxNode>();
  while (
    current !== undefined &&
    EXPRESSION_WRAPPERS.has(current.type) &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = childNode(current, "expression");
  }
  return current;
}

function uniqueNode(path: string, nodes: readonly SyntaxNode[]): SyntaxNode {
  if (nodes.length !== 1) throw new CliConflictError([path]);
  return nodes[0] as SyntaxNode;
}

function spliceNode(
  content: string,
  node: SourceRange,
  replacement: string,
): string {
  return `${content.slice(0, node.start)}${replacement}${content.slice(node.end)}`;
}

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

function nearestFunction(
  node: SyntaxNode,
  parsed: ParsedJavaScript,
): SyntaxNode | undefined {
  let current = parsed.parentByNode.get(node);
  while (current !== undefined) {
    if (FUNCTION_NODE_TYPES.has(current.type)) return current;
    current = parsed.parentByNode.get(current);
  }
  return undefined;
}

function defaultExportFunction(
  path: string,
  parsed: ParsedJavaScript,
): SyntaxNode {
  const exported = uniqueNode(
    path,
    parsed.nodes
      .filter(
        ({ node, parent }) =>
          node.type === "ExportDefaultDeclaration" &&
          parent?.type === "Program",
      )
      .map(({ node }) => node),
  );
  const declaration = unwrapExpression(childNode(exported, "declaration"));
  if (declaration === undefined || !FUNCTION_NODE_TYPES.has(declaration.type)) {
    throw new CliConflictError([path]);
  }
  return declaration;
}

function directReturnArgument(
  path: string,
  parsed: ParsedJavaScript,
  functionNode: SyntaxNode,
): SyntaxNode {
  if (functionNode.type === "ArrowFunctionExpression") {
    const body = unwrapExpression(childNode(functionNode, "body"));
    if (body === undefined || body.type === "BlockStatement") {
      throw new CliConflictError([path]);
    }
    return body;
  }
  const returned = uniqueNode(
    path,
    parsed.nodes
      .filter(
        ({ node }) =>
          node.type === "ReturnStatement" &&
          nearestFunction(node, parsed) === functionNode,
      )
      .map(({ node }) => node),
  );
  const argument = unwrapExpression(childNode(returned, "argument"));
  if (argument === undefined) throw new CliConflictError([path]);
  return argument;
}

function jsxName(node: SyntaxNode | undefined): string | undefined {
  return node?.type === "JSXIdentifier" && typeof node["name"] === "string"
    ? node["name"]
    : undefined;
}

function jsxElementName(node: SyntaxNode | undefined): string | undefined {
  if (node?.type !== "JSXElement") return undefined;
  const opening = childNode(node, "openingElement");
  return opening === undefined
    ? undefined
    : jsxName(childNode(opening, "name"));
}

function jsxOpeningElement(node: SyntaxNode): SyntaxNode | undefined {
  return node.type === "JSXElement"
    ? childNode(node, "openingElement")
    : undefined;
}

function semanticJsxChildren(node: SyntaxNode): readonly SyntaxNode[] {
  return nodeArray(node, "children").filter(
    (child) =>
      child.type !== "JSXText" ||
      (typeof child["value"] === "string" && child["value"].trim().length > 0),
  );
}

function hasNoJsxAttributes(node: SyntaxNode): boolean {
  const opening = jsxOpeningElement(node);
  return opening !== undefined && nodeArray(opening, "attributes").length === 0;
}

function isBareAppElement(node: SyntaxNode | undefined): boolean {
  if (jsxElementName(node) !== "App" || node === undefined) return false;
  const opening = jsxOpeningElement(node);
  return (
    opening?.["selfClosing"] === true &&
    hasNoJsxAttributes(node) &&
    semanticJsxChildren(node).length === 0
  );
}

function isCanonicalReactRoot(node: SyntaxNode | undefined): boolean {
  if (isBareAppElement(node)) return true;
  if (
    node === undefined ||
    jsxElementName(node) !== "StrictMode" ||
    !hasNoJsxAttributes(node)
  ) {
    return false;
  }
  const children = semanticJsxChildren(node);
  return children.length === 1 && isBareAppElement(children[0]);
}

function isProviderAround(
  node: SyntaxNode | undefined,
  childPredicate: (child: SyntaxNode | undefined) => boolean,
): boolean {
  if (
    node === undefined ||
    jsxElementName(node) !== "OpenCookieRoot" ||
    !hasNoJsxAttributes(node)
  ) {
    return false;
  }
  const children = semanticJsxChildren(node);
  return children.length === 1 && childPredicate(children[0]);
}

function isProviderElement(node: SyntaxNode | undefined): boolean {
  if (
    node === undefined ||
    jsxElementName(node) !== "OpenCookieRoot" ||
    !hasNoJsxAttributes(node)
  ) {
    return false;
  }
  return true;
}

function isProviderInsideBody(parsed: ParsedJavaScript): boolean {
  return parsed.nodes.some(({ node: body }) => {
    if (body.type !== "JSXElement" || jsxElementName(body) !== "body") {
      return false;
    }
    return parsed.nodes.some(({ node: provider }) => {
      if (
        provider.type !== "JSXElement" ||
        !isProviderElement(provider) ||
        !rangeContains(body, provider.start, provider.end)
      ) {
        return false;
      }
      return parsed.nodes.some(
        ({ node: child, parent }) =>
          parent?.type === "JSXElement" &&
          rangeContains(provider, child.start, child.end) &&
          isChildrenExpression(child),
      );
    });
  });
}

function hasAnyFunctionBinding(
  parsed: ParsedJavaScript,
  target: string,
): boolean {
  return parsed.nodes.some(
    ({ node }) =>
      FUNCTION_NODE_TYPES.has(node.type) &&
      functionBindingNames(parsed, node).has(target),
  );
}

function topLevelReactRenderArgument(
  path: string,
  parsed: ParsedJavaScript,
): SyntaxNode {
  if (!hasReactScaffoldOwnership(parsed)) throw new CliConflictError([path]);
  const calls = parsed.nodes
    .filter(({ node, parent }) => {
      if (node.type !== "ExpressionStatement" || parent?.type !== "Program") {
        return false;
      }
      const expression = unwrapExpression(childNode(node, "expression"));
      if (expression?.type !== "CallExpression") return false;
      const member = childNode(expression, "callee");
      if (
        member?.type !== "MemberExpression" ||
        member["computed"] === true ||
        identifierName(childNode(member, "property")) !== "render"
      ) {
        return false;
      }
      const rootCall = unwrapExpression(childNode(member, "object"));
      return (
        rootCall?.type === "CallExpression" &&
        identifierName(childNode(rootCall, "callee")) === "createRoot"
      );
    })
    .map(({ node }) => unwrapExpression(childNode(node, "expression")))
    .filter(isSyntaxNode);
  const call = uniqueNode(path, calls);
  const args = callArguments(call);
  if (args.length !== 1 || args[0]?.type === "SpreadElement") {
    throw new CliConflictError([path]);
  }
  const argument = unwrapExpression(args[0]);
  if (argument === undefined) throw new CliConflictError([path]);
  return argument;
}

function literalString(node: SyntaxNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node["value"] === "string") {
    return node["value"];
  }
  return undefined;
}

function hasNamedImport(
  parsed: ParsedJavaScript,
  source: string,
  importedName: string,
  localName = importedName,
): boolean {
  return parsed.nodes.some(({ node, parent }) => {
    if (node.type !== "ImportDeclaration" || parent?.type !== "Program") {
      return false;
    }
    if (node["importKind"] === "type") return false;
    if (literalString(childNode(node, "source")) !== source) return false;
    return nodeArray(node, "specifiers").some(
      (specifier) =>
        specifier.type === "ImportSpecifier" &&
        specifier["importKind"] !== "type" &&
        identifierName(childNode(specifier, "imported")) === importedName &&
        identifierName(childNode(specifier, "local")) === localName,
    );
  });
}

function hasDefaultImport(
  parsed: ParsedJavaScript,
  source: string,
  localName: string,
): boolean {
  return parsed.nodes.some(({ node, parent }) => {
    if (node.type !== "ImportDeclaration" || parent?.type !== "Program") {
      return false;
    }
    if (node["importKind"] === "type") return false;
    if (literalString(childNode(node, "source")) !== source) return false;
    return nodeArray(node, "specifiers").some(
      (specifier) =>
        specifier.type === "ImportDefaultSpecifier" &&
        identifierName(childNode(specifier, "local")) === localName,
    );
  });
}

function hasDefaultImportFrom(
  parsed: ParsedJavaScript,
  sources: ReadonlySet<string>,
  localName: string,
): boolean {
  return parsed.nodes.some(({ node, parent }) => {
    if (node.type !== "ImportDeclaration" || parent?.type !== "Program") {
      return false;
    }
    if (node["importKind"] === "type") return false;
    const source = literalString(childNode(node, "source"));
    if (source === undefined || !sources.has(source)) return false;
    return nodeArray(node, "specifiers").some(
      (specifier) =>
        specifier.type === "ImportDefaultSpecifier" &&
        identifierName(childNode(specifier, "local")) === localName,
    );
  });
}

function bindingPatternNames(node: SyntaxNode | undefined): readonly string[] {
  if (node === undefined) return [];
  const name = identifierName(node);
  if (name !== undefined) return [name];
  if (node.type === "AssignmentPattern") {
    return bindingPatternNames(childNode(node, "left"));
  }
  if (node.type === "RestElement") {
    return bindingPatternNames(childNode(node, "argument"));
  }
  if (node.type === "ArrayPattern") {
    return nodeArray(node, "elements").flatMap(bindingPatternNames);
  }
  if (node.type === "ObjectPattern") {
    return nodeArray(node, "properties").flatMap((property) =>
      property.type === "Property"
        ? bindingPatternNames(childNode(property, "value"))
        : bindingPatternNames(childNode(property, "argument")),
    );
  }
  return [];
}

function declarationBindingNames(node: SyntaxNode): readonly string[] {
  if (node.type === "ImportDeclaration") {
    return nodeArray(node, "specifiers").flatMap((specifier) =>
      bindingPatternNames(childNode(specifier, "local")),
    );
  }
  if (node.type === "VariableDeclaration") {
    return nodeArray(node, "declarations").flatMap((declaration) =>
      bindingPatternNames(childNode(declaration, "id")),
    );
  }
  if (
    node.type === "ClassDeclaration" ||
    node.type === "FunctionDeclaration" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSEnumDeclaration" ||
    node.type === "TSImportEqualsDeclaration" ||
    node.type === "TSInterfaceDeclaration" ||
    node.type === "TSModuleDeclaration" ||
    node.type === "TSTypeAliasDeclaration"
  ) {
    return bindingPatternNames(childNode(node, "id"));
  }
  return [];
}

function hasProgramVarScope(
  node: SyntaxNode,
  parsed: ParsedJavaScript,
): boolean {
  let current = parsed.parentByNode.get(node);
  while (current !== undefined) {
    if (current.type === "Program") return true;
    if (
      FUNCTION_NODE_TYPES.has(current.type) ||
      current.type === "StaticBlock" ||
      current.type === "TSModuleBlock"
    ) {
      return false;
    }
    current = parsed.parentByNode.get(current);
  }
  return false;
}

function moduleBindingNames(parsed: ParsedJavaScript): readonly string[] {
  const names: string[] = [];
  const directDeclarations = new Set<SyntaxNode>();
  for (const statement of nodeArray(parsed.program, "body")) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? childNode(statement, "declaration")
        : statement;
    if (declaration === undefined) continue;
    directDeclarations.add(declaration);
    names.push(
      ...(declaration.type === "TSInterfaceDeclaration" ||
      declaration.type === "TSTypeAliasDeclaration"
        ? []
        : declarationBindingNames(declaration)),
    );
  }
  for (const { node } of parsed.nodes) {
    if (
      node.type !== "VariableDeclaration" ||
      node["kind"] !== "var" ||
      directDeclarations.has(node) ||
      !hasProgramVarScope(node, parsed)
    ) {
      continue;
    }
    names.push(...declarationBindingNames(node));
  }
  return names;
}

function valueDeclarationBindingNames(node: SyntaxNode): readonly string[] {
  if (
    node.type === "TSInterfaceDeclaration" ||
    node.type === "TSTypeAliasDeclaration" ||
    node["declare"] === true
  ) {
    return [];
  }
  if (node.type !== "ImportDeclaration") {
    return declarationBindingNames(node);
  }
  if (node["importKind"] === "type") return [];
  return nodeArray(node, "specifiers").flatMap((specifier) => {
    if (specifier["importKind"] === "type") return [];
    const local = identifierName(childNode(specifier, "local"));
    return local === undefined ? [] : [local];
  });
}

function moduleValueBindingNames(parsed: ParsedJavaScript): readonly string[] {
  const names: string[] = [];
  const directDeclarations = new Set<SyntaxNode>();
  for (const statement of nodeArray(parsed.program, "body")) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? childNode(statement, "declaration")
        : statement;
    if (declaration === undefined) continue;
    directDeclarations.add(declaration);
    names.push(...valueDeclarationBindingNames(declaration));
  }
  for (const { node } of parsed.nodes) {
    if (
      node.type !== "VariableDeclaration" ||
      node["kind"] !== "var" ||
      node["declare"] === true ||
      directDeclarations.has(node) ||
      !hasProgramVarScope(node, parsed)
    ) {
      continue;
    }
    names.push(...declarationBindingNames(node));
  }
  return names;
}

function moduleValueBindingCount(
  parsed: ParsedJavaScript,
  target: string,
): number {
  return moduleValueBindingNames(parsed).filter((name) => name === target)
    .length;
}

function moduleBindingCount(parsed: ParsedJavaScript, target: string): number {
  return moduleBindingNames(parsed).filter((name) => name === target).length;
}

function hasExclusiveModuleBinding(
  parsed: ParsedJavaScript,
  target: string,
): boolean {
  return moduleBindingCount(parsed, target) === 1;
}

function functionBindingNames(
  parsed: ParsedJavaScript,
  functionNode: SyntaxNode,
): ReadonlySet<string> {
  const names = new Set<string>();
  const selfName = identifierName(childNode(functionNode, "id"));
  if (selfName !== undefined) names.add(selfName);
  for (const parameter of nodeArray(functionNode, "params")) {
    for (const name of bindingPatternNames(parameter)) names.add(name);
  }
  for (const { node } of parsed.nodes) {
    if (
      node === functionNode ||
      nearestFunction(node, parsed) !== functionNode
    ) {
      continue;
    }
    const declared =
      node.type === "CatchClause"
        ? bindingPatternNames(childNode(node, "param"))
        : node.type === "TSInterfaceDeclaration" ||
            node.type === "TSTypeAliasDeclaration"
          ? []
          : declarationBindingNames(node);
    for (const name of declared) names.add(name);
  }
  return names;
}

function assertBindingsAvailable(
  path: string,
  parsed: ParsedJavaScript,
  names: readonly string[],
  hint?: string,
): void {
  const existing = new Set(moduleBindingNames(parsed));
  if (names.some((name) => existing.has(name))) {
    throw new CliConflictError([path], hint);
  }
}

function assertFunctionBindingsAvailable(
  path: string,
  parsed: ParsedJavaScript,
  functionNode: SyntaxNode,
  names: readonly string[],
  hint?: string,
): void {
  const existing = functionBindingNames(parsed, functionNode);
  if (names.some((name) => existing.has(name))) {
    throw new CliConflictError([path], hint);
  }
}

const REACT_APP_IMPORTS = new Set([
  "./App",
  "./App.js",
  "./App.jsx",
  "./App.ts",
  "./App.tsx",
]);
const VUE_APP_IMPORTS = new Set(["./App.vue"]);

function hasReactScaffoldOwnership(parsed: ParsedJavaScript): boolean {
  return (
    hasNamedImport(parsed, "react-dom/client", "createRoot") &&
    moduleBindingCount(parsed, "createRoot") === 1 &&
    hasDefaultImportFrom(parsed, REACT_APP_IMPORTS, "App") &&
    moduleBindingCount(parsed, "App") === 1
  );
}

function hasVueScaffoldOwnership(parsed: ParsedJavaScript): boolean {
  return (
    hasNamedImport(parsed, "vue", "createApp") &&
    moduleBindingCount(parsed, "createApp") === 1 &&
    hasDefaultImportFrom(parsed, VUE_APP_IMPORTS, "App") &&
    moduleBindingCount(parsed, "App") === 1
  );
}

function directDefaultObjectConfig(
  path: string,
  parsed: ParsedJavaScript,
  calleeName: string,
): SyntaxNode {
  const exported = uniqueNode(
    path,
    parsed.nodes
      .filter(
        ({ node, parent }) =>
          node.type === "ExportDefaultDeclaration" &&
          parent?.type === "Program",
      )
      .map(({ node }) => node),
  );
  const call = unwrapExpression(childNode(exported, "declaration"));
  if (
    call?.type !== "CallExpression" ||
    identifierName(childNode(call, "callee")) !== calleeName
  ) {
    throw new CliConflictError([path]);
  }
  const args = callArguments(call);
  if (args.length !== 1 || args[0]?.type !== "ObjectExpression") {
    throw new CliConflictError([path]);
  }
  return args[0];
}

function staticPropertyKey(property: SyntaxNode): string | undefined {
  if (property.type !== "Property") return undefined;
  const key = childNode(property, "key");
  if (property["computed"] !== true) {
    return identifierName(key) ?? literalString(key);
  }
  const literal = literalString(key);
  if (literal !== undefined) return literal;
  if (key?.type !== "TemplateLiteral") return undefined;
  if (nodeArray(key, "expressions").length > 0) return undefined;
  const quasis = nodeArray(key, "quasis");
  if (quasis.length !== 1) return undefined;
  const value = quasis[0]?.["value"];
  if (!isRecord(value)) return undefined;
  const cooked = value["cooked"];
  return typeof cooked === "string" ? cooked : undefined;
}

function targetConfigProperty(
  path: string,
  object: SyntaxNode,
  targetKey: string,
): SyntaxNode | undefined {
  let target: SyntaxNode | undefined;
  for (const property of nodeArray(object, "properties")) {
    if (property.type === "SpreadElement") throw new CliConflictError([path]);
    if (property.type !== "Property") throw new CliConflictError([path]);
    const key = staticPropertyKey(property);
    if (key === undefined) throw new CliConflictError([path]);
    if (key !== targetKey) continue;
    if (target !== undefined) throw new CliConflictError([path]);
    target = property;
  }
  return target;
}

function isChildrenExpression(node: SyntaxNode | undefined): boolean {
  return (
    node?.type === "JSXExpressionContainer" &&
    identifierName(childNode(node, "expression")) === "children"
  );
}

function nextAppBodyChild(
  path: string,
  parsed: ParsedJavaScript,
  functionNode: SyntaxNode,
): SyntaxNode {
  const returned = directReturnArgument(path, parsed, functionNode);
  const body = uniqueNode(
    path,
    parsed.nodes
      .filter(
        ({ node }) =>
          node.type === "JSXElement" &&
          jsxElementName(node) === "body" &&
          rangeContains(returned, node.start, node.end) &&
          nearestFunction(node, parsed) === functionNode,
      )
      .map(({ node }) => node),
  );
  const children = semanticJsxChildren(body);
  if (children.length !== 1) throw new CliConflictError([path]);
  return children[0] as SyntaxNode;
}

function isComponentPage(node: SyntaxNode | undefined): boolean {
  if (node === undefined || jsxElementName(node) !== "Component") return false;
  const opening = jsxOpeningElement(node);
  if (
    opening?.["selfClosing"] !== true ||
    semanticJsxChildren(node).length !== 0
  ) {
    return false;
  }
  const attributes = nodeArray(opening, "attributes");
  return (
    attributes.length === 1 &&
    attributes[0]?.type === "JSXSpreadAttribute" &&
    identifierName(childNode(attributes[0], "argument")) === "pageProps"
  );
}

function isVuePluginMount(node: SyntaxNode | undefined): boolean {
  if (node?.type !== "CallExpression") return false;
  const mountMember = childNode(node, "callee");
  if (
    mountMember?.type !== "MemberExpression" ||
    identifierName(childNode(mountMember, "property")) !== "mount" ||
    literalString(callArguments(node)[0]) !== "#app"
  ) {
    return false;
  }
  const useCall = unwrapExpression(childNode(mountMember, "object"));
  if (useCall?.type !== "CallExpression") return false;
  const useMember = childNode(useCall, "callee");
  if (
    useMember?.type !== "MemberExpression" ||
    identifierName(childNode(useMember, "property")) !== "use" ||
    identifierName(callArguments(useCall)[0]) !== "openCookiePlugin"
  ) {
    return false;
  }
  const createCall = unwrapExpression(childNode(useMember, "object"));
  return (
    createCall?.type === "CallExpression" &&
    identifierName(childNode(createCall, "callee")) === "createApp" &&
    identifierName(callArguments(createCall)[0]) === "App"
  );
}

function isInitializeCall(node: SyntaxNode | undefined): boolean {
  if (node?.type !== "UnaryExpression" || node["operator"] !== "void") {
    return false;
  }
  const call = unwrapExpression(childNode(node, "argument"));
  return (
    call?.type === "CallExpression" &&
    identifierName(childNode(call, "callee")) === "initializeOpenCookie" &&
    callArguments(call).length === 0
  );
}

function isVueWired(path: string, content: string): boolean {
  const parsed = parseJavaScript(path, content);
  if (
    !hasVueScaffoldOwnership(parsed) ||
    !hasNamedImport(parsed, "./opencookie.js", "initializeOpenCookie") ||
    !hasExclusiveModuleBinding(parsed, "initializeOpenCookie") ||
    !hasNamedImport(parsed, "./opencookie.js", "openCookiePlugin") ||
    !hasExclusiveModuleBinding(parsed, "openCookiePlugin")
  ) {
    return false;
  }
  const topLevelExpressions = parsed.nodes
    .filter(
      ({ node, parent }) =>
        node.type === "ExpressionStatement" && parent?.type === "Program",
    )
    .map(({ node }) => unwrapExpression(childNode(node, "expression")));
  return (
    topLevelExpressions.filter(isVuePluginMount).length === 1 &&
    topLevelExpressions.filter(isInitializeCall).length === 1
  );
}

interface MarkupOffsetRange {
  readonly endOffset: number;
  readonly startOffset: number;
}

interface MarkupLocation extends MarkupOffsetRange {
  readonly endTag?: MarkupOffsetRange;
  readonly startTag?: MarkupOffsetRange;
}

interface MarkupAttribute {
  readonly name: string;
  readonly value: string;
}

interface MarkupNode {
  readonly attrs?: readonly MarkupAttribute[];
  readonly childNodes?: readonly MarkupNode[];
  readonly data?: string;
  readonly nodeName: string;
  readonly sourceCodeLocation?: MarkupLocation | null;
  readonly tagName?: string;
  readonly value?: string;
}

interface MarkupVisit {
  readonly ancestors: readonly MarkupNode[];
  readonly node: MarkupNode;
}

function parseMarkup(content: string, fragment: boolean): MarkupNode {
  const parsed: unknown = fragment
    ? parseFragment(content, { sourceCodeLocationInfo: true })
    : parse(content, { sourceCodeLocationInfo: true });
  return parsed as MarkupNode;
}

function markupVisits(root: MarkupNode): readonly MarkupVisit[] {
  const visits: MarkupVisit[] = [];
  const pending: MarkupVisit[] = [{ ancestors: [], node: root }];
  while (pending.length > 0) {
    const visit = pending.pop();
    if (visit === undefined) continue;
    visits.push(visit);
    const ancestors = [...visit.ancestors, visit.node];
    const children = visit.node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push({ ancestors, node: child });
    }
  }
  return visits;
}

function markupAttributes(node: MarkupNode): ReadonlyMap<string, string> {
  return new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
}

type SvelteMarkupTagKind =
  | "attribute-expression"
  | "block-close"
  | "block-open"
  | "branch"
  | "const"
  | "expression"
  | "render";

interface SvelteMarkupTag extends SourceRange {
  readonly bindings?: readonly string[];
  readonly kind: SvelteMarkupTagKind;
  readonly name?: string;
  readonly source: string;
}

const SVELTE_RENDER_TOKEN = "{@render children()}";

function parsedSvelteJavaScript(source: string): SyntaxNode | undefined {
  const parsed = parseSync("opencookie-svelte-expression.ts", source, {
    lang: "ts",
    range: false,
    sourceType: "module",
  });
  return parsed.errors.length === 0 && isSyntaxNode(parsed.program)
    ? parsed.program
    : undefined;
}

function parsesSvelteJavaScript(source: string): boolean {
  return parsedSvelteJavaScript(source) !== undefined;
}

function parsesSvelteExpression(source: string): boolean {
  return parsesSvelteJavaScript(`const __opencookie = (${source});`);
}

function parsesSvelteBindings(source: string): boolean {
  return svelteBindingList(source) !== undefined;
}

function svelteBindingList(source: string): readonly string[] | undefined {
  const program = parsedSvelteJavaScript(`function __opencookie(${source}) {}`);
  const declaration =
    program === undefined ? undefined : nodeArray(program, "body")[0];
  return declaration?.type === "FunctionDeclaration"
    ? nodeArray(declaration, "params").flatMap(bindingPatternNames)
    : undefined;
}

function svelteAliasedExpressionBindingNames(
  node: SyntaxNode | undefined,
): readonly string[] {
  const expression = unwrapExpression(node);
  if (expression === undefined) return [];
  const direct = bindingPatternNames(expression);
  if (direct.length > 0) return direct;
  if (expression.type === "ObjectExpression") {
    return nodeArray(expression, "properties").flatMap((property) =>
      property.type === "Property"
        ? svelteAliasedExpressionBindingNames(childNode(property, "value"))
        : svelteAliasedExpressionBindingNames(childNode(property, "argument")),
    );
  }
  if (expression.type === "ArrayExpression") {
    return nodeArray(expression, "elements").flatMap(
      svelteAliasedExpressionBindingNames,
    );
  }
  if (expression.type === "AssignmentExpression") {
    return svelteAliasedExpressionBindingNames(childNode(expression, "left"));
  }
  if (expression.type === "SpreadElement") {
    return svelteAliasedExpressionBindingNames(
      childNode(expression, "argument"),
    );
  }
  return [];
}

function svelteAliasedBindingNames(
  source: string,
): readonly string[] | undefined {
  const direct = svelteBindingList(source);
  if (direct !== undefined) return direct;
  const program = parsedSvelteJavaScript(`const __opencookie = (${source});`);
  const declaration =
    program === undefined ? undefined : nodeArray(program, "body")[0];
  const declarator =
    declaration?.type === "VariableDeclaration"
      ? nodeArray(declaration, "declarations")[0]
      : undefined;
  return declarator === undefined
    ? undefined
    : svelteAliasedExpressionBindingNames(childNode(declarator, "init"));
}

function svelteSnippetBindingNames(
  source: string,
): readonly string[] | undefined {
  const program = parsedSvelteJavaScript(`function ${source} {}`);
  const declaration =
    program === undefined ? undefined : nodeArray(program, "body")[0];
  if (declaration?.type !== "FunctionDeclaration") return undefined;
  return [
    ...bindingPatternNames(childNode(declaration, "id")),
    ...nodeArray(declaration, "params").flatMap(bindingPatternNames),
  ];
}

function svelteConstBindingNames(
  source: string,
): readonly string[] | undefined {
  const program = parsedSvelteJavaScript(`const ${source};`);
  const declaration =
    program === undefined ? undefined : nodeArray(program, "body")[0];
  return declaration?.type === "VariableDeclaration"
    ? declarationBindingNames(declaration)
    : undefined;
}

function svelteEachClauseBindingNames(
  source: string,
): readonly string[] | undefined {
  for (const match of source.matchAll(/\bas\b/gu)) {
    const collection = source.slice(0, match.index);
    const bindingAndKey = source.slice(match.index + match[0].length).trim();
    if (!parsesSvelteExpression(collection)) continue;
    const directBindings = svelteBindingList(bindingAndKey);
    if (directBindings !== undefined) return directBindings;
    if (!bindingAndKey.endsWith(")")) continue;
    for (let index = 0; index < bindingAndKey.length; index += 1) {
      if (bindingAndKey[index] !== "(") continue;
      const bindings = bindingAndKey.slice(0, index).trim();
      const key = bindingAndKey.slice(index + 1, -1);
      const bindingNames = svelteBindingList(bindings);
      if (bindingNames !== undefined && parsesSvelteExpression(key)) {
        return bindingNames;
      }
    }
  }
  return undefined;
}

function parsesSvelteEachClause(source: string): boolean {
  return svelteEachClauseBindingNames(source) !== undefined;
}

function svelteAwaitClauseBindingNames(
  source: string,
): readonly string[] | undefined {
  for (const match of source.matchAll(/\b(?:catch|then)\b/gu)) {
    const promise = source.slice(0, match.index);
    const binding = source.slice(match.index + match[0].length);
    const bindingNames = svelteBindingList(binding);
    if (parsesSvelteExpression(promise) && bindingNames !== undefined) {
      return bindingNames;
    }
  }
  return parsesSvelteExpression(source) ? [] : undefined;
}

function parsesSvelteAwaitClause(source: string): boolean {
  return svelteAwaitClauseBindingNames(source) !== undefined;
}

function parsedSvelteTagEnd(
  source: string,
  contentStart: number,
  validate: (body: string) => boolean,
): number | undefined {
  let candidate = source.indexOf("}", contentStart);
  while (candidate >= 0) {
    if (validate(source.slice(contentStart, candidate))) return candidate + 1;
    candidate = source.indexOf("}", candidate + 1);
  }
  return undefined;
}

function parseSvelteMarkupTagAt(
  path: string,
  source: string,
  openingBrace: number,
): SvelteMarkupTag {
  if (source.startsWith(SVELTE_RENDER_TOKEN, openingBrace)) {
    return {
      end: openingBrace + SVELTE_RENDER_TOKEN.length,
      kind: "render",
      source: SVELTE_RENDER_TOKEN,
      start: openingBrace,
    };
  }
  const rest = source.slice(openingBrace);
  const blockOpen = /^\{#(await|each|if|key|snippet)\b/u.exec(rest);
  const blockClose = /^\{\/(await|each|if|key|snippet)\b/u.exec(rest);
  const branch = /^\{:(catch|else|then)\b/u.exec(rest);
  const constant = /^\{@const\b/u.exec(rest);
  const directive = /^\{@(attach|debug|html|render)\b/u.exec(rest);
  const closingBrace = source.indexOf("}", openingBrace + 2);
  const contentStart =
    openingBrace +
    (blockOpen?.[0].length ??
      blockClose?.[0].length ??
      branch?.[0].length ??
      constant?.[0].length ??
      directive?.[0].length ??
      1);
  const tagEnd =
    blockClose !== null
      ? closingBrace < 0 ||
        source.slice(contentStart, closingBrace).trim().length > 0
        ? undefined
        : closingBrace + 1
      : parsedSvelteTagEnd(source, contentStart, (body) => {
          if (blockOpen?.[1] === "each") {
            return parsesSvelteEachClause(body);
          }
          if (blockOpen?.[1] === "await") {
            return parsesSvelteAwaitClause(body);
          }
          if (blockOpen?.[1] === "snippet") {
            return parsesSvelteJavaScript(`function ${body} {}`);
          }
          if (blockOpen !== null) return parsesSvelteExpression(body);
          if (branch?.[1] === "else") {
            const trimmed = body.trim();
            return (
              trimmed.length === 0 ||
              (/^if\b/u.test(trimmed) &&
                parsesSvelteExpression(trimmed.slice(2)))
            );
          }
          if (branch !== null) return parsesSvelteBindings(body);
          if (constant !== null) {
            return parsesSvelteJavaScript(`const ${body};`);
          }
          if (directive !== null) {
            return (
              (directive[1] === "debug" && body.trim().length === 0) ||
              parsesSvelteExpression(body)
            );
          }
          return parsesSvelteExpression(body);
        });
  if (tagEnd === undefined) throw new CliConflictError([path]);
  const tagSource = source.slice(openingBrace, tagEnd);
  const tagBody = source.slice(contentStart, tagEnd - 1);
  const bindings =
    blockOpen?.[1] === "each"
      ? svelteEachClauseBindingNames(tagBody)
      : blockOpen?.[1] === "await"
        ? svelteAwaitClauseBindingNames(tagBody)
        : blockOpen?.[1] === "snippet"
          ? svelteSnippetBindingNames(tagBody)
          : branch?.[1] === "then" || branch?.[1] === "catch"
            ? svelteBindingList(tagBody)
            : constant !== null
              ? svelteConstBindingNames(tagBody)
              : [];
  if (blockOpen !== null) {
    return {
      bindings: bindings ?? [],
      end: tagEnd,
      kind: "block-open",
      name: blockOpen[1] ?? "",
      source: tagSource,
      start: openingBrace,
    };
  }
  if (blockClose !== null) {
    return {
      end: tagEnd,
      kind: "block-close",
      name: blockClose[1] ?? "",
      source: tagSource,
      start: openingBrace,
    };
  }
  if (branch !== null) {
    return {
      bindings: bindings ?? [],
      end: tagEnd,
      kind: "branch",
      name: branch[1] ?? "",
      source: tagSource,
      start: openingBrace,
    };
  }
  if (constant !== null) {
    return {
      bindings: bindings ?? [],
      end: tagEnd,
      kind: "const",
      source: tagSource,
      start: openingBrace,
    };
  }
  return {
    end: tagEnd,
    kind: "expression",
    source: tagSource,
    start: openingBrace,
  };
}

function parsedSvelteAttributeEnd(
  source: string,
  openingBrace: number,
): number | undefined {
  return parsedSvelteTagEnd(source, openingBrace + 1, (body) => {
    const trimmed = body.trim();
    return trimmed.startsWith("...")
      ? parsesSvelteExpression(trimmed.slice(3))
      : parsesSvelteExpression(body);
  });
}

function svelteAttributeNameBefore(
  source: string,
  openingAngle: number,
  openingBrace: number,
): string | undefined {
  return /(?:^|\s)([^\s=/>]+)\s*=\s*(?:["'])?$/u.exec(
    source.slice(openingAngle + 1, openingBrace),
  )?.[1];
}

function svelteMarkupElementEnd(
  path: string,
  source: string,
  openingAngle: number,
): {
  readonly end: number;
  readonly expressions: readonly SvelteMarkupTag[];
} {
  const expressions: SvelteMarkupTag[] = [];
  let cursor = openingAngle + 1;
  let quote: '"' | "'" | undefined;
  while (cursor < source.length) {
    const character = source[cursor];
    if (quote !== undefined) {
      if (character === "{") {
        const expressionEnd = parsedSvelteAttributeEnd(source, cursor);
        if (expressionEnd !== undefined) {
          const attributeName = svelteAttributeNameBefore(
            source,
            openingAngle,
            cursor,
          );
          const expressionSource = source.slice(cursor, expressionEnd);
          expressions.push({
            bindings: attributeName?.toLowerCase().startsWith("let:")
              ? (svelteAliasedBindingNames(expressionSource.slice(1, -1)) ?? [])
              : [],
            end: expressionEnd,
            kind: "attribute-expression",
            source: expressionSource,
            start: cursor,
          });
          cursor = expressionEnd;
          continue;
        }
      }
      if (character === quote) quote = undefined;
      cursor += 1;
      continue;
    }
    if (character === "{") {
      const expressionEnd = parsedSvelteAttributeEnd(source, cursor);
      if (expressionEnd === undefined) throw new CliConflictError([path]);
      const attributeName = svelteAttributeNameBefore(
        source,
        openingAngle,
        cursor,
      );
      const expressionSource = source.slice(cursor, expressionEnd);
      expressions.push({
        bindings: attributeName?.toLowerCase().startsWith("let:")
          ? (svelteAliasedBindingNames(expressionSource.slice(1, -1)) ?? [])
          : [],
        end: expressionEnd,
        kind: "attribute-expression",
        source: expressionSource,
        start: cursor,
      });
      cursor = expressionEnd;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === ">") {
      return { end: cursor + 1, expressions };
    }
    cursor += 1;
  }
  throw new CliConflictError([path]);
}

function rawSvelteElementEnd(
  path: string,
  source: string,
  start: number,
  tagName: "script" | "style",
): number {
  const match = new RegExp(`</${tagName}\\s*>`, "giu").exec(
    source.slice(start),
  );
  if (match?.index === undefined) throw new CliConflictError([path]);
  return start + match.index + match[0].length;
}

function scanSvelteMarkupSource(
  path: string,
  source: string,
): readonly SvelteMarkupTag[] {
  const tags: SvelteMarkupTag[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const openingBrace = source.indexOf("{", cursor);
    const openingAngle = source.indexOf("<", cursor);
    if (openingBrace < 0 && openingAngle < 0) break;
    if (
      openingBrace >= 0 &&
      (openingAngle < 0 || openingBrace < openingAngle)
    ) {
      const tag = parseSvelteMarkupTagAt(path, source, openingBrace);
      tags.push(tag);
      cursor = tag.end;
      continue;
    }
    if (source.startsWith("<!--", openingAngle)) {
      const end = source.indexOf("-->", openingAngle + 4);
      if (end < 0) throw new CliConflictError([path]);
      cursor = end + 3;
      continue;
    }
    const tagMatch = /^<\s*(\/?)\s*([A-Za-z][^\s/>]*)/u.exec(
      source.slice(openingAngle),
    );
    if (tagMatch === null) {
      cursor = openingAngle + 1;
      continue;
    }
    const element = svelteMarkupElementEnd(path, source, openingAngle);
    tags.push(...element.expressions);
    const tagEnd = element.end;
    const tagName = tagMatch[2]?.toLowerCase();
    if (tagMatch[1] === "" && (tagName === "script" || tagName === "style")) {
      cursor = rawSvelteElementEnd(path, source, tagEnd, tagName);
      continue;
    }
    cursor = tagEnd;
  }
  return tags;
}

function topLevelSvelteScripts(
  path: string,
  content: string,
  root: MarkupNode,
): readonly MarkupNode[] {
  const tags = svelteMarkupTags(path, content);
  return (root.childNodes ?? []).filter((node) => {
    const location = node.sourceCodeLocation;
    return (
      node.tagName === "script" &&
      location !== undefined &&
      location !== null &&
      !tags.some((tag) =>
        rangeContains(tag, location.startOffset, location.startOffset),
      ) &&
      hasZeroSvelteBlockDepthAt(path, tags, location.startOffset)
    );
  });
}

function topLevelInstanceScript(
  path: string,
  content: string,
  root: MarkupNode,
): MarkupNode {
  const scripts = topLevelSvelteScripts(path, content, root).filter((node) => {
    const attributes = markupAttributes(node);
    return !attributes.has("module") && attributes.get("context") !== "module";
  });
  if (scripts.length !== 1) throw new CliConflictError([path]);
  const script = scripts[0] as MarkupNode;
  if (script.sourceCodeLocation?.startTag === undefined) {
    throw new CliConflictError([path]);
  }
  return script;
}

function svelteScriptContent(
  path: string,
  content: string,
  script: MarkupNode,
): {
  readonly parsed: ParsedJavaScript;
  readonly range: SourceRange;
} {
  const text = (script.childNodes ?? []).find(
    (node) => node.nodeName === "#text",
  );
  const location = text?.sourceCodeLocation;
  if (location === undefined || location === null) {
    throw new CliConflictError([path]);
  }
  return {
    parsed: parseJavaScript(
      `${path}.ts`,
      content.slice(location.startOffset, location.endOffset),
      "ts",
    ),
    range: {
      end: location.endOffset,
      start: location.startOffset,
    },
  };
}

function svelteRenderRanges(
  path: string,
  content: string,
): readonly SourceRange[] {
  return svelteMarkupTags(path, content)
    .filter(({ kind }) => kind === "render")
    .map(({ end, start }) => ({ end, start }));
}

function svelteTagBindsIdentifier(
  tag: SvelteMarkupTag,
  target: string,
): boolean {
  return tag.bindings?.includes(target) === true;
}

function svelteMarkupTags(
  path: string,
  content: string,
): readonly SvelteMarkupTag[] {
  const tags = scanSvelteMarkupSource(path, content);
  const stack: string[] = [];
  for (const tag of tags) {
    if (tag.kind === "block-open" && tag.name !== undefined) {
      stack.push(tag.name);
    } else if (tag.kind === "block-close") {
      if (stack.pop() !== tag.name) throw new CliConflictError([path]);
    }
  }
  if (stack.length > 0) throw new CliConflictError([path]);
  return tags;
}

function parseSvelteMarkup(path: string, content: string): MarkupNode {
  const tags = svelteMarkupTags(path, content);
  let cursor = 0;
  let masked = "";
  for (const tag of tags) {
    masked += content.slice(cursor, tag.start);
    masked += content.slice(tag.start, tag.end).replaceAll(/[^\r\n]/g, " ");
    cursor = tag.end;
  }
  masked += content.slice(cursor);
  return parseMarkup(masked, true);
}

function hasZeroSvelteBlockDepthAt(
  path: string,
  tags: readonly SvelteMarkupTag[],
  offset: number,
): boolean {
  const stack: string[] = [];
  for (const tag of tags) {
    if (tag.start >= offset) break;
    if (tag.kind === "block-open" && tag.name !== undefined) {
      stack.push(tag.name);
    } else if (tag.kind === "block-close") {
      if (stack.pop() !== tag.name) throw new CliConflictError([path]);
    }
  }
  return stack.length === 0;
}

function hasSvelteTemplateBinding(
  path: string,
  content: string,
  root: MarkupNode,
  target: string,
): boolean {
  const tags = svelteMarkupTags(path, content);
  if (tags.some((tag) => svelteTagBindsIdentifier(tag, target))) return true;
  const slotBinding = `let:${target}`.toLowerCase();
  return markupVisits(root).some(({ node }) => {
    const location = node.sourceCodeLocation;
    return (
      location !== undefined &&
      location !== null &&
      !tags.some((tag) =>
        rangeContains(tag, location.startOffset, location.startOffset),
      ) &&
      (node.attrs ?? []).some(({ name }) => {
        const normalizedName = name.toLowerCase();
        return normalizedName === slotBinding;
      })
    );
  });
}

function isPlainBootstrapScript(
  node: MarkupNode,
  assets: PlainHtmlAssets,
): boolean {
  if (node.tagName !== "script") return false;
  const attributes = markupAttributes(node);
  return (
    attributes.get("defer") === "" &&
    attributes.get("src") === assets.bootstrapSource &&
    attributes.get("integrity") === assets.bootstrapIntegrity &&
    attributes.get("crossorigin") === "anonymous" &&
    attributes.get("data-oc-policy-version") === "policy-1" &&
    attributes.get("data-oc-storage-key") === "opencookie.consent" &&
    attributes.get("data-oc-purpose-id") === "analytics"
  );
}

function isPlainDemoResource(node: MarkupNode): boolean {
  if (node.tagName !== "script") return false;
  const attributes = markupAttributes(node);
  return (
    attributes.get("type") === "text/plain" &&
    attributes.get("data-src") === "/opencookie-demo.js" &&
    attributes.get("data-oc-resource") === "opencookie-demo-script" &&
    attributes.get("data-oc-category") === "analytics"
  );
}

function isPlainHtmlWired(content: string, assets: PlainHtmlAssets): boolean {
  const root = parseMarkup(content, false);
  const body = markupVisits(root).filter(({ node }) => node.tagName === "body");
  if (
    body.length !== 1 ||
    body[0]?.node.sourceCodeLocation?.endTag === undefined
  ) {
    return false;
  }
  const children = body[0].node.childNodes ?? [];
  const expectedDemoResources = assets.includesDemoResource ? 1 : 0;
  return (
    children.filter((node) => isPlainBootstrapScript(node, assets)).length ===
      1 && children.filter(isPlainDemoResource).length === expectedDemoResources
  );
}

function hasSvelteProviderImport(
  path: string,
  content: string,
  scripts: readonly MarkupNode[],
  instanceScript: MarkupNode,
  specifier: string,
): boolean {
  const instance = svelteScriptContent(path, content, instanceScript).parsed;
  if (!(
    hasDefaultImport(instance, specifier, "OpenCookieProvider") &&
    hasExclusiveModuleBinding(instance, "OpenCookieProvider")
  )) {
    return false;
  }
  return scripts.every((script) => {
    if (script === instanceScript) return true;
    const parsed = svelteScriptContent(path, content, script).parsed;
    return moduleValueBindingCount(parsed, "OpenCookieProvider") === 0;
  });
}

function hasExactSvelteProvider(
  path: string,
  content: string,
  root: MarkupNode,
): boolean {
  const tags = svelteMarkupTags(path, content);
  const providers = markupVisits(root)
    .map(({ node }) => node)
    .filter(
      (node) =>
        node.tagName === "opencookieprovider" &&
        node.sourceCodeLocation !== undefined &&
        node.sourceCodeLocation !== null &&
        !tags.some((tag) =>
          rangeContains(
            tag,
            node.sourceCodeLocation?.startOffset ?? -1,
            node.sourceCodeLocation?.startOffset ?? -1,
          ),
        ) &&
        hasZeroSvelteBlockDepthAt(
          path,
          tags,
          node.sourceCodeLocation.startOffset,
        ),
    );
  if (providers.length !== 1) return false;
  const location = providers[0]?.sourceCodeLocation;
  if (location?.startTag === undefined || location.endTag === undefined) {
    return false;
  }
  return (
    content.slice(
      location.startTag.startOffset,
      location.startTag.endOffset,
    ) === "<OpenCookieProvider>" &&
    content.slice(location.endTag.startOffset, location.endTag.endOffset) ===
      "</OpenCookieProvider>" &&
    content
      .slice(location.startTag.endOffset, location.endTag.startOffset)
      .trim() === SVELTE_RENDER_TOKEN
  );
}

function assertSvelteBindingsAvailable(
  path: string,
  content: string,
  scripts: readonly MarkupNode[],
  instanceScript: MarkupNode,
  names: readonly string[],
): void {
  for (const script of scripts) {
    const parsed = svelteScriptContent(path, content, script).parsed;
    const existing = new Set(
      script === instanceScript
        ? moduleBindingNames(parsed)
        : moduleValueBindingNames(parsed),
    );
    if (names.some((name) => existing.has(name))) {
      throw new CliConflictError([path]);
    }
  }
}

function isSvelteWired(
  path: string,
  content: string,
  specifier: string,
): boolean {
  const root = parseSvelteMarkup(path, content);
  const scripts = topLevelSvelteScripts(path, content, root);
  const script = topLevelInstanceScript(path, content, root);
  if (hasSvelteTemplateBinding(path, content, root, "OpenCookieProvider")) {
    return false;
  }
  return (
    hasSvelteProviderImport(path, content, scripts, script, specifier) &&
    hasExactSvelteProvider(path, content, root) &&
    svelteRenderRanges(path, content).length === 1
  );
}

interface SourceMarker extends SourceRange {
  readonly closing: boolean;
  readonly label: string;
}

function sourceMarker(
  path: string,
  value: string,
  range: SourceRange,
): SourceMarker | undefined {
  const trimmed = value.trim();
  if (!/^\/?opencookie:init/u.test(trimmed)) return undefined;
  const match = /^(\/?)opencookie:init(?::([a-z-]+))?$/u.exec(trimmed);
  if (match === null) throw new CliConflictError([path]);
  return {
    closing: match[1] === "/",
    end: range.end,
    label: match[2] ?? "",
    start: range.start,
  };
}

function javascriptSourceMarkers(
  path: string,
  content: string,
  offset = 0,
  language: "ts" | "tsx" = "tsx",
): readonly SourceMarker[] {
  const parsed = parseJavaScript(path, content, language);
  return parsed.comments.flatMap((comment) => {
    const marker = sourceMarker(path, comment.value, {
      end: offset + comment.end,
      start: offset + comment.start,
    });
    return marker === undefined ? [] : [marker];
  });
}

function markupCommentMarkers(
  path: string,
  root: MarkupNode,
): readonly SourceMarker[] {
  return markupVisits(root).flatMap(({ node }) => {
    const location = node.sourceCodeLocation;
    if (
      node.nodeName !== "#comment" ||
      typeof node.data !== "string" ||
      location === undefined ||
      location === null
    ) {
      return [];
    }
    const marker = sourceMarker(path, node.data, {
      end: location.endOffset,
      start: location.startOffset,
    });
    return marker === undefined ? [] : [marker];
  });
}

function sourceMarkers(path: string, content: string): readonly SourceMarker[] {
  if (path.endsWith(".html")) {
    return [...markupCommentMarkers(path, parseMarkup(content, false))].sort(
      (left, right) => left.start - right.start,
    );
  }
  if (path.endsWith(".svelte")) {
    const root = parseSvelteMarkup(path, content);
    const scriptMarkers = topLevelSvelteScripts(path, content, root).flatMap(
      (node) => {
        return (node.childNodes ?? []).flatMap((child) => {
          const location = child.sourceCodeLocation;
          if (
            child.nodeName !== "#text" ||
            location === undefined ||
            location === null
          ) {
            return [];
          }
          return javascriptSourceMarkers(
            `${path}.ts`,
            content.slice(location.startOffset, location.endOffset),
            location.startOffset,
            "ts",
          );
        });
      },
    );
    return [...markupCommentMarkers(path, root), ...scriptMarkers].sort(
      (left, right) => left.start - right.start,
    );
  }
  return javascriptSourceMarkers(path, content);
}

function topLevelExpressionContaining(
  parsed: ParsedJavaScript,
  range: SourceRange,
): SyntaxNode | undefined {
  const statement = parsed.nodes.find(
    ({ node, parent }) =>
      node.type === "ExpressionStatement" &&
      parent?.type === "Program" &&
      rangeContains(node, range.start, range.end),
  )?.node;
  return statement === undefined
    ? undefined
    : childNode(statement, "expression");
}

function isTopLevelVueMount(
  match: RegExpMatchArray,
  parsed: ParsedJavaScript,
): boolean {
  const expression = topLevelExpressionContaining(parsed, matchRange(match));
  if (expression?.type !== "CallExpression") return false;
  const member = childNode(expression, "callee");
  if (
    member?.type !== "MemberExpression" ||
    identifierName(childNode(member, "property")) !== "mount"
  ) {
    return false;
  }
  const appCall = childNode(member, "object");
  return (
    appCall?.type === "CallExpression" &&
    identifierName(childNode(appCall, "callee")) === "createApp" &&
    identifierName(callArguments(appCall)[0]) === "App"
  );
}

async function findExistingPath(
  fileSystem: FileSystemPort,
  candidates: readonly string[],
): Promise<string | undefined> {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await fileSystem.exists(candidate)) found.push(candidate);
  }
  if (found.length > 1) throw new CliConflictError(found);
  return found[0];
}

function prependJavaScriptIntegration(
  content: string,
  importLine: string,
): string {
  const initialIndex = content.startsWith("\uFEFF") ? 1 : 0;
  let insertionIndex = initialIndex;
  const skipTrivia = (start: number): number => {
    let cursor = start;
    while (cursor < content.length) {
      const whitespace = /^[\t\v\f \u00A0\r\n]+/u.exec(content.slice(cursor));
      if (whitespace !== null) {
        cursor += whitespace[0].length;
        continue;
      }
      if (content.startsWith("//", cursor)) {
        const newline = content.indexOf("\n", cursor + 2);
        cursor = newline < 0 ? content.length : newline + 1;
        continue;
      }
      if (content.startsWith("/*", cursor)) {
        const close = content.indexOf("*/", cursor + 2);
        if (close < 0) return cursor;
        cursor = close + 2;
        continue;
      }
      break;
    }
    return cursor;
  };
  const directiveLine =
    /^[ \t]*(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*')[ \t]*;?[ \t]*(?=\/\/|\/\*|\r?\n|$)/u;
  let foundDirective = false;
  let candidateIndex = skipTrivia(insertionIndex);
  let match = directiveLine.exec(content.slice(candidateIndex));
  while (match !== null) {
    insertionIndex = candidateIndex + match[0].length;
    foundDirective = true;
    candidateIndex = skipTrivia(insertionIndex);
    match = directiveLine.exec(content.slice(candidateIndex));
  }
  if (foundDirective) {
    insertionIndex = candidateIndex;
  }
  const marker = `// opencookie:init:import\n${importLine}\n// /opencookie:init:import\n`;
  return `${content.slice(0, insertionIndex)}${marker}${content.slice(insertionIndex)}`;
}

async function reactViteWiring(
  fileSystem: FileSystemPort,
): Promise<WiringChanges> {
  const path = await findExistingPath(fileSystem, [
    "src/main.tsx",
    "src/main.jsx",
  ]);
  if (path === undefined) throw new CliConflictError(["src/main.tsx"]);
  const content = await fileSystem.readFile(path);
  const required = [
    'import { OpenCookieRoot } from "./opencookie.js";',
    "<OpenCookieRoot>",
  ];
  if (
    validateExistingMarker(path, content, { import: required[0] ?? "" }, () => {
      const parsed = parseJavaScript(path, content);
      return (
        hasNamedImport(parsed, "./opencookie.js", "OpenCookieRoot") &&
        hasExclusiveModuleBinding(parsed, "OpenCookieRoot") &&
        isProviderAround(
          topLevelReactRenderArgument(path, parsed),
          isCanonicalReactRoot,
        )
      );
    })
  )
    return { edits: [], files: [] };
  const parsed = parseJavaScript(path, content);
  const argument = topLevelReactRenderArgument(path, parsed);
  assertBindingsAvailable(path, parsed, ["OpenCookieRoot"]);
  if (!isCanonicalReactRoot(argument)) throw new CliConflictError([path]);
  const wrapped = spliceNode(
    content,
    argument,
    `<OpenCookieRoot>\n    ${content.slice(argument.start, argument.end)}\n  </OpenCookieRoot>`,
  );
  return {
    edits: [
      edit(
        path,
        content,
        prependJavaScriptIntegration(wrapped, required[0] ?? ""),
      ),
    ],
    files: [],
  };
}

async function vueViteWiring(
  fileSystem: FileSystemPort,
): Promise<WiringChanges> {
  const path = await findExistingPath(fileSystem, [
    "src/main.ts",
    "src/main.js",
  ]);
  if (path === undefined) throw new CliConflictError(["src/main.ts"]);
  const content = await fileSystem.readFile(path);
  const importLine =
    'import { initializeOpenCookie, openCookiePlugin } from "./opencookie.js";';
  if (
    validateExistingMarker(path, content, { import: importLine }, () =>
      isVueWired(path, content),
    )
  )
    return { edits: [], files: [] };
  const parsed = parseJavaScript(path, content);
  if (!hasVueScaffoldOwnership(parsed)) throw new CliConflictError([path]);
  assertBindingsAvailable(path, parsed, [
    "initializeOpenCookie",
    "openCookiePlugin",
  ]);
  const transformed = replacePatternExactlyOnce(
    path,
    content,
    /^([ \t]*)createApp\(App\)(\.mount\((["'])#app\3\);?)[ \t]*$/mu,
    (match) => {
      const indentation = match[1] ?? "";
      const mount = match[2] ?? "";
      return `${indentation}createApp(App).use(openCookiePlugin)${mount}\n${indentation}void initializeOpenCookie();`;
    },
    isTopLevelVueMount,
  );
  return {
    edits: [
      edit(
        path,
        content,
        prependJavaScriptIntegration(transformed, importLine),
      ),
    ],
    files: [],
  };
}

async function nextAppWiring(
  fileSystem: FileSystemPort,
): Promise<WiringChanges> {
  const root = await nextRouterRoot(fileSystem, "app");
  const path = await findExistingPath(fileSystem, [
    `${root}/layout.tsx`,
    `${root}/layout.jsx`,
    `${root}/layout.ts`,
    `${root}/layout.js`,
  ]);
  if (path === undefined) throw new CliConflictError([`${root}/layout.tsx`]);
  const content = await fileSystem.readFile(path);
  const importLine = 'import { OpenCookieRoot } from "./opencookie-provider";';
  const hint = `Add ${importLine} to ${path}, and inside <body>, wrap the content, {children} included, in <OpenCookieRoot>...</OpenCookieRoot>, then run init again.`;
  let parsed: ParsedJavaScript;
  try {
    parsed = parseJavaScript(path, content);
  } catch (error) {
    if (
      error instanceof CliConflictError &&
      error.paths.length === 1 &&
      error.paths[0] === path
    ) {
      throw new CliConflictError([path], hint);
    }
    throw error;
  }
  const isHandWired =
    hasNamedImport(parsed, "./opencookie-provider", "OpenCookieRoot") &&
    hasExclusiveModuleBinding(parsed, "OpenCookieRoot") &&
    !hasAnyFunctionBinding(parsed, "OpenCookieRoot") &&
    isProviderInsideBody(parsed);
  if (isHandWired) return { edits: [], files: [] };
  let functionNode: SyntaxNode;
  let child: SyntaxNode;
  try {
    functionNode = defaultExportFunction(path, parsed);
    child = nextAppBodyChild(path, parsed, functionNode);
  } catch (error) {
    if (
      error instanceof CliConflictError &&
      error.paths.length === 1 &&
      error.paths[0] === path
    ) {
      throw new CliConflictError([path], hint);
    }
    throw error;
  }
  if (
    validateExistingMarker(
      path,
      content,
      { import: importLine },
      () => isHandWired,
    )
  )
    return { edits: [], files: [] };
  assertBindingsAvailable(path, parsed, ["OpenCookieRoot"], hint);
  assertFunctionBindingsAvailable(
    path,
    parsed,
    functionNode,
    ["OpenCookieRoot"],
    hint,
  );
  if (!isChildrenExpression(child)) {
    throw new CliConflictError([path], hint);
  }
  const transformed = spliceNode(
    content,
    child,
    "<OpenCookieRoot>{children}</OpenCookieRoot>",
  );
  return {
    edits: [
      edit(
        path,
        content,
        prependJavaScriptIntegration(transformed, importLine),
      ),
    ],
    files: [],
  };
}

async function nextPagesWiring(
  fileSystem: FileSystemPort,
): Promise<WiringChanges> {
  const root = await nextRouterRoot(fileSystem, "pages");
  const path = await findExistingPath(fileSystem, [
    `${root}/_app.tsx`,
    `${root}/_app.jsx`,
    `${root}/_app.ts`,
    `${root}/_app.js`,
  ]);
  const importLine = 'import { OpenCookieRoot } from "../opencookie-provider";';
  const previousImportLine =
    'import { OpenCookieRoot } from "./opencookie-provider.js";';
  const generatedContent = `// opencookie:init:generated\n${importLine}\n// /opencookie:init:generated\nimport type { AppProps } from "next/app";\n\nexport default function App({ Component, pageProps }: AppProps) {\n  return (\n    <OpenCookieRoot>\n      <Component {...pageProps} />\n    </OpenCookieRoot>\n  );\n}\n`;
  const previousGeneratedContent = generatedContent.replace(
    importLine,
    previousImportLine,
  );
  const legacyGeneratedContent = previousGeneratedContent.replace(
    "// /opencookie:init:generated",
    "// /opencookie:init",
  );
  if (path === undefined) {
    return {
      edits: [],
      files: [
        {
          content: generatedContent,
          path: `${root}/_app.tsx`,
        },
      ],
    };
  }
  const content = await fileSystem.readFile(path);
  if (
    content === previousGeneratedContent ||
    content === legacyGeneratedContent
  ) {
    return {
      edits: [edit(path, content, generatedContent)],
      files: [],
      managedPaths: [path],
    };
  }
  if (content === generatedContent) {
    return { edits: [], files: [{ content, path }] };
  }
  if (
    validateExistingMarker(path, content, { import: importLine }, () => {
      const parsed = parseJavaScript(path, content);
      const functionNode = defaultExportFunction(path, parsed);
      return (
        hasNamedImport(parsed, "../opencookie-provider", "OpenCookieRoot") &&
        hasExclusiveModuleBinding(parsed, "OpenCookieRoot") &&
        !functionBindingNames(parsed, functionNode).has("OpenCookieRoot") &&
        isProviderAround(
          directReturnArgument(path, parsed, functionNode),
          isComponentPage,
        )
      );
    })
  )
    return { edits: [], files: [] };
  const parsed = parseJavaScript(path, content);
  const functionNode = defaultExportFunction(path, parsed);
  const returned = directReturnArgument(path, parsed, functionNode);
  assertBindingsAvailable(path, parsed, ["OpenCookieRoot"]);
  assertFunctionBindingsAvailable(path, parsed, functionNode, [
    "OpenCookieRoot",
  ]);
  if (!isComponentPage(returned)) throw new CliConflictError([path]);
  const transformed = spliceNode(
    content,
    returned,
    `<OpenCookieRoot>\n      ${content.slice(returned.start, returned.end)}\n    </OpenCookieRoot>`,
  );
  return {
    edits: [
      edit(
        path,
        content,
        prependJavaScriptIntegration(transformed, importLine),
      ),
    ],
    files: [],
  };
}

async function nuxtWiring(fileSystem: FileSystemPort): Promise<WiringChanges> {
  const path = await findExistingPath(fileSystem, [
    "nuxt.config.ts",
    "nuxt.config.js",
    "nuxt.config.mjs",
  ]);
  if (path === undefined) throw new CliConflictError(["nuxt.config.ts"]);
  const content = await fileSystem.readFile(path);
  const generatedProperty =
    'modules: [["@opencookie-dev/nuxt", { storeModule: "~~/opencookie-store" }]]';
  if (
    validateExistingMarker(
      path,
      content,
      { config: `${generatedProperty},` },
      () => {
        const parsed = parseJavaScript(path, content);
        const object = directDefaultObjectConfig(
          path,
          parsed,
          "defineNuxtConfig",
        );
        const property = targetConfigProperty(path, object, "modules");
        return (
          property !== undefined &&
          content.slice(property.start, property.end) === generatedProperty
        );
      },
    )
  )
    return { edits: [], files: [] };
  const parsed = parseJavaScript(path, content);
  const object = directDefaultObjectConfig(path, parsed, "defineNuxtConfig");
  if (targetConfigProperty(path, object, "modules") !== undefined) {
    throw new CliConflictError([path]);
  }
  const transformed = spliceNode(
    content,
    { end: object.start + 1, start: object.start + 1 },
    `\n  // opencookie:init:config\n  ${generatedProperty},\n  // /opencookie:init:config\n`,
  );
  return { edits: [edit(path, content, transformed)], files: [] };
}

async function svelteWiring(
  fileSystem: FileSystemPort,
): Promise<WiringChanges> {
  const path = "src/routes/+layout.svelte";
  // A relative specifier resolves on SvelteKit 2 and 3 alike: SvelteKit 3
  // dropped the generated `$lib` alias that earlier releases imported from.
  const specifier = "../lib/OpenCookieProvider.svelte";
  const legacySpecifier = "$lib/OpenCookieProvider.svelte";
  const importLineFor = (from: string) =>
    `  import OpenCookieProvider from "${from}";`;
  const generatedContentFor = (line: string) =>
    `<!-- opencookie:init:generated -->\n<script lang="ts">\n  // opencookie:init:import\n${line}\n  // /opencookie:init:import\n  let { children } = $props();\n</script>\n\n<OpenCookieProvider>\n  {@render children()}\n</OpenCookieProvider>\n<!-- /opencookie:init:generated -->\n`;
  const importLine = importLineFor(specifier);
  const legacyImportLine = importLineFor(legacySpecifier);
  const generatedContent = generatedContentFor(importLine);
  if (!(await fileSystem.exists(path))) {
    return {
      edits: [],
      files: [
        {
          content: generatedContent,
          path,
        },
      ],
    };
  }
  const content = await fileSystem.readFile(path);
  // A layout an earlier release wired with the `$lib` import stays as it is.
  if (
    content === generatedContent ||
    content === generatedContentFor(legacyImportLine)
  ) {
    return { edits: [], files: [{ content, path }] };
  }
  const wiredSpecifier = content.includes(legacyImportLine)
    ? legacySpecifier
    : specifier;
  if (
    validateExistingMarker(
      path,
      content,
      {
        import: importLineFor(wiredSpecifier),
        provider:
          "<OpenCookieProvider>\n  {@render children()}\n</OpenCookieProvider>",
      },
      () => isSvelteWired(path, content, wiredSpecifier),
    )
  )
    return { edits: [], files: [] };
  const root = parseSvelteMarkup(path, content);
  if (hasSvelteTemplateBinding(path, content, root, "OpenCookieProvider")) {
    throw new CliConflictError([path]);
  }
  const scripts = topLevelSvelteScripts(path, content, root);
  const script = topLevelInstanceScript(path, content, root);
  assertSvelteBindingsAvailable(path, content, scripts, script, [
    "OpenCookieProvider",
  ]);
  const scriptEnd = script.sourceCodeLocation?.startTag?.endOffset;
  const renderRanges = svelteRenderRanges(path, content);
  const render = renderRanges.length === 1 ? renderRanges[0] : undefined;
  if (render === undefined) throw new CliConflictError([path]);
  if (scriptEnd === undefined) throw new CliConflictError([path]);
  const immediateLineBreak = content.startsWith("\r\n", scriptEnd)
    ? "\r\n"
    : content.startsWith("\n", scriptEnd)
      ? "\n"
      : "";
  const lineBreak =
    immediateLineBreak || (content.includes("\r\n") ? "\r\n" : "\n");
  const operations = [
    {
      end: render.end,
      replacement:
        "<!-- opencookie:init:provider -->\n<OpenCookieProvider>\n  {@render children()}\n</OpenCookieProvider>\n<!-- /opencookie:init:provider -->",
      start: render.start,
    },
    {
      end: scriptEnd + immediateLineBreak.length,
      replacement: `${lineBreak}  // opencookie:init:import${lineBreak}${importLine}${lineBreak}  // /opencookie:init:import${lineBreak}`,
      start: scriptEnd,
    },
  ].sort((left, right) => right.start - left.start);
  let transformed = content;
  for (const operation of operations) {
    transformed = `${transformed.slice(0, operation.start)}${operation.replacement}${transformed.slice(operation.end)}`;
  }
  return { edits: [edit(path, content, transformed)], files: [] };
}

function exactOccurrenceCount(content: string, fragment: string): number {
  return content.split(fragment).length - 1;
}

function migrateLegacyAstroWiring(
  path: string,
  content: string,
  importLine: string,
  generatedProperty: string,
): string | undefined {
  const legacyImportBlock = `// opencookie:init\n${importLine}\n// /opencookie:init`;
  const legacyConfigBlock = `// opencookie:init\n  ${generatedProperty},\n  // /opencookie:init`;
  if (
    exactOccurrenceCount(content, legacyImportBlock) !== 1 ||
    exactOccurrenceCount(content, legacyConfigBlock) !== 1
  ) {
    return undefined;
  }
  const markers = sourceMarkers(path, content);
  const legacyImportStart = content.indexOf(legacyImportBlock);
  const legacyConfigStart = content.indexOf(legacyConfigBlock);
  if (
    markers.length !== 4 ||
    markers.some(({ label }) => label !== "") ||
    markers[0]?.closing !== false ||
    markers[1]?.closing !== true ||
    markers[2]?.closing !== false ||
    markers[3]?.closing !== true ||
    markers[0].start !== legacyImportStart ||
    markers[1].end !== legacyImportStart + legacyImportBlock.length ||
    markers[2].start !== legacyConfigStart ||
    markers[3].end !== legacyConfigStart + legacyConfigBlock.length
  ) {
    return undefined;
  }
  const parsed = parseJavaScript(path, content);
  const object = directDefaultObjectConfig(path, parsed, "defineConfig");
  const property = targetConfigProperty(path, object, "integrations");
  if (
    !hasNamedImport(parsed, "astro/config", "defineConfig") ||
    !hasDefaultImport(parsed, "@opencookie-dev/astro", "openCookie") ||
    !hasExclusiveModuleBinding(parsed, "openCookie") ||
    property === undefined ||
    content.slice(property.start, property.end) !== generatedProperty
  ) {
    return undefined;
  }
  const migrated = content
    .replace(
      legacyImportBlock,
      `// opencookie:init:import\n${importLine}\n// /opencookie:init:import`,
    )
    .replace(
      legacyConfigBlock,
      `// opencookie:init:config\n  ${generatedProperty},\n  // /opencookie:init:config`,
    );
  validateExistingMarker(
    path,
    migrated,
    { config: `${generatedProperty},`, import: importLine },
    () => {
      const migratedParsed = parseJavaScript(path, migrated);
      const migratedObject = directDefaultObjectConfig(
        path,
        migratedParsed,
        "defineConfig",
      );
      const migratedProperty = targetConfigProperty(
        path,
        migratedObject,
        "integrations",
      );
      return (
        hasNamedImport(migratedParsed, "astro/config", "defineConfig") &&
        hasDefaultImport(
          migratedParsed,
          "@opencookie-dev/astro",
          "openCookie",
        ) &&
        hasExclusiveModuleBinding(migratedParsed, "openCookie") &&
        migratedProperty !== undefined &&
        migrated.slice(migratedProperty.start, migratedProperty.end) ===
          generatedProperty
      );
    },
  );
  return migrated;
}

async function astroWiring(fileSystem: FileSystemPort): Promise<WiringChanges> {
  const path = await findExistingPath(fileSystem, [
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
  ]);
  if (path === undefined) throw new CliConflictError(["astro.config.mjs"]);
  const content = await fileSystem.readFile(path);
  const importLine = 'import openCookie from "@opencookie-dev/astro";';
  const generatedProperty =
    'integrations: [openCookie({ entrypoint: "/src/opencookie.client.ts" })]';
  const legacyMigration = migrateLegacyAstroWiring(
    path,
    content,
    importLine,
    generatedProperty,
  );
  if (legacyMigration !== undefined) {
    return {
      edits: [edit(path, content, legacyMigration)],
      files: [],
    };
  }
  if (
    validateExistingMarker(
      path,
      content,
      { config: `${generatedProperty},`, import: importLine },
      () => {
        const parsed = parseJavaScript(path, content);
        const object = directDefaultObjectConfig(path, parsed, "defineConfig");
        const property = targetConfigProperty(path, object, "integrations");
        return (
          hasNamedImport(parsed, "astro/config", "defineConfig") &&
          hasDefaultImport(parsed, "@opencookie-dev/astro", "openCookie") &&
          hasExclusiveModuleBinding(parsed, "openCookie") &&
          property !== undefined &&
          content.slice(property.start, property.end) === generatedProperty
        );
      },
    )
  )
    return { edits: [], files: [] };
  const parsed = parseJavaScript(path, content);
  if (!hasNamedImport(parsed, "astro/config", "defineConfig")) {
    throw new CliConflictError([path]);
  }
  assertBindingsAvailable(path, parsed, ["openCookie"]);
  const object = directDefaultObjectConfig(path, parsed, "defineConfig");
  if (targetConfigProperty(path, object, "integrations") !== undefined) {
    throw new CliConflictError([path]);
  }
  let transformed = spliceNode(
    content,
    { end: object.start + 1, start: object.start + 1 },
    `\n  // opencookie:init:config\n  ${generatedProperty},\n  // /opencookie:init:config\n`,
  );
  transformed = prependJavaScriptIntegration(transformed, importLine);
  return { edits: [edit(path, content, transformed)], files: [] };
}

async function plainHtmlWiring(
  fileSystem: FileSystemPort,
  assets: PlainHtmlAssets,
): Promise<WiringChanges> {
  const path = "index.html";
  const content = await fileSystem.readFile(path);
  const script = assets.markup;
  if (
    validateExistingMarker(path, content, { script }, () =>
      isPlainHtmlWired(content, assets),
    )
  )
    return { edits: [], files: [] };
  const root = parseMarkup(content, false);
  const bodies = markupVisits(root).filter(
    ({ node }) => node.tagName === "body",
  );
  if (bodies.length !== 1) throw new CliConflictError([path]);
  const endTag = bodies[0]?.node.sourceCodeLocation?.endTag;
  if (endTag === undefined) throw new CliConflictError([path]);
  const transformed = spliceNode(
    content,
    { end: endTag.startOffset, start: endTag.startOffset },
    `\n<!-- opencookie:init:script -->\n${script}\n<!-- /opencookie:init:script -->\n`,
  );
  return { edits: [edit(path, content, transformed)], files: [] };
}

function wiringChanges(
  framework: SupportedFramework,
  fileSystem: FileSystemPort,
  plainAssets?: PlainHtmlAssets,
): Promise<WiringChanges> {
  switch (framework) {
    case "react-vite":
      return reactViteWiring(fileSystem);
    case "vue-vite":
      return vueViteWiring(fileSystem);
    case "next-app":
      return nextAppWiring(fileSystem);
    case "next-pages":
      return nextPagesWiring(fileSystem);
    case "nuxt":
      return nuxtWiring(fileSystem);
    case "sveltekit":
      return svelteWiring(fileSystem);
    case "astro":
      return astroWiring(fileSystem);
    case "plain-html":
      if (plainAssets === undefined) {
        throw new Error("Plain HTML assets were not prepared.");
      }
      return plainHtmlWiring(fileSystem, plainAssets);
  }
}

function nextStepsFor(
  framework: SupportedFramework,
  files: readonly GeneratedFile[],
  plainAssets?: PlainHtmlAssets,
): readonly string[] {
  const integrationPaths = files
    .map((file) => file.path)
    .filter(
      (path) =>
        path !== ".opencookie-init.json" &&
        path !== "opencookie.config.ts" &&
        path !== "opencookie.policy.ts" &&
        path !== demoScriptAssetPath(framework),
    );
  if (framework === "plain-html") {
    return plainAssets?.selfHosted === true
      ? [
          "The installed browser bundle was copied to vendor/opencookie and wired as an integrity-bound same-origin script.",
          "Customize the data-oc-* attributes in index.html and .opencookie/snippet.html if the starter purpose does not match your site.",
        ]
      : [
          "The pinned CDN bootstrap is wired into index.html; .opencookie/snippet.html contains the same standalone markup.",
          "Customize the data-oc-* attributes in index.html and .opencookie/snippet.html if the starter purpose does not match your site.",
        ];
  }
  return [
    `Review ${integrationPaths.join(" and ")}.`,
    "The generated provider, plugin, or integration is already wired into the detected application entrypoint.",
    "Replace the starter policy with the services and purposes your application actually uses.",
  ];
}

/** Builds an initialization plan without changing the project. @public */
export async function planInitialization(
  fileSystem: FileSystemPort,
  projectRoot: string,
  options: PlanInitializationOptions = {},
): Promise<InitializationPlan> {
  const [framework, packageManager] = await Promise.all([
    detectFramework(fileSystem, projectRoot),
    detectPackageManager(fileSystem, projectRoot),
  ]);
  if (options.selfHost === true && framework !== "plain-html") {
    throw new Error("--self-host is supported only for plain HTML projects.");
  }
  const resolvedPlainAssets =
    framework === "plain-html" ? await plainHtmlAssets(options) : undefined;
  const packages = frameworkPackages[framework];
  const common: GeneratedFile[] =
    framework === "plain-html"
      ? [...(resolvedPlainAssets?.files ?? [])]
      : [
          {
            content: configurationTemplate(framework),
            path: "opencookie.config.ts",
          },
          {
            content: policyTemplate,
            path: "opencookie.policy.ts",
          },
          {
            content: demoScriptAsset,
            path: demoScriptAssetPath(framework),
          },
        ];
  const integration = await integrationFiles(
    framework,
    fileSystem,
    resolvedPlainAssets,
  );
  const wiring = await wiringChanges(
    framework,
    fileSystem,
    resolvedPlainAssets,
  );
  const generated = [...common, ...integration, ...wiring.files];
  const generatedPaths = [
    ...new Set([
      ...generated.map((file) => file.path),
      ...(wiring.managedPaths ?? []),
    ]),
  ].sort();
  const marker: GeneratedFile = {
    content: `${JSON.stringify(
      {
        files: [".opencookie-init.json", ...generatedPaths],
        framework,
        packages,
        schemaVersion: 1,
      },
      undefined,
      2,
    )}\n`,
    path: ".opencookie-init.json",
  };
  const files = Object.freeze([marker, ...generated]);

  return {
    edits: wiring.edits,
    files,
    framework,
    ...(framework === "plain-html"
      ? {}
      : { installCommand: buildInstallCommand(packageManager, packages) }),
    nextSteps: nextStepsFor(framework, files, resolvedPlainAssets),
    packages,
    packageManager,
    projectRoot,
  };
}

const INIT_RECORD_PATH = ".opencookie-init.json";

/** The files an earlier init recorded creating, if it left a readable record. */
async function earlierGeneratedFiles(
  fileSystem: FileSystemPort,
): Promise<ReadonlySet<string>> {
  try {
    if (!(await fileSystem.exists(INIT_RECORD_PATH))) return new Set();
    const record = JSON.parse(await fileSystem.readFile(INIT_RECORD_PATH)) as {
      files?: unknown;
    } | null;
    return new Set(
      Array.isArray(record?.files)
        ? record.files.filter(
            (file): file is string => typeof file === "string",
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Applies a fully preflighted plan and never overwrites differing files. @public */
export async function initializeProject(
  ports: CliPorts,
  options: InitializeProjectOptions,
): Promise<InitializeProjectResult> {
  return ports.fileSystem.withLock(".opencookie-init.lock", () =>
    initializeProjectWhileLocked(ports, options),
  );
}

function dropOneTrailingPeriod(message: string): string {
  return message.endsWith(".") ? message.slice(0, -1) : message;
}

async function initializeProjectWhileLocked(
  ports: CliPorts,
  options: InitializeProjectOptions,
): Promise<InitializeProjectResult> {
  const plan = await planInitialization(ports.fileSystem, options.projectRoot, {
    ...(ports.loadVanillaBrowserAsset === undefined
      ? {}
      : { loadVanillaBrowserAsset: ports.loadVanillaBrowserAsset }),
    ...(options.selfHost === undefined ? {} : { selfHost: options.selfHost }),
  });
  const missing: GeneratedFile[] = [];
  const conflicts: string[] = [];
  // Files an earlier init created belong to the operator from then on: the
  // next steps ask them to edit the policy, and policy install rewrites it.
  const generatedEarlier = await earlierGeneratedFiles(ports.fileSystem);

  for (const file of plan.files) {
    let fileExists: boolean;
    try {
      fileExists = await ports.fileSystem.exists(file.path);
    } catch {
      conflicts.push(file.path);
      continue;
    }
    if (!fileExists) {
      missing.push(file);
    } else {
      try {
        if (
          (await ports.fileSystem.readFile(file.path)) !== file.content &&
          !(file.path !== INIT_RECORD_PATH && generatedEarlier.has(file.path))
        ) {
          conflicts.push(file.path);
        }
      } catch {
        conflicts.push(file.path);
      }
    }
  }
  for (const candidate of plan.edits) {
    let candidateExists: boolean;
    try {
      candidateExists = await ports.fileSystem.exists(candidate.path);
    } catch {
      conflicts.push(candidate.path);
      continue;
    }
    if (!candidateExists) {
      conflicts.push(candidate.path);
      continue;
    }
    try {
      if (
        (await ports.fileSystem.readFile(candidate.path)) !==
        candidate.expectedContent
      ) {
        conflicts.push(candidate.path);
      }
    } catch {
      conflicts.push(candidate.path);
    }
  }

  if (conflicts.length > 0) throw new CliConflictError(conflicts.sort());
  if (missing.length === 0 && plan.edits.length === 0) {
    ports.writeLine("OpenCookie is already initialized. No files changed.");
    return { framework: plan.framework, status: "unchanged" };
  }

  if (
    !options.yes &&
    !(await ports.confirm(
      `Initialize OpenCookie for ${frameworkLabels[plan.framework]}, create ${String(missing.length)} files, and update ${String(plan.edits.length)} entrypoints?`,
    ))
  ) {
    return { status: "cancelled" };
  }

  if (plan.installCommand !== undefined) {
    try {
      await ports.command.run(
        plan.installCommand.command,
        plan.installCommand.args,
        plan.projectRoot,
      );
    } catch (error: unknown) {
      const original = dropOneTrailingPeriod(
        error instanceof Error ? error.message : String(error),
      );
      const remainder =
        missing.length === 0
          ? "Fix the install and run init again to finish."
          : `Fix the install and run init again; it then creates ${missing
              .map((file) => file.path)
              .sort()
              .join(", ")}.`;
      throw new Error(`${original}. Init wrote nothing. ${remainder}`, {
        cause: error,
      });
    }
  }
  // The record is written last, so it never describes a run that stopped. A
  // rerun finds what was written unchanged and completes the rest.
  const written: string[] = [];
  const record = missing.find((file) => file.path === INIT_RECORD_PATH);
  try {
    for (const file of missing) {
      if (file === record) continue;
      const directory = dirname(file.path);
      if (directory !== ".") await ports.fileSystem.mkdir(directory);
      await ports.fileSystem.writeFile(file.path, file.content);
      written.push(file.path);
    }
    for (const candidate of plan.edits) {
      await ports.fileSystem.replaceFile(
        candidate.path,
        candidate.expectedContent,
        candidate.content,
      );
      written.push(candidate.path);
    }
    if (record !== undefined) {
      await ports.fileSystem.writeFile(record.path, record.content);
    }
  } catch (error: unknown) {
    const detail = dropOneTrailingPeriod(
      error instanceof Error ? error.message : String(error),
    );
    throw new Error(
      `${detail}. Init stopped after writing ${written.length === 0 ? "nothing" : written.join(", ")}. Fix the cause and run init again to finish.`,
      { cause: error },
    );
  }

  ports.writeLine(
    `OpenCookie initialized for ${frameworkLabels[plan.framework]}.`,
  );
  for (const nextStep of plan.nextSteps) ports.writeLine(`Next: ${nextStep}`);
  return { framework: plan.framework, status: "initialized" };
}
