import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { storedDecision } from "../support/decision-storage.js";

function panel(page: Page) {
  return page.locator("dialog.oc-panel");
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: "application/json",
  });
}

/**
 * Cuts every origin except the site's own, and records what was refused.
 *
 * Scope, stated exactly. This proves the consent runtime needs no origin but
 * the site's own: no vendor control plane, no configuration fetch, no
 * phone-home. It is not a CDN-outage test. The fixture server rewrites the
 * public CDN URL to a same-origin path so the suite stays hermetic, see
 * `fixtures/plain-cdn/server.mjs`, so no fixture here loads the runtime over a
 * real third-party transport. Choosing a self-hosted transport is a separate
 * operator decision, covered by `opencookie init --self-host`.
 */
async function serveOnlyFirstParty(
  page: Page,
  siteHost: string,
  refused: string[],
): Promise<void> {
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).hostname === siteHost) {
      await route.continue();
      return;
    }
    refused.push(route.request().url());
    await route.abort("failed");
  });
}

function siteHostFor(testInfo: TestInfo): string {
  return `app.${String(testInfo.project.metadata["fixtureId"])}.opencookie.test`;
}

test("TEST-OFFLINE-RUNTIME refusing every remote origin leaves consent working", async ({
  page,
}, testInfo) => {
  const refused: string[] = [];
  await serveOnlyFirstParty(page, siteHostFor(testInfo), refused);

  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  // The banner exists without any remote delivery.
  await expect(page.locator(".oc-bar")).toBeVisible();
  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Reject all" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept all" })).toBeVisible();

  // Blocking still holds, and the runtime never reached for a remote origin.
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocEssentialLoads ?? 0))
    .toBe(1);
  expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(0);
  expect(refused).toEqual([]);

  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(
    page.getByRole("button", { name: "Privacy choices" }),
  ).toBeVisible();
  expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(0);
  expect(JSON.stringify(await storedDecision(page))).toContain("reject-all");

  // The decision survives a reload that is still offline.
  await page.reload({ waitUntil: "networkidle" });
  await expect(panel(page)).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Privacy choices" }),
  ).toBeVisible();
  expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(0);
  expect(JSON.stringify(await storedDecision(page))).toContain("reject-all");
  expect(refused).toEqual([]);

  await attachJson(testInfo, "offline-refused-origins.json", refused);
});

test("TEST-OFFLINE-RUNTIME accepting offline still opens the gate", async ({
  page,
}, testInfo) => {
  const refused: string[] = [];
  await serveOnlyFirstParty(page, siteHostFor(testInfo), refused);

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".oc-bar")).toBeVisible();
  expect(refused).toEqual([]);

  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(
    page.getByRole("button", { name: "Privacy choices" }),
  ).toBeVisible();

  // The decision is recorded locally even though nothing offsite is reachable.
  expect(JSON.stringify(await storedDecision(page))).toContain("accept-all");

  // The gate really opened: the third party was attempted and refused by the
  // network, not withheld by the runtime. This also proves the cut is live,
  // so the empty-refusal assertions above are a real finding and not a
  // routing rule that never fired.
  await expect.poll(() => refused.length).toBeGreaterThan(0);

  await attachJson(testInfo, "offline-refused-origins.json", refused);
});
