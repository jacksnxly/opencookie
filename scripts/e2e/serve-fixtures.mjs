import { fileURLToPath } from "node:url";

import {
  parseFixtureSelection,
  startE2EEnvironment,
} from "./fixture-supervisor.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  const environment = await startE2EEnvironment({
    fixtureIds: parseFixtureSelection(process.env["OC_E2E_FIXTURES"]),
    repositoryRoot,
  });
  console.log(
    `OpenCookie E2E environment ready on proxy port ${String(environment.proxyPort)}`,
  );

  await new Promise((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      environment.close().then(resolve, reject);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
