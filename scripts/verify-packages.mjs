import path from "node:path";
import { fileURLToPath } from "node:url";

import { runPackageVerification } from "./verify-packages-workflow.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

try {
  await runPackageVerification({ repositoryRoot });
} catch (error) {
  console.error(`[verify-packages] ${error.message}`);
  process.exitCode = 1;
}
