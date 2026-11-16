import { defineConfig } from "tsdown";

const shared = {
  dts: true,
  fixedExtension: false,
  format: ["esm", "cjs"] as const,
  hash: false,
  minify: true,
  platform: "neutral" as const,
  sourcemap: true,
  target: "es2022",
};

const applicationReconciliationLink = {
  name: "externalize-application-reconciliation",
  resolveId(source: string, importer: string | undefined) {
    const normalizedImporter = importer?.replaceAll("\\", "/");
    if (
      (source === "../../reconciliation.js" ||
        source === "../../reconciliation/contract.js") &&
      normalizedImporter?.includes("/src/application/runtime/") === true
    ) {
      return {
        external: true,
        id: "@opencookie-dev/core/reconciliation",
      };
    }
    return undefined;
  },
};

export default defineConfig([
  {
    ...shared,
    clean: true,
    entry: { index: "src/index.ts" },
  },
  {
    ...shared,
    clean: false,
    entry: { domain: "src/domain.ts" },
  },
  {
    ...shared,
    clean: false,
    deps: {
      onlyImport: ["@opencookie-dev/core"],
    },
    entry: { application: "src/application.ts" },
    plugins: [applicationReconciliationLink],
  },
  {
    ...shared,
    clean: false,
    entry: { reconciliation: "src/reconciliation.ts" },
  },
  {
    ...shared,
    clean: false,
    entry: { infrastructure: "src/infrastructure.ts" },
  },
  {
    ...shared,
    clean: false,
    entry: { auto: "src/auto.ts" },
  },
]);
