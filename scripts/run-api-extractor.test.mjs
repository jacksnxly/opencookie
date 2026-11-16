import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  collectApiExtractorConfigs,
  declarationBuildCommand,
  runApiExtractor,
  stageCoreApplicationApiDeclaration,
} from "./run-api-extractor-lib.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "opencookie-api-"));
  for (const [name, configs] of [
    ["z-package", ["api-extractor.json"]],
    ["a-package", ["api-extractor.beta.json", "api-extractor.json"]],
  ]) {
    const directory = join(root, "packages", name);
    mkdirSync(directory, { recursive: true });
    for (const config of configs) writeFileSync(join(directory, config), "{}");
  }
  return root;
}

test("discovers API configurations deterministically", () => {
  const root = fixture();
  try {
    assert.deepEqual(
      collectApiExtractorConfigs(root).map((path) =>
        path.slice(root.length + 1),
      ),
      [
        "packages/a-package/api-extractor.beta.json",
        "packages/a-package/api-extractor.json",
        "packages/z-package/api-extractor.json",
      ],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("stages the application declaration as a sibling public product", () => {
  const root = fixture();
  try {
    const core = join(root, "packages", "core");
    mkdirSync(join(core, "dist"), { recursive: true });
    writeFileSync(join(core, "api-extractor.application.json"), "{}\n");
    writeFileSync(
      join(core, "dist", "application.d.ts"),
      'import type { ConsentPolicyReconciliation } from "@opencookie-dev/core/reconciliation";\nexport interface Projection { readonly reconciliation?: ConsentPolicyReconciliation }\n',
    );

    const stage = stageCoreApplicationApiDeclaration(root);
    assert.equal(
      stage,
      join(root, ".cache", "api-extractor", "core-application"),
    );
    assert.match(
      readFileSync(join(stage, "application.d.ts"), "utf8"),
      /@opencookie-dev\/core\/reconciliation/u,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(stage, "package.json"), "utf8")),
      {
        name: "@opencookie-dev/core-application-api",
        private: true,
        version: "0.0.0",
      },
    );
    assert.match(
      readFileSync(join(stage, "reconciliation-external.d.ts"), "utf8"),
      /declare module "@opencookie-dev\/core\/reconciliation"/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("builds canonical package declarations before every API comparison", () => {
  const root = fixture();
  const calls = [];
  try {
    const status = runApiExtractor({
      local: true,
      rootDir: root,
      run(command, args, options) {
        calls.push({ args, command, cwd: options.cwd });
        return { status: 0, stderr: "", stdout: "" };
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(calls[0], {
      args: [
        "--filter",
        "./packages/**",
        "--fail-if-no-match",
        "--if-present",
        "run",
        "build",
      ],
      command: "pnpm",
      cwd: root,
    });
    assert.equal(calls.length, 4);
    for (const call of calls.slice(1)) {
      assert.equal(call.command, process.execPath);
      assert.equal(call.cwd, root);
      assert.ok(call.args.includes("--local"));
    }
    assert.deepEqual(
      calls
        .slice(1)
        .map((call) =>
          call.args[call.args.indexOf("--config") + 1].slice(root.length + 1),
        ),
      [
        "packages/a-package/api-extractor.beta.json",
        "packages/a-package/api-extractor.json",
        "packages/z-package/api-extractor.json",
      ],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("stops before API comparison when declaration build fails", () => {
  const root = fixture();
  const calls = [];
  try {
    const status = runApiExtractor({
      rootDir: root,
      run(command, args, options) {
        calls.push({ args, command, cwd: options.cwd });
        return { status: 19, stderr: "build failed\n", stdout: "" };
      },
      stderr: { write: () => undefined },
    });

    assert.equal(status, 19);
    assert.deepEqual(calls, [
      {
        args: [
          "--filter",
          "./packages/**",
          "--fail-if-no-match",
          "--if-present",
          "run",
          "build",
        ],
        command: "pnpm",
        cwd: root,
      },
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("uses an explicit command interpreter for the Windows pnpm shim", () => {
  assert.deepEqual(
    declarationBuildCommand({
      comspec: "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
    }),
    {
      args: [
        "/d",
        "/s",
        "/c",
        '"pnpm.cmd --filter ./packages/** --fail-if-no-match --if-present run build"',
      ],
      command: "C:\\Windows\\System32\\cmd.exe",
      windowsVerbatimArguments: true,
    },
  );
  assert.deepEqual(declarationBuildCommand({ platform: "linux" }), {
    args: [
      "--filter",
      "./packages/**",
      "--fail-if-no-match",
      "--if-present",
      "run",
      "build",
    ],
    command: "pnpm",
  });
});

test("passes the Windows command line verbatim to cmd.exe", () => {
  const root = fixture();
  const calls = [];
  try {
    const status = runApiExtractor({
      comspec: "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
      rootDir: root,
      run(command, args, options) {
        calls.push({ args, command, options });
        return { status: 0, stderr: "", stdout: "" };
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(calls[0], {
      args: [
        "/d",
        "/s",
        "/c",
        '"pnpm.cmd --filter ./packages/** --fail-if-no-match --if-present run build"',
      ],
      command: "C:\\Windows\\System32\\cmd.exe",
      options: {
        cwd: root,
        encoding: "utf8",
        windowsVerbatimArguments: true,
      },
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("reports launch errors and terminating signals", () => {
  const root = fixture();
  try {
    for (const [result, expected] of [
      [{ error: new Error("ENOENT"), status: null }, "ENOENT"],
      [{ signal: "SIGTERM", status: null }, "SIGTERM"],
    ]) {
      let diagnostic = "";
      const status = runApiExtractor({
        rootDir: root,
        run: () => result,
        stderr: { write: (value) => (diagnostic += value) },
      });
      assert.equal(status, 1);
      assert.match(diagnostic, new RegExp(expected, "u"));
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rebuilds poisoned declarations in a disposable pnpm workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "opencookie-api-real-"));
  try {
    mkdirSync(
      join(root, "node_modules", "@microsoft", "api-extractor", "bin"),
      {
        recursive: true,
      },
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "api-order-fixture",
        private: true,
        scripts: { typecheck: "node poison.mjs" },
      }),
    );
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writeFileSync(
      join(root, "poison.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'for (const name of ["alpha", "beta"]) {',
        "  mkdirSync(`packages/${name}/dist`, { recursive: true });",
        '  writeFileSync(`packages/${name}/dist/index.d.ts`, "export type Poisoned = never;\\n");',
        "}",
      ].join("\n"),
    );
    for (const name of ["alpha", "beta"]) {
      const directory = join(root, "packages", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: `@fixture/${name}`,
          scripts: { build: "node build.mjs" },
        }),
      );
      writeFileSync(
        join(directory, "build.mjs"),
        [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync("dist", { recursive: true });',
          `writeFileSync("dist/index.d.ts", "export declare const ${name}: unique symbol;\\n");`,
        ].join("\n"),
      );
      writeFileSync(
        join(directory, "api-extractor.json"),
        JSON.stringify({
          mainEntryPointFilePath: "<projectFolder>/dist/index.d.ts",
        }),
      );
    }
    writeFileSync(
      join(
        root,
        "node_modules",
        "@microsoft",
        "api-extractor",
        "bin",
        "api-extractor",
      ),
      [
        'import { appendFileSync, readFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'const configIndex = process.argv.indexOf("--config");',
        "const config = process.argv[configIndex + 1];",
        'const declaration = readFileSync(join(dirname(config), "dist/index.d.ts"), "utf8");',
        'if (declaration.includes("Poisoned")) process.exit(23);',
        'appendFileSync(join(process.cwd(), "extractor.log"), `${config}:${process.argv.includes("--local") ? "local" : "check"}\\n`);',
      ].join("\n"),
    );

    const poisoned = spawnSync("pnpm", ["typecheck"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(poisoned.status, 0, poisoned.stderr);
    assert.equal(runApiExtractor({ rootDir: root }), 0);
    assert.equal(runApiExtractor({ local: true, rootDir: root }), 0);

    for (const name of ["alpha", "beta"]) {
      assert.equal(
        readFileSync(
          join(root, "packages", name, "dist", "index.d.ts"),
          "utf8",
        ),
        `export declare const ${name}: unique symbol;\n`,
      );
    }
    const log = readFileSync(join(root, "extractor.log"), "utf8");
    assert.equal((log.match(/:check$/gmu) ?? []).length, 2);
    assert.equal((log.match(/:local$/gmu) ?? []).length, 2);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
