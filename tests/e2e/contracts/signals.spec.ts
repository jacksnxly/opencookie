import { expect, test, type Page } from "@playwright/test";

type ConsentModeCall = readonly [
  "consent",
  "default" | "update",
  Readonly<Record<string, "denied" | "granted">>,
];

function consentModeCalls(page: Page): Promise<ConsentModeCall[]> {
  return page.evaluate(() => {
    const value = (
      globalThis as typeof globalThis & {
        readonly __ocConsentModeCalls?: ConsentModeCall[];
      }
    ).__ocConsentModeCalls;
    return structuredClone(value ?? []);
  });
}

async function openFirstVisit(page: Page): Promise<void> {
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.locator(".oc-bar")).toBeVisible();
  await expect(page.locator("dialog.oc-panel")).toHaveCount(1);
  await expect(page.locator("dialog.oc-panel")).toBeHidden();
}

test("TEST-CONSENT-MODE-ORDER", { tag: "@binding" }, async ({ page }) => {
  await openFirstVisit(page);
  expect(await consentModeCalls(page)).toEqual([
    [
      "consent",
      "default",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "denied",
      },
    ],
  ]);

  await page.getByRole("button", { name: "Accept all" }).click();
  await expect.poll(async () => (await consentModeCalls(page)).length).toBe(2);
  expect((await consentModeCalls(page))[1]).toEqual([
    "consent",
    "update",
    {
      ad_personalization: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      analytics_storage: "granted",
    },
  ]);

  // Withdrawal reloads the tab (Pass B's M-C), which clears the page's call
  // log, so the calls made from here on are copied to sessionStorage.
  await page.evaluate(() => {
    const calls = (
      globalThis as typeof globalThis & {
        readonly __ocConsentModeCalls: unknown[];
      }
    ).__ocConsentModeCalls;
    const push = calls.push.bind(calls);
    calls.push = (...items: unknown[]) => {
      const log = JSON.parse(
        sessionStorage.getItem("oc-consent-mode") ?? "[]",
      ) as unknown[];
      log.push(...items);
      sessionStorage.setItem("oc-consent-mode", JSON.stringify(log));
      return push(...items);
    };
  });
  await page.getByRole("button", { name: "Privacy choices" }).click();
  await expect(page.locator("dialog.oc-panel")).toBeVisible();
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Withdraw consent" }).click();
  await reloaded;
  const afterWithdrawal = JSON.parse(
    (await page.evaluate(() => sessionStorage.getItem("oc-consent-mode"))) ??
      "[]",
  ) as ConsentModeCall[];
  expect(afterWithdrawal[0]).toEqual([
    "consent",
    "update",
    {
      ad_personalization: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      analytics_storage: "denied",
    },
  ]);
});

test(
  "TEST-GPC-SERVER-CLIENT",
  { tag: "@binding" },
  async ({ page }, testInfo) => {
    const trackerRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname.startsWith("tracker.")) {
        trackerRequests.push(request.url());
      }
    });
    await page.context().setExtraHTTPHeaders({ "Sec-GPC": "1" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "globalPrivacyControl", {
        configurable: true,
        value: true,
      });
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          document.documentElement.dataset["ocBrowserGpcEvidence"] =
            "synthetic-test-only";
        },
        { once: true },
      );
    });

    await openFirstVisit(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-oc-server-gpc",
      "enabled",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-oc-browser-gpc-evidence",
      "synthetic-test-only",
    );
    await page.getByRole("button", { name: "Accept all" }).click();

    await expect
      .poll(async () => (await consentModeCalls(page)).length)
      .toBe(2);
    expect((await consentModeCalls(page))[1]?.[2].analytics_storage).toBe(
      "denied",
    );
    expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(
      0,
    );
    expect(trackerRequests).toEqual([]);
    await testInfo.attach("gpc-evidence.json", {
      body: Buffer.from(
        `${JSON.stringify(
          {
            browserObservation: "synthetic-test-only",
            consentModeCalls: await consentModeCalls(page),
            requestHeader: "Sec-GPC: 1",
            serverObservation: "enabled",
            trackerRequests,
          },
          null,
          2,
        )}\n`,
      ),
      contentType: "application/json",
    });
  },
);
