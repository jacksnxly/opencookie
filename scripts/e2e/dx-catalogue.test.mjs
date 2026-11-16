import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDxWorkflowContracts,
  DX_BUDGET_MS,
  DX_CASES,
  DX_CASE_IDS,
  parseDxSelection,
  passCInnerCommand,
} from "./dx-catalogue.mjs";

describe("packed initializer DX catalogue", () => {
  it("covers every supported project with pinned, shell-free commands", () => {
    assert.equal(DX_BUDGET_MS, 60_000);
    assert.deepEqual(DX_CASE_IDS, [
      "plain-cdn",
      "react-vite",
      "vue-vite",
      "next-app",
      "next-pages",
      "next15-app",
      "nuxt",
      "sveltekit",
      "astro",
    ]);
    assert.equal(new Set(DX_CASE_IDS).size, 9);
    for (const definition of DX_CASES) {
      assert.equal(definition.timeoutMs, DX_BUDGET_MS);
      assert.ok(definition.scaffold.command.length > 0);
      assert.ok(definition.build.command.length > 0);
      assert.ok(definition.serve.command.length > 0);
      assert.doesNotMatch(
        [
          definition.scaffold.command,
          ...definition.scaffold.args,
          definition.build.command,
          ...definition.build.args,
        ].join(" "),
        /\blatest\b|[;&|`]/u,
      );
    }
  });

  it("selects all cases by default or one exact requested case", () => {
    assert.deepEqual(
      parseDxSelection([]).map(({ id }) => id),
      DX_CASE_IDS,
    );
    assert.deepEqual(
      parseDxSelection(["--case=next-app"]).map(({ id }) => id),
      ["next-app"],
    );
    assert.deepEqual(
      parseDxSelection(["--case", "astro"]).map(({ id }) => id),
      ["astro"],
    );
    assert.throws(
      () => parseDxSelection(["--case=unknown"]),
      /Unknown DX case/u,
    );
    assert.throws(() => parseDxSelection(["--case"]), /requires a value/u);
  });

  it("keeps both cold Next lifecycles on the deterministic pnpm path", () => {
    const nextCases = DX_CASES.filter(({ id }) => id.startsWith("next-"));
    assert.equal(nextCases.length, 2);
    for (const definition of nextCases) {
      assert.equal(definition.packageManager, "pnpm");
      assert.equal(definition.build.command, "pnpm");
      assert.equal(definition.serve.command, "pnpm");
      assert.deepEqual(definition.allowBuilds, []);
      assert.ok(definition.scaffold.args.includes("--empty"));
      assert.ok(definition.scaffold.args.includes("--no-linter"));
      assert.equal(definition.scaffold.args.includes("--eslint"), false);
    }
  });

  it("keeps Astro on the repository-standard pnpm lifecycle", () => {
    const astro = DX_CASES.find(({ id }) => id === "astro");
    assert.ok(astro);
    assert.equal(astro.packageManager, "pnpm");
    assert.equal(astro.build.command, "pnpm");
    assert.equal(astro.serve.command, "pnpm");
    assert.ok(astro.scaffold.args.includes("--skip-houston"));
    assert.deepEqual(astro.allowBuilds, ["esbuild", "sharp"]);
  });

  it("keeps Vite and SvelteKit on the repository-standard pnpm lifecycle", () => {
    const caseIds = ["react-vite", "vue-vite", "sveltekit"];
    for (const caseId of caseIds) {
      const definition = DX_CASES.find(({ id }) => id === caseId);
      assert.ok(definition);
      assert.equal(definition.packageManager, "pnpm");
      assert.equal(definition.build.command, "pnpm");
      assert.equal(definition.serve.command, "pnpm");
    }
  });

  it("uses self-hosting only for the plain HTML initialization workflow", () => {
    const contracts = buildDxWorkflowContracts(DX_CASES, {
      plainMinimalSource: "<!doctype html><html><body></body></html>\n",
    });
    for (const contract of contracts) {
      const documentedInit = contract.documentedSteps.find(
        ({ id }) => id === "init",
      )?.command;
      assert.ok(documentedInit);
      assert.equal(
        documentedInit.args.includes("--self-host"),
        contract.id === "plain-cdn",
      );

      const passCInit = passCInnerCommand(contract.definition, "init", {
        configPath: "/tmp/playwright.config.ts",
        plainMinimalSource: "<!doctype html><html><body></body></html>\n",
        registryUrl: "http://127.0.0.1:4873",
        scratchPath: "/tmp/scratch",
        testPath: "/tmp/test.spec.ts",
      });
      assert.equal(
        passCInit.args.includes("--self-host"),
        contract.id === "plain-cdn",
      );
    }
  });

  it("forces Nuxt into the pre-created consumer directory", () => {
    const nuxt = DX_CASES.find(({ id }) => id === "nuxt");
    assert.ok(nuxt);
    assert.ok(nuxt.scaffold.args.includes("--force"));
    assert.ok(nuxt.scaffold.args.includes("--gitInit=false"));
    assert.equal(nuxt.scaffold.args.includes("--gitInit"), false);
    assert.deepEqual(nuxt.allowBuilds, ["esbuild"]);
  });
});
