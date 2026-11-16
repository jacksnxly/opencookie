import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { createStorageE2ERunPolicy } from "./scripts/e2e/storage-run-policy.mjs";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(createStorageE2ERunPolicy(repositoryRoot));
