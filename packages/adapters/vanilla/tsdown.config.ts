import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    platform: "browser",
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
    fixedExtension: false,
    hash: false,
  },
  {
    entry: ["src/auto.ts"],
    format: "iife",
    platform: "browser",
    target: "es2022",
    dts: false,
    sourcemap: true,
    clean: false,
    fixedExtension: false,
    hash: false,
    minify: true,
    // V8 explicit compile hint: compile eagerly off the main thread while the
    // script streams, instead of lazily on the main thread at first call.
    // Measured to remove the first-visit long task.
    banner: { js: "//# allFunctionsCalledOnLoad" },
    deps: {
      alwaysBundle: [/^@opencookie-dev\/core(?:\/|$)/u],
    },
  },
]);
