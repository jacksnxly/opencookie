import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime.ts"],
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  hash: false,
  deps: {
    neverBundle: ["@nuxt/kit", "@opencookie-dev/vue", "vue"],
  },
});
