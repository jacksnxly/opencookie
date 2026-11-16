import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DX_CASES,
  buildDxWorkflowContracts,
  parseDxSelection,
} from "./dx-catalogue.mjs";

// @opencookie-dev/next accepts Next.js 15 and 16, so the packed
// install check scaffolds a Next.js 15 App Router app as well as Next.js 16.

describe("the Next.js 15 packed DX case", () => {
  it("scaffolds a Next.js 15.5.9 App Router app with pinned, shell-free flags", () => {
    const definition = DX_CASES.find(({ id }) => id === "next15-app");
    assert.ok(definition, "next15-app is a DX case");
    const next16 = DX_CASES.find(({ id }) => id === "next-app");
    assert.equal(definition.expectedFrameworkLabel, "Next.js App Router");
    assert.equal(definition.packageManager, "pnpm");
    // Next.js 15 depends on sharp, whose install script pnpm runs only when approved.
    assert.deepEqual(definition.allowBuilds, ["sharp"]);
    assert.equal(definition.scaffold.command, "pnpm");
    assert.deepEqual(definition.scaffold.args, [
      "dlx",
      "create-next-app@15.5.9",
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
    ]);
    assert.deepEqual(definition.build, next16.build);
    assert.deepEqual(definition.serve, next16.serve);
  });

  it("runs on its own", () => {
    assert.deepEqual(
      parseDxSelection(["--case=next15-app"]).map(({ id }) => id),
      ["next15-app"],
    );
  });

  it("has a guide of its own", () => {
    const definition = DX_CASES.find(({ id }) => id === "next15-app");
    assert.ok(definition, "next15-app is a DX case");
    const [contract] = buildDxWorkflowContracts([definition]);
    assert.equal(contract.guide, "next-15-app.mdx");
  });
});
