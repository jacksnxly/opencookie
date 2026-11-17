import { describe, expect, it } from "vitest";

import config from "./tsdown.config.js";

interface ResolverPlugin {
  readonly name: string;
  readonly resolveId: (source: string, importer: string | undefined) => unknown;
}

interface BuildConfig {
  readonly entry?: Readonly<Record<string, string>>;
  readonly minify?: boolean;
  readonly outputOptions?: {
    readonly comments?: { readonly annotation?: boolean };
  };
  readonly plugins?: readonly ResolverPlugin[];
}

const buildConfigs = config as unknown as readonly BuildConfig[];
const applicationConfig = buildConfigs.find(
  ({ entry }) => entry?.application === "src/application.ts",
);
const reconciliationLink = applicationConfig?.plugins?.find(
  ({ name }) => name === "externalize-application-reconciliation",
);

describe("application reconciliation build link", () => {
  it("externalizes the public product for POSIX and Windows importer paths", () => {
    expect(reconciliationLink).toBeDefined();

    for (const importer of [
      "/repo/src/application/runtime/projector.ts",
      String.raw`C:\repo\src\application\runtime\projector.ts`,
    ]) {
      expect(
        reconciliationLink?.resolveId("../../reconciliation.js", importer),
      ).toEqual({
        external: true,
        id: "@opencookie-dev/core/reconciliation",
      });
    }
  });
});

describe("minified core builds", () => {
  // rolldown 1.3 keeps /* @__PURE__ */ comments in minified output unless
  // told otherwise; they cost bytes in every bundle a site ships.
  it("drop annotation comments", () => {
    const minified = buildConfigs.filter(({ minify }) => minify === true);
    expect(minified.length).toBeGreaterThan(0);
    for (const build of minified) {
      expect(build.outputOptions?.comments?.annotation).toBe(false);
    }
  });
});
