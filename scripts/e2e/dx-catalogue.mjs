export const DX_BUDGET_MS = 60_000;

function command(commandName, args) {
  return Object.freeze({ command: commandName, args: Object.freeze(args) });
}

function definition({
  allowBuilds = [],
  build,
  expectedFrameworkLabel,
  id,
  packageManager,
  scaffold,
  serve,
}) {
  return Object.freeze({
    allowBuilds: Object.freeze(allowBuilds),
    build,
    expectedFrameworkLabel,
    id,
    packageManager,
    scaffold,
    serve,
    timeoutMs: DX_BUDGET_MS,
  });
}

export const DX_CASES = Object.freeze([
  definition({
    id: "plain-cdn",
    expectedFrameworkLabel: "plain HTML",
    packageManager: "none",
    scaffold: command("internal", ["plain-html"]),
    build: command("internal", ["html-check"]),
    serve: command("internal", ["static-html"]),
  }),
  definition({
    id: "react-vite",
    expectedFrameworkLabel: "React with Vite",
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "create-vite@9.1.2",
      ".",
      "--template",
      "react-ts",
      "--no-interactive",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("pnpm", [
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "{port}",
    ]),
  }),
  definition({
    id: "vue-vite",
    expectedFrameworkLabel: "Vue with Vite",
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "create-vite@9.1.2",
      ".",
      "--template",
      "vue-ts",
      "--no-interactive",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("pnpm", [
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "{port}",
    ]),
  }),
  definition({
    id: "next-app",
    expectedFrameworkLabel: "Next.js App Router",
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "create-next-app@16.4.6",
      ".",
      "--ts",
      "--no-linter",
      "--no-tailwind",
      "--app",
      "--empty",
      "--no-src-dir",
      "--no-react-compiler",
      "--import-alias",
      "@/*",
      "--no-agents-md",
      "--disable-git",
      "--skip-install",
      "--yes",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("pnpm", [
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "{port}",
    ]),
  }),
  definition({
    id: "next-pages",
    expectedFrameworkLabel: "Next.js Pages Router",
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "create-next-app@16.4.6",
      ".",
      "--ts",
      "--no-linter",
      "--no-tailwind",
      "--no-app",
      "--empty",
      "--no-src-dir",
      "--no-react-compiler",
      "--import-alias",
      "@/*",
      "--no-agents-md",
      "--disable-git",
      "--skip-install",
      "--yes",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("pnpm", [
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "{port}",
    ]),
  }),
  definition({
    id: "next15-app",
    expectedFrameworkLabel: "Next.js App Router",
    allowBuilds: ["sharp"],
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "create-next-app@15.5.29",
      ".",
      "--ts",
      "--no-eslint",
      "--no-tailwind",
      "--app",
      "--empty",
      "--no-src-dir",
      "--no-turbopack",
      "--import-alias",
      "@/*",
      "--disable-git",
      "--skip-install",
      "--yes",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("pnpm", [
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "{port}",
    ]),
  }),
  definition({
    id: "nuxt",
    expectedFrameworkLabel: "Nuxt",
    allowBuilds: ["esbuild"],
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "create-nuxt@3.37.0",
      ".",
      "--template",
      "minimal",
      "--force",
      "--packageManager",
      "pnpm",
      "--no-install",
      "--gitInit=false",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("node", [".output/server/index.mjs"]),
  }),
  definition({
    id: "sveltekit",
    expectedFrameworkLabel: "SvelteKit",
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "sv@1.4.0",
      "create",
      ".",
      "--template",
      "minimal",
      "--types",
      "ts",
      "--no-add-ons",
      "--no-install",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("pnpm", [
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "{port}",
    ]),
  }),
  definition({
    id: "astro",
    expectedFrameworkLabel: "Astro",
    allowBuilds: ["esbuild", "sharp"],
    packageManager: "pnpm",
    scaffold: command("pnpm", [
      "dlx",
      "create-astro@5.2.3",
      ".",
      "--template",
      "minimal",
      "--no-install",
      "--no-git",
      "--no-ai",
      "--skip-houston",
      "--yes",
    ]),
    build: command("pnpm", ["build"]),
    serve: command("pnpm", [
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "{port}",
    ]),
  }),
]);

export const DX_CASE_IDS = Object.freeze(DX_CASES.map(({ id }) => id));

