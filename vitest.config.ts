import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["packages/core/src/domain/**/*.ts"],
      exclude: [
        "packages/core/src/domain/**/*.test.ts",
        "packages/core/src/domain/**/*.d.ts",
      ],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 95,
        branches: 95,
      },
    },
  },
});
