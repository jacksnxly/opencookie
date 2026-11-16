import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.nuxt/**",
      "**/.output/**",
      "**/.astro/**",
      "**/.next/**",
      "**/.svelte-kit/**",
      "fixtures/sveltekit/build/**",
      "**/.stryker-tmp/**",
      "**/artifacts/**",
      "**/node_modules/**",
      "**/reports/**",
      // Local tool folders at the repository root are never product source.
      ".*/**",
      "**/temp/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.strict],
  },
  {
    files: ["packages/**/src/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