export function parseDxSelection(args) {
  let selected;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let value;
    if (argument?.startsWith("--case=")) {
      value = argument.slice("--case=".length);
    } else if (argument === "--case") {
      value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--case requires a value.");
      }
      index += 1;
    } else {
      throw new Error(`Unknown DX argument: ${String(argument)}`);
    }
    if (selected !== undefined) {
      throw new Error("Only one --case value is supported per DX process.");
    }
    selected = value;
  }
  if (selected === undefined) return DX_CASES;
  const definition = DX_CASES.find(({ id }) => id === selected);
  if (definition === undefined) throw new Error(`Unknown DX case: ${selected}`);
  return Object.freeze([definition]);
}

function initInvocation(definition, { registryUrl } = {}) {
  return command("npx", [
    "--yes",
    ...(registryUrl === undefined ? [] : [`--registry=${registryUrl}`]),
    "opencookie@0.4.2",
    "init",
    "--yes",
    ...(definition.id === "plain-cdn" ? ["--self-host"] : []),
  ]);
}

const GUIDE_BY_CASE = Object.freeze({
  astro: "astro.mdx",
  "next-app": "next-app.mdx",
  "next-pages": "next-pages.mdx",
  "next15-app": "next-15-app.mdx",
  nuxt: "nuxt.mdx",
  "plain-cdn": "plain-html.mdx",
  "react-vite": "react-vite.mdx",
  sveltekit: "sveltekit.mdx",
  "vue-vite": "vue-vite.mdx",
});

export const PASS_C_CHECK_NUMBERS = Object.freeze({
  scaffold: "01",
  document: "02",
  "approve-builds": "03",
  install: "04",
  init: "05",
  build: "06",
  "test-manifest": "07",
  "test-setup": "08",
  "browser-setup": "09",
  render: "10",
  persistence: "11",
});

export const PASS_C_ALL_CHECK_IDS = Object.freeze(
  Object.keys(PASS_C_CHECK_NUMBERS),
);

