import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function declarationBuildCommand({
  comspec = process.env.ComSpec,
  platform = process.platform,
} = {}) {
  const args = [
    "--filter",
    "./packages/**",
    "--fail-if-no-match",
    "--if-present",
    "run",
    "build",
  ];
  if (platform !== "win32") return { args, command: "pnpm" };

  return {
    args: [
      "/d",
      "/s",
      "/c",
      '"pnpm.cmd --filter ./packages/** --fail-if-no-match --if-present run build"',
    ],
    command: comspec || "cmd.exe",
    windowsVerbatimArguments: true,
  };
}

function collect(directory, configs) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(directory, entry.name);
    for (const configEntry of readdirSync(candidate, { withFileTypes: true })) {
      if (
        configEntry.isFile() &&
        /^api-extractor(?:\.[a-z0-9-]+)?\.json$/u.test(configEntry.name)
      ) {
        configs.push(join(candidate, configEntry.name));
      }
    }
    collect(candidate, configs);
  }
}

export function collectApiExtractorConfigs(rootDir) {
  const configs = [];
  collect(join(rootDir, "packages"), configs);
  return configs.sort();
}

export function stageCoreApplicationApiDeclaration(rootDir) {
  const applicationConfig = join(
    rootDir,
    "packages",
    "core",
    "api-extractor.application.json",
  );
  if (!existsSync(applicationConfig)) return undefined;

  const declaration = join(
    rootDir,
    "packages",
    "core",
    "dist",
    "application.d.ts",
  );
  if (!existsSync(declaration)) {
    throw new Error(
      "The core application API declaration is missing after the canonical package build.",
    );
  }

  const stage = join(rootDir, ".cache", "api-extractor", "core-application");
  mkdirSync(stage, { recursive: true });
  copyFileSync(declaration, join(stage, "application.d.ts"));
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        name: "@opencookie-dev/core-application-api",
        private: true,
        version: "0.0.0",
      },
      undefined,
      2,
    )}\n`,
  );
  writeFileSync(
    join(stage, "reconciliation-external.d.ts"),
    [
      'declare module "@opencookie-dev/core/reconciliation" {',
      "  export type ConsentPolicyReconciliation = object;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(stage, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ES2022", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          target: "ES2022",
        },
        files: ["application.d.ts", "reconciliation-external.d.ts"],
      },
      undefined,
      2,
    )}\n`,
  );
  return stage;
}

function forward(result, stdout, stderr) {
  stdout.write(result.stdout ?? "");
  stderr.write(result.stderr ?? "");
}

function resultStatus(result, label, stderr) {
  if (result.error) {
    stderr.write(`${label} could not start: ${result.error.message}\n`);
    return 1;
  }
  if (result.signal) {
    stderr.write(`${label} terminated by signal ${result.signal}.\n`);
    return 1;
  }
  if (typeof result.status !== "number") {
    stderr.write(`${label} exited without a status.\n`);
    return 1;
  }
  return result.status;
}

export function runApiExtractor({
  rootDir,
  local = false,
  run = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
  platform = process.platform,
  comspec = process.env.ComSpec,
}) {
  const configs = collectApiExtractorConfigs(rootDir);
  if (configs.length === 0) {
    stderr.write("No API Extractor package configurations were found.\n");
    return 1;
  }

  const declarationBuild = declarationBuildCommand({ comspec, platform });
  const build = run(declarationBuild.command, declarationBuild.args, {
    cwd: rootDir,
    encoding: "utf8",
    ...(declarationBuild.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  });
  forward(build, stdout, stderr);
  const buildStatus = resultStatus(build, "Declaration build", stderr);
  if (buildStatus !== 0) return buildStatus;

  try {
    stageCoreApplicationApiDeclaration(rootDir);
  } catch (error) {
    stderr.write(
      `API declaration staging failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  for (const config of configs) {
    const result = run(
      process.execPath,
      [
        join(
          rootDir,
          "node_modules/@microsoft/api-extractor/bin/api-extractor",
        ),
        "run",
        "--config",
        config,
        ...(local ? ["--local"] : []),
      ],
      { cwd: rootDir, encoding: "utf8" },
    );
    forward(result, stdout, stderr);
    const extractorStatus = resultStatus(result, "API Extractor", stderr);
    if (extractorStatus !== 0) return extractorStatus;
  }

  return 0;
}
