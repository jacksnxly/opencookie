// Recaptures the three browser-evidence images each getting-started guide
// publishes, from the repository's production fixture builds. Build first with
// `pnpm build`, then run `node scripts/docs/capture-guide-evidence.mjs [ids]`.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { startE2EEnvironment } from "../e2e/fixture-supervisor.mjs";
import { E2E_FIXTURES } from "../e2e/project-matrix.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const GUIDE_SLUGS = Object.freeze({ "plain-cdn": "plain-html" });
const VIEWPORT = Object.freeze({ height: 900, width: 1440 });

function selectedFixtures(args) {
  const selected = args.length === 0 ? [...E2E_FIXTURES] : args;
  for (const fixtureId of selected) {
    if (!E2E_FIXTURES.includes(fixtureId)) {
      throw new Error(`Unknown fixture: ${fixtureId}`);
    }
  }
  return selected;
}

async function firstVisit(browser, proxy, fixtureId) {
  const context = await browser.newContext({ proxy, viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(`http://app.${fixtureId}.opencookie.test:4400/`, {
    waitUntil: "networkidle",
  });
  await page.locator(".oc-bar").waitFor({ state: "visible" });
  return { context, page };
}

async function capture(browser, proxy, fixtureId) {
  const directory = path.join(
    repositoryRoot,
    "apps/docs/public/images/getting-started",
    GUIDE_SLUGS[fixtureId] ?? fixtureId,
  );
  await mkdir(directory, { recursive: true });
  const shot = (page, stage) =>
    page.screenshot({ path: path.join(directory, `${stage}.png`) });

  const first = await firstVisit(browser, proxy, fixtureId);
  await shot(first.page, "banner-preconsent");
  await first.page.getByRole("button", { name: "Settings" }).click();
  await first.page.getByRole("dialog").waitFor({ state: "visible" });
  await shot(first.page, "preferences-open");
  await first.context.close();

  const second = await firstVisit(browser, proxy, fixtureId);
  const privacyChoices = second.page.getByRole("button", {
    name: "Privacy choices",
  });
  await second.page.getByRole("button", { name: "Accept all" }).click();
  await privacyChoices.click();
  // A stored withdrawal reloads the tab that ran the tracker (Pass B's M-C).
  const reloaded = second.page.waitForEvent("load");
  await second.page.getByRole("button", { name: "Withdraw consent" }).click();
  await reloaded;
  await second.page.waitForLoadState("networkidle");
  await privacyChoices.waitFor({ state: "visible" });
  await shot(second.page, "withdrawal-reload-blocked");
  await second.context.close();
  console.log(
    `Captured ${fixtureId} into ${path.relative(repositoryRoot, directory)}.`,
  );
}

const fixtureIds = selectedFixtures(process.argv.slice(2));
const environment = await startE2EEnvironment({ fixtureIds, repositoryRoot });
try {
  const browser = await chromium.launch();
  try {
    const proxy = {
      server: `http://127.0.0.1:${String(environment.proxyPort)}`,
    };
    for (const fixtureId of fixtureIds) {
      await capture(browser, proxy, fixtureId);
    }
  } finally {
    await browser.close();
  }
} finally {
  await environment.close();
}
