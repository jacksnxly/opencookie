import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    platform: "node",
    target: "node22",
    dts: true,
    sourcemap: true,
    clean: true,
    fixedExtension: false,
    hash: false,
  },
  {
    entry: ["src/bin.ts"],
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: false,
    sourcemap: true,
    clean: false,
    fixedExtension: false,
    hash: false,
    banner: "#!/usr/bin/env node",
  },
]);
