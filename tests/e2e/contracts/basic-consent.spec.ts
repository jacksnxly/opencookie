import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { storedDecision } from "../support/decision-storage.js";

const ANALYTICS_HOST_PREFIX = "tracker.";

function panel(page: Page) {
  return page.locator("dialog.oc-panel");
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: "application/json",
  });
}

async function firstVisit(page: Page) {
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.locator(".oc-bar")).toBeVisible();
  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page)).toBeHidden();
}

test(
  "TEST-FIRST-VISIT-BANNER TEST-NO-PRECONSENT-LOAD TEST-IFRAME-FIRST-PARTY-CONTROL",
  { tag: "@binding" },
  async ({ page }, testInfo) => {
    const trackerRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname.startsWith(ANALYTICS_HOST_PREFIX)) {
        trackerRequests.push(request.url());
      }
    });

    await firstVisit(page);

    await expect(
      page.getByRole("button", { name: "Reject all" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Accept all" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => globalThis.__ocEssentialLoads ?? 0))
      .toBe(1);
    expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(
      0,
    );
    await expect(
      page.locator("template[data-oc-iframe][data-oc-resource]"),
    ).toHaveCount(1);
    await expect(page.locator("iframe[data-oc-resource]")).toHaveCount(0);
    expect(await page.evaluate(() => document.cookie)).not.toContain(
      "oc_optional_loaded",
    );
    expect(trackerRequests).toEqual([]);
    await attachJson(testInfo, "preconsent-network.json", trackerRequests);
  },
);

test(
  "TEST-ACCEPT-ALL TEST-RELOAD-PERSISTENCE",
  { tag: "@binding" },
  async ({ page }, testInfo) => {
    const fixtureId = String(testInfo.project.metadata["fixtureId"]);
    const trackerRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname.startsWith(ANALYTICS_HOST_PREFIX)) {
        trackerRequests.push(request.url());
      }
    });

    await firstVisit(page);
    await page.getByRole("button", { name: "Accept all" }).click();
    await expect(
      page.getByRole("button", { name: "Privacy choices" }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
      .toBe(1);
    await expect(
      page.locator('iframe[data-oc-active-resource="product-video"]'),
    ).toHaveAttribute(
      "src",
      new RegExp(`tracker[.]${fixtureId}[.]opencookie[.]test`, "u"),
    );
    expect(await page.evaluate(() => document.cookie)).toContain(
      "oc_optional_loaded=1",
    );
    const decision = await storedDecision(page);
    expect(decision).not.toBeNull();
    expect(JSON.stringify(decision)).toContain("accept-all");

    await page.addInitScript(() => {
      globalThis.__ocReturningDialogSeen = false;
      const observe = () => {
        const observer = new MutationObserver(() => {
          if (document.querySelector("dialog.oc-panel[open]") !== null) {
            globalThis.__ocReturningDialogSeen = true;
          }
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      };
      if (document.documentElement === null) {
        document.addEventListener("DOMContentLoaded", observe, { once: true });
      } else {
        observe();
      }
    });
    await page.reload({ waitUntil: "networkidle" });
    await expect(
      page.getByRole("button", { name: "Privacy choices" }),
    ).toBeVisible();
    await expect(panel(page)).toHaveCount(1);
    await expect(panel(page)).toBeHidden();
    expect(await page.evaluate(() => globalThis.__ocReturningDialogSeen)).toBe(
      false,
    );
    await expect
      .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
      .toBe(1);
    await attachJson(testInfo, "accept-all-network.json", trackerRequests);
  },
);

test("TEST-SUBDOMAIN-SCOPE TEST-SUBDOMAIN-PERSISTENCE", async ({ page }) => {
  await firstVisit(page);
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(
    page.getByRole("button", { name: "Privacy choices" }),
  ).toBeVisible();
  expect(JSON.stringify(await storedDecision(page))).toContain("reject-all");

  const sibling = new URL(page.url());
  sibling.hostname = sibling.hostname.replace(/^app[.]/u, "shop.");
  await page.goto(sibling.href, { waitUntil: "networkidle" });

  await expect(panel(page)).toHaveCount(1);
  await expect(panel(page)).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Privacy choices" }),
  ).toBeVisible();
  expect(JSON.stringify(await storedDecision(page))).toContain("reject-all");
});

test(
  "TEST-REJECT-ALL TEST-ESSENTIAL-APP-SURVIVES-REJECT",
  { tag: "@binding" },
  async ({ page }, testInfo) => {
    const trackerRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname.startsWith(ANALYTICS_HOST_PREFIX)) {
        trackerRequests.push(request.url());
      }
    });

    await firstVisit(page);
    await page.getByRole("button", { name: "Reject all" }).click();
    await expect(
      page.getByRole("button", { name: "Privacy choices" }),
    ).toBeVisible();
    await expect(page.locator("#content-sentinel")).toBeVisible();
    expect(await page.evaluate(() => globalThis.__ocEssentialLoads ?? 0)).toBe(
      1,
    );
    expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(
      0,
    );
    expect(trackerRequests).toEqual([]);
    const decision = await storedDecision(page);
    expect(JSON.stringify(decision)).toContain("reject-all");
    await attachJson(testInfo, "reject-all-network.json", trackerRequests);
  },
);