function quoteShellArgument(value) {
  if (/^[A-Za-z\d_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderDxWorkflowCommand(invocation) {
  if (invocation === undefined) return "none";
  return [invocation.command, ...invocation.args]
    .map(quoteShellArgument)
    .join(" ");
}

function installInvocation(packageManager) {
  if (packageManager === "none") return undefined;
  if (packageManager === "npm") {
    return command("npm", ["install", "--no-audit", "--no-fund"]);
  }
  if (packageManager === "pnpm") {
    return command("pnpm", ["install", "--no-frozen-lockfile"]);
  }
  throw new TypeError(
    `Unsupported DX workflow package manager: ${packageManager}`,
  );
}

function scaffoldInvocation(definition) {
  if (definition.scaffold.command !== "internal") {
    return command(definition.scaffold.command, definition.scaffold.args);
  }
  if (
    definition.id === "plain-cdn" &&
    definition.scaffold.args.length === 1 &&
    definition.scaffold.args[0] === "plain-html"
  ) {
    return command("touch", ["index.html"]);
  }
  throw new TypeError(
    `Unsupported internal DX scaffold contract for ${definition.id}.`,
  );
}

function buildInvocation(definition) {
  if (definition.build.command !== "internal") {
    return command(definition.build.command, definition.build.args);
  }
  if (
    definition.id === "plain-cdn" &&
    definition.build.args.length === 1 &&
    definition.build.args[0] === "html-check"
  ) {
    return undefined;
  }
  throw new TypeError(
    `Unsupported internal DX build contract for ${definition.id}.`,
  );
}

function serveInvocation(definition) {
  if (
    definition.id === "plain-cdn" &&
    definition.serve.command === "internal" &&
    definition.serve.args.length === 1 &&
    definition.serve.args[0] === "static-html"
  ) {
    return command("python3", ["-m", "http.server", "4173"]);
  }
  if (definition.serve.command === "internal") {
    throw new TypeError(
      `Unsupported internal DX serve contract for ${definition.id}.`,
    );
  }
  return command(
    definition.serve.command,
    definition.serve.args.map((argument) =>
      argument === "{port}" ? "4173" : argument,
    ),
  );
}

function fileMaterializationInvocation(
  file,
  source,
  { exclusive = false } = {},
) {
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError(`${file} materialization requires nonempty bytes.`);
  }
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return command("node", [
    "--input-type=module",
    "--eval",
    `import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(file)}, Buffer.from(${JSON.stringify(encoded)}, "base64")${exclusive ? ', { flag: "wx" }' : ""});`,
  ]);
}

export function plainDocumentInvocation(plainMinimalSource) {
  return fileMaterializationInvocation("index.html", plainMinimalSource);
}

export function buildApprovalInvocation(packageNames) {
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    return undefined;
  }
  const source = [
    "allowBuilds:",
    ...[...new Set(packageNames)]
      .sort()
      .map((packageName) => `  ${JSON.stringify(packageName)}: true`),
    "",
  ].join("\n");
  return fileMaterializationInvocation("pnpm-workspace.yaml", source, {
    exclusive: true,
  });
}

function testManifestInvocation() {
  return fileMaterializationInvocation(
    "package.json",
    `${JSON.stringify(
      {
        name: "opencookie-pass-c-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
    { exclusive: true },
  );
}

function documentedSteps(definition, plainMinimalSource) {
  const steps = [
    Object.freeze({
      command: scaffoldInvocation(definition),
      id: "scaffold",
      label: "Scaffold",
    }),
  ];
  if (definition.id === "plain-cdn") {
    steps.push(
      Object.freeze({
        command:
          plainMinimalSource === undefined
            ? undefined
            : plainDocumentInvocation(plainMinimalSource),
        id: "document",
        label: "Create page",
        sampleId: "plain-minimal",
      }),
    );
  }
  const approval = buildApprovalInvocation(definition.allowBuilds);
  if (approval !== undefined) {
    steps.push(
      Object.freeze({
        command: approval,
        id: "approve-builds",
        label: "Approve builds",
      }),
    );
  }
  steps.push(
    Object.freeze({
      command: installInvocation(definition.packageManager),
      id: "install",
      label: "Install",
    }),
    Object.freeze({
      command: initInvocation(definition),
      id: "init",
      label: "Initialize",
    }),
    Object.freeze({
      command: buildInvocation(definition),
      id: "build",
      label: "Build",
    }),
    Object.freeze({
      command: serveInvocation(definition),
      id: "serve",
      label: "Serve",
    }),
  );
  return Object.freeze(steps);
}

export function buildDxWorkflowContracts(
  definitions,
  { plainMinimalSource } = {},
) {
  return Object.freeze(
    definitions.map((definition) => {
      const guide = GUIDE_BY_CASE[definition.id];
      if (guide === undefined) {
        throw new TypeError(
          `DX case ${definition.id} has no documentation guide mapping.`,
        );
      }
      return Object.freeze({
        definition,
        documentedSteps: documentedSteps(definition, plainMinimalSource),
        guide,
        id: definition.id,
      });
    }),
  );
}

export function passCCheckIdsForDefinition(definition) {
  const ids = ["scaffold"];
  if (definition.id === "plain-cdn") ids.push("document");
  if (definition.allowBuilds.length > 0) ids.push("approve-builds");
  if (definition.packageManager !== "none") ids.push("install");
  ids.push("init");
  if (definition.build.command !== "internal") ids.push("build");
  if (definition.id === "plain-cdn") ids.push("test-manifest");
  ids.push("test-setup", "browser-setup", "render", "persistence");
  return Object.freeze(ids);
}

export function passCEvidenceName(id) {
  const number = PASS_C_CHECK_NUMBERS[id];
  if (number === undefined) {
    throw new TypeError(`Unknown Pass C workflow check ID: ${id}`);
  }
  return `${number}-${id}.log`;
}

export function passCInnerCommand(
  definition,
  id,
  { configPath, plainMinimalSource, registryUrl, scratchPath, testPath },
) {
  if (id === "scaffold") return scaffoldInvocation(definition);
  if (id === "document") return plainDocumentInvocation(plainMinimalSource);
  if (id === "approve-builds") {
    return buildApprovalInvocation(definition.allowBuilds);
  }
  if (id === "install") return installInvocation(definition.packageManager);
  if (id === "init") {
    return initInvocation(definition, { registryUrl });
  }
  if (id === "build") return buildInvocation(definition);
  if (id === "test-manifest") return testManifestInvocation();
  if (id === "test-setup") {
    return definition.packageManager === "pnpm"
      ? command("pnpm", [
          "add",
          "-D",
          "--save-exact",
          "--ignore-scripts",
          "@playwright/test@1.65.1",
        ])
      : command("npm", [
          "install",
          "--save-dev",
          "--save-exact",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "@playwright/test@1.65.1",
        ]);
  }
  if (id === "browser-setup") {
    return command("npx", [
      "--no-install",
      "playwright",
      "install",
      "chromium",
    ]);
  }
  if (id === "render" || id === "persistence") {
    const tag = id === "render" ? "@render" : "@persistence";
    return command("npx", [
      "--no-install",
      "playwright",
      "test",
      testPath ?? `${scratchPath}/consumer.spec.mjs`,
      "--config",
      configPath ?? `${scratchPath}/playwright.config.mjs`,
      "--grep",
      tag,
      "--reporter=line",
      "--workers=1",
      "--retries=0",
    ]);
  }
  throw new TypeError(`Unsupported Pass C workflow check ID: ${id}`);
}
