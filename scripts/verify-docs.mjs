import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectDocsContractIssues,
  collectInternalLinkIssues,
  collectPageStructureIssues,
} from "./verify-docs-lib.mjs";
import { generateApiReference } from "./verify-docs-generate-api.mjs";
import { readFile } from "node:fs/promises";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const docsRoot = path.join(repoRoot, "apps/docs/src/content/docs");
const samplesRoot = path.join(repoRoot, "apps/docs/samples");
const distRoot = path.join(repoRoot, "apps/docs/dist");
const apiFile = path.join(docsRoot, "reference/api.mdx");

const requiredRoutes = [
  "index",
  "getting-started/index",
  "getting-started/plain-html",
  "getting-started/react-vite",
  "getting-started/vue-vite",
  "getting-started/sveltekit",
  "getting-started/next-app",
  "getting-started/next-pages",
  "getting-started/next-15-app",
  "getting-started/nuxt",
  "getting-started/astro",
  "recipes/pre-consent-blocking",
  "recipes/csp-nonce",
  "recipes/decision-lifecycle",
  "recipes/ssr-hydration-cls",
  "recipes/policy-versioning",
  "recipes/signals",
  "recipes/iframe-blocking",
  "recipes/subdomain-scope",
  "recipes/no-build-modules",
  "operating/run-a-site",
  "operating/operator-console",
  "recipes/testing",
  "recipes/a11y-i18n-theming",
  "playground/index",
  "reference/api",
  "reference/support",
];

const issues = await collectDocsContractIssues({
  docsRoot,
  requiredRoutes,
  samplesRoot,
});
const expectedApi = await generateApiReference();
const currentApi = await readFile(apiFile, "utf8").catch(() => "");
if (currentApi !== expectedApi) {
  issues.push("Generated API reference does not match package snapshots.");
}
issues.push(...(await collectInternalLinkIssues(distRoot)));
issues.push(...(await collectPageStructureIssues(distRoot)));

if (issues.length > 0) {
  for (const issue of issues) console.error(`DOCS ERROR: ${issue}`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${requiredRoutes.length} routes, every runnable sample, the generated API index, built page structure, and all internal links.`,
  );
}