test("TEST-GROUPED-PRESENTATION TEST-GRANULAR-SAVE TEST-DECISION-PARITY", async ({
  page,
}) => {
  await firstVisit(page);
  const reject = page.getByRole("button", { name: "Reject all" });
  const accept = page.getByRole("button", { name: "Accept all" });
  const settings = page.getByRole("button", { name: "Settings" });
  const [rejectBox, acceptBox, settingsBox] = await Promise.all([
    reject.boundingBox(),
    accept.boundingBox(),
    settings.boundingBox(),
  ]);
  expect(rejectBox).not.toBeNull();
  expect(acceptBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  const browserSubpixelQuantum = 1 / 64;
  for (const difference of [
    Math.abs(
      (rejectBox?.height ?? Number.NaN) - (acceptBox?.height ?? Number.NaN),
    ),
    Math.abs(
      (rejectBox?.height ?? Number.NaN) - (settingsBox?.height ?? Number.NaN),
    ),
    Math.abs(
      (rejectBox?.width ?? Number.NaN) - (acceptBox?.width ?? Number.NaN),
    ),
  ]) {
    expect(difference).toBeLessThanOrEqual(browserSubpixelQuantum);
  }
  const settingsSharesRejectRow =
    Math.abs((settingsBox?.y ?? Number.NaN) - (rejectBox?.y ?? Number.NaN)) <=
    browserSubpixelQuantum;
  if (settingsSharesRejectRow) {
    expect(
      Math.abs(
        (rejectBox?.width ?? Number.NaN) - (settingsBox?.width ?? Number.NaN),
      ),
    ).toBeLessThanOrEqual(browserSubpixelQuantum);
  } else {
    expect(settingsBox?.width ?? Number.NaN).toBeGreaterThanOrEqual(
      (rejectBox?.width ?? Number.NaN) + (acceptBox?.width ?? Number.NaN),
    );
  }

  await settings.click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator("fieldset.oc-purposes legend")).toHaveText(
    "optional",
  );
  const analytics = page.getByRole("checkbox", { name: /Analytics/u });
  const category = page.getByRole("checkbox", {
    exact: true,
    name: "optional",
  });
  await expect(analytics).not.toBeChecked();
  await expect(category).toBeVisible();
  await expect(category).not.toBeChecked();
  await category.check();
  await expect(category).toBeChecked();
  await expect(analytics).toBeChecked();
  await page.getByRole("button", { name: "Save choices" }).click();
  await expect(panel(page)).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Privacy choices" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(1);
  const decision = await storedDecision(page);
  expect(decision).toMatchObject({
    record: {
      decisions: { analytics: "granted" },
      method: "granular",
    },
  });

  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(1);
  await expect(
    page.locator('iframe[data-oc-active-resource="product-video"]'),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Privacy choices" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(analytics).toBeChecked();
  await expect(category).toBeChecked();
  await category.uncheck();
  await expect(category).not.toBeChecked();
  await expect(analytics).not.toBeChecked();
  // Turning off a script this page ran reloads the tab (Pass B's M-C).
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Save choices" }).click();
  await reloaded;
  await expect(panel(page)).toBeHidden();
  await expect(
    page.locator('iframe[data-oc-active-resource="product-video"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('template[data-oc-iframe][data-oc-resource="product-video"]'),
  ).toHaveCount(1);
  expect(await storedDecision(page)).toMatchObject({
    record: {
      decisions: { analytics: "denied" },
      method: "granular",
    },
  });

  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(0);
  await expect(
    page.locator('iframe[data-oc-active-resource="product-video"]'),
  ).toHaveCount(0);
});
