import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const SRC_ROOT = new URL("../", import.meta.url);
const AUTO_ENTRY = new URL("../auto.ts", import.meta.url);

const PUBLIC_BARRELS = new Set(
  [
    "index.ts",
    "domain.ts",
    "application.ts",
    "infrastructure.ts",
    "application/index.ts",
    "infrastructure/index.ts",
  ].map((relative) => new URL(relative, SRC_ROOT).href),
);

function moduleSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const fromPattern =
    /(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(fromPattern)) {
    const clause = match[1]?.trim() ?? "";
    const specifier = match[2];
    const namedEntries = clause.startsWith("{")
      ? clause
          .slice(1, -1)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    if (
      clause.startsWith("type ") ||
      (namedEntries.length > 0 &&
        namedEntries.every((entry) => entry.startsWith("type ")))
    ) {
      continue;
    }
    if (specifier !== undefined) specifiers.push(specifier);
  }
  const sideEffectPattern = /^\s*import\s+["']([^"']+)["']/gmu;
  for (const match of source.matchAll(sideEffectPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveSpecifier(moduleUrl: string, specifier: string): string {
  return new URL(specifier.replace(/\.js$/u, ".ts"), moduleUrl).href;
}

function walkStaticImports(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const moduleUrl = queue.pop();
    if (moduleUrl === undefined || visited.has(moduleUrl)) continue;
    visited.add(moduleUrl);
    const source = readFileSync(new URL(moduleUrl), "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        throw new Error(
          `The auto graph must stay inside core source modules; ${moduleUrl} imports ${specifier}.`,
        );
      }
      queue.push(resolveSpecifier(moduleUrl, specifier));
    }
  }
  return visited;
}

it("keeps the auto product free of any static consent-evidence path", () => {
  expect(
    existsSync(AUTO_ENTRY),
    "packages/core/src/auto.ts must exist as the only public auto barrel",
  ).toBe(true);

  const reached = walkStaticImports(AUTO_ENTRY.href);

  const forbiddenRuntimeModules = [
    "application/runtime/snapshot-consent-runtime-projection-context.ts",
    "application/runtime/reconcile-policy.ts",
    "domain/consent-decisioning/plan-reconsent.ts",
    "domain/policy-catalogue/define-policy.ts",
    "domain/policy-catalogue/define-resource-policy.ts",
    "domain/policy-catalogue/diff-policies.ts",
  ];
  expect(
    [...reached]
      .filter((moduleUrl) =>
        forbiddenRuntimeModules.some((suffix) => moduleUrl.endsWith(suffix)),
      )
      .map((moduleUrl) => new URL(moduleUrl).pathname)
      .sort(),
  ).toEqual([]);

  const evidence = [...reached].filter((moduleUrl) =>
    moduleUrl.includes("domain/consent-evidence/"),
  );
  expect(evidence).toEqual([]);

  const barrels = [...reached].filter((moduleUrl) =>
    PUBLIC_BARRELS.has(moduleUrl),
  );
  expect(barrels).toEqual([]);

  expect(
    [...reached].some((moduleUrl) =>
      moduleUrl.endsWith("application/runtime/create-open-cookie-kernel.ts"),
    ),
    "the auto graph must compose the shared lifecycle kernel",
  ).toBe(true);
  expect(
    [...reached].some((moduleUrl) =>
      moduleUrl.endsWith("application/runtime/create-open-cookie.ts"),
    ),
    "the auto graph must not import the receipt-bearing public facade",
  ).toBe(false);
});

it("shares the supported policy identity rule with the generic projector", () => {
  const reached = walkStaticImports(AUTO_ENTRY.href);
  expect(
    [...reached].some((moduleUrl) =>
      moduleUrl.endsWith(
        "domain/policy-catalogue/supported-policy-identity.ts",
      ),
    ),
    "the compact projector must use the canonical package-private identity rule",
  ).toBe(true);

  const compactProjector = readFileSync(
    new URL("application/runtime/project-consent-runtime-kernel.ts", SRC_ROOT),
    "utf8",
  );
  const genericIdentity = readFileSync(
    new URL("domain/policy-catalogue/policy-identity.ts", SRC_ROOT),
    "utf8",
  );
  const runtimeIdentity = readFileSync(
    new URL("domain/policy-catalogue/runtime.ts", SRC_ROOT),
    "utf8",
  );
  expect(compactProjector).toContain(
    'from "../../domain/policy-catalogue/runtime.js"',
  );
  expect(runtimeIdentity).toContain('from "./supported-policy-identity.js"');
  expect(genericIdentity).toContain('from "./supported-policy-identity.js"');
  expect(compactProjector).not.toContain("/^sha256-v1:");
  expect(genericIdentity).not.toContain("/^sha256-v1:");
});

it("routes captured cookie persistence through a package-private literal-scope seam", () => {
  const factory = readFileSync(
    new URL("auto/create-auto-open-cookie-factory.ts", SRC_ROOT),
    "utf8",
  );
  const infrastructureBarrel = readFileSync(
    new URL("infrastructure/index.ts", SRC_ROOT),
    "utf8",
  );

  expect(factory).toContain("createCapturedCookieDecisionStore");
  expect(factory).not.toMatch(/\bcreateCookieDecisionStore\b/u);
  expect(infrastructureBarrel).not.toContain(
    "createCapturedCookieDecisionStore",
  );
});
