import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

import { createE2ERunPolicy } from "./scripts/e2e/run-policy.mjs";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
// run-e2e.mjs sets the tier from --tier; an unknown value throws.
const tier = process.env["OPENCOOKIE_E2E_TIER"] ?? "change";

export default defineConfig(createE2ERunPolicy(repositoryRoot, { tier }));
