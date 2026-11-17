import { describe, expect, it } from "vitest";

import config from "./tsdown.config.js";

interface BuildConfig {
  readonly format?: string | readonly string[];
  readonly minify?: boolean;
  readonly outputOptions?: {
    readonly comments?: { readonly annotation?: boolean };
  };
}

const buildConfigs = config as unknown as readonly BuildConfig[];

describe("minified vanilla builds", () => {
  // rolldown 1.3 keeps /* @__PURE__ */ comments in minified output unless
  // told otherwise; the drop-in IIFE would carry them to every visitor.
  it("drop annotation comments", () => {
    const minified = buildConfigs.filter(({ minify }) => minify === true);
    expect(minified.map(({ format }) => format)).toContain("iife");
    for (const build of minified) {
      expect(build.outputOptions?.comments?.annotation).toBe(false);
    }
  });
});
