import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  clearConsentState,
  storedDecision,
} from "../support/decision-storage.js";

function privacyButton(page: Page) {
  return page.getByRole("button", { name: "Privacy choices" });
}

function consentBar(page: Page) {
  return page.locator(".oc-bar");
}

async function openFirstVisit(page: Page, pathname = "/") {
  const response = await page.goto(pathname, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(consentBar(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
}

async function acceptAll(page: Page) {
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(privacyButton(page)).toBeVisible();
}

async function expectNoBlockingAxeViolations(
  page: Page,
  testInfo: TestInfo,
  state: string,
): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );
  await testInfo.attach(`axe-${state}.json`, {
    body: Buffer.from(`${JSON.stringify(results, null, 2)}\n`),
    contentType: "application/json",
  });
  expect(blocking).toEqual([]);
}

test("TEST-SPA-DYNAMIC-DISCOVERY", { tag: "@binding" }, async ({ page }) => {
  await openFirstVisit(page);
  await acceptAll(page);
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(1);

  await page.getByTestId("route-control").click();

  await expect(page).toHaveURL(/\/spa\/1$/u);
  await expect(page.locator("#fixture-status")).toHaveText("Dynamic route 1");
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(2);
  await expect
    .poll(() =>
      page.locator('[data-oc-active-resource="analytics-script"]').count(),
    )
    .toBeGreaterThanOrEqual(1);
});

// A withdrawal in the visitor's own tab reloads it, because a script that ran
// cannot be unloaded (Pass B's M-C). The tracker declares the cookie it sets,
// which is deleted, and a bridge hears the revocation before the reload.
test("TEST-WITHDRAWAL-PARITY TEST-WITHDRAWAL-REBLOCKS", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("opencookie:change", (event) => {
      const { detail } = event as CustomEvent<{ revoked: string[] }>;
      const log = JSON.parse(
        sessionStorage.getItem("oc-bridge") ?? "[]",
      ) as string[][];
      log.push(detail.revoked);
      sessionStorage.setItem("oc-bridge", JSON.stringify(log));
    });
  });
  await openFirstVisit(page);
  await page.evaluate(() => {
    for (const source of document.querySelectorAll(
      '[data-oc-resource="analytics-script"]',
    )) {
      source.setAttribute("data-oc-stores", "cookie:oc_optional_loaded");
    }
  });
  await acceptAll(page);
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(1);
  const cookieNames = async () =>
    (await page.context().cookies()).map((cookie) => cookie.name);
  expect(await cookieNames()).toContain("oc_optional_loaded");

  await privacyButton(page).click();
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Withdraw consent" }).click();
  await reloaded;

  await expect(privacyButton(page)).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("oc-bridge")),
  ).toContain('["analytics"]');
  expect(await cookieNames()).not.toContain("oc_optional_loaded");
  await expect(page.locator("[data-oc-active-resource]")).toHaveCount(0);
  await expect(page.locator("iframe[data-oc-resource]")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(0);

  await page.getByTestId("route-control").click();
  await expect(page.locator("[data-oc-active-resource]")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(0);
  expect(JSON.stringify(await storedDecision(page))).toContain(
    '"method":"withdrawal"',
  );
});

// A site's own "Cookie settings" link reopens the choices, on a first visit and
// after a decision, and closing returns focus to it.
test(
  "a site's own settings link opens the choices",
  { tag: "@binding" },
  async ({ page }) => {
    await openFirstVisit(page);
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "#privacy-settings";
      link.textContent = "Cookie settings";
      link.dataset["ocOpenPreferences"] = "";
      // The fixed banner covers the end of the page, so the link goes first.
      document.body.prepend(link);
    });
    const link = page.getByRole("link", { name: "Cookie settings" });

    await link.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await page.getByRole("button", { name: "Reject all" }).click();
    await expect(privacyButton(page)).toBeVisible();
    await link.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(link).toBeFocused();
  },
);

// A withdrawal in one tab must stop optional resources in the site's other
// open tabs. Those reload to re-read the decision; merely loading one does not.
test("TEST-WITHDRAWAL-REBLOCKS across tabs", async ({ page }) => {
  const marker = (tab: Page) =>
    tab.evaluate(() => document.documentElement.dataset["ocTab"] ?? "reloaded");
  await openFirstVisit(page);
  await acceptAll(page);
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(1);
  await page.evaluate(() => {
    document.documentElement.dataset["ocTab"] = "first";
  });

  const other = await page.context().newPage();
  await other.goto(page.url(), { waitUntil: "networkidle" });
  await expect(privacyButton(other)).toBeVisible();
  await expect
    .poll(() => other.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(1);
  await page.waitForTimeout(1_000);
  expect(await marker(page)).toBe("first");

  const reloaded = page.waitForEvent("load");
  await privacyButton(other).click();
  await other.getByRole("button", { name: "Withdraw consent" }).click();
  await expect(privacyButton(other)).toBeVisible();
  await reloaded;

  expect(await marker(page)).toBe("reloaded");
  await expect(privacyButton(page)).toBeVisible();
  await expect(page.locator("[data-oc-active-resource]")).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(0);
  await other.close();
});

test("TEST-POLICY-DIFF-REPROMPT", async ({ page }) => {
  await openFirstVisit(page);
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(privacyButton(page)).toBeVisible();

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(privacyButton(page)).toBeVisible();

  await page.goto("/policy-v2", { waitUntil: "networkidle" });
  await expect(consentBar(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Reject all" })).toBeVisible();
});

test("TEST-EXPIRY-REPROMPT TEST-REAL-TIME-EXPIRY", async ({
  page,
}, testInfo) => {
  await openFirstVisit(page, "/short-expiry");
  await expect(page.locator("html")).toHaveAttribute(
    "data-oc-expiry-ms",
    "1000",
  );
  await acceptAll(page);
  await expect
    .poll(() => page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0))
    .toBe(1);

  const trackerRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname.startsWith("tracker.")) {
      trackerRequests.push(request.url());
    }
  });
  await page.waitForTimeout(1_250);
  await page.reload({ waitUntil: "networkidle" });

  await expect(consentBar(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(await page.evaluate(() => globalThis.__ocAnalyticsLoads ?? 0)).toBe(0);
  await expect(page.locator("[data-oc-active-resource]")).toHaveCount(0);
  await expect(page.locator("iframe[data-oc-resource]")).toHaveCount(0);
  expect(trackerRequests).toEqual([]);
  await testInfo.attach("real-time-expiry.json", {
    body: Buffer.from(
      `${JSON.stringify({ elapsedMs: 1_250, trackerRequests }, null, 2)}\n`,
    ),
    contentType: "application/json",
  });
});

test("TEST-SAFARI-STATE-LOSS", async ({ page }) => {
  await openFirstVisit(page);
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(privacyButton(page)).toBeVisible();

  await clearConsentState(page);
  await page.reload({ waitUntil: "networkidle" });

  await expect(consentBar(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Reject all" })).toBeVisible();
});

test("TEST-CSP-NONCE-PROPERTY", { tag: "@binding" }, async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto("/strict-csp", { waitUntil: "networkidle" });
  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = /'nonce-([^']+)'/u.exec(policy)?.[1];
  if (nonce === undefined) throw new Error("CSP nonce is missing.");
  expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`);
  expect(policy).not.toContain("'unsafe-inline'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(
    await page
      .locator("style[data-opencookie]")
      .evaluate((element) => element.nonce),
  ).toBe(nonce);

  await acceptAll(page);
  expect(
    await page
      .locator('script[data-oc-active-resource="analytics-script"]')
      .evaluate((element) => element.nonce),
  ).toBe(nonce);
  expect(errors).toEqual([]);
});

test("TEST-DIALOG-KEYBOARD TEST-SCREEN-READER-LABELS TEST-BAR-KEYBOARD TEST-MODAL-KEYBOARD TEST-SAME-TASK-DIALOG", async ({
  page,
}) => {
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);

  const bar = page.locator(".oc-bar");
  const settings = page.getByRole("button", { name: "Settings" });
  const ordinaryControl = page.getByTestId("route-control");
  await expect(bar).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(settings).toBeVisible();
  await ordinaryControl.evaluate((element) => {
    element.setAttribute("tabindex", "0");
  });
  expect(
    await ordinaryControl.evaluate(
      (element) =>
        element.closest("[inert]") === null && !(element as HTMLElement).inert,
    ),
  ).toBe(true);

  expect(
    await page.evaluate(() => {
      const bar = document.querySelector(".oc-bar");
      const pageControls = [
        ...document.querySelectorAll<HTMLElement>(
          "a[href], button, input, select, textarea",
        ),
      ].filter((element) => element.closest("[data-oc-root]") === null);
      return (
        pageControls.length > 0 &&
        bar !== null &&
        pageControls.every(
          (element) =>
            (element.compareDocumentPosition(bar) &
              Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
        )
      );
    }),
  ).toBe(true);

  const barControls = await bar.evaluate((region) =>
    [...region.querySelectorAll("button, a[href]")].map(
      (control) => control.textContent?.trim() ?? "",
    ),
  );
  expect(barControls.length).toBeGreaterThan(1);
  await bar.locator("button, a[href]").last().focus();
  const walkedBack: string[] = [];
  for (let index = 1; index < barControls.length; index += 1) {
    await page.keyboard.press("Shift+Tab");
    walkedBack.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        const region = document.querySelector(".oc-bar");
        return region?.contains(active) === true
          ? (active?.textContent?.trim() ?? "")
          : "";
      }),
    );
  }
  expect(walkedBack).toEqual(barControls.slice(0, -1).reverse());

  const focusLeftTheBar = (): Promise<boolean> =>
    page.evaluate(
      () =>
        document.querySelector(".oc-bar")?.contains(document.activeElement) !==
        true,
    );
  // The bar is the page's last content, so Tab from its last control has no
  // page target: the browser moves focus to its own interface or leaves it in
  // place. A trap would wrap it back to another of the bar's controls.
  await bar.locator("button, a[href]").last().focus();
  await page.keyboard.press("Tab");
  expect(
    await bar.evaluate((region) => {
      const controls = [...region.querySelectorAll("button, a[href]")];
      const index = controls.indexOf(document.activeElement as Element);
      return index === -1 || index === controls.length - 1;
    }),
  ).toBe(true);
  await bar.locator("button, a[href]").first().focus();
  await page.keyboard.press("Shift+Tab");
  expect(await focusLeftTheBar()).toBe(true);

  const ordinaryBox = await ordinaryControl.boundingBox();
  expect(ordinaryBox).not.toBeNull();
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __ocOutsideClicks?: number;
    };
    runtime.__ocOutsideClicks = 0;
    document
      .querySelector<HTMLElement>('[data-testid="route-control"]')
      ?.addEventListener("click", () => {
        runtime.__ocOutsideClicks = (runtime.__ocOutsideClicks ?? 0) + 1;
      });
  });

  const openSameTask = await settings.evaluate((opener) => {
    const runtime = globalThis as typeof globalThis & {
      __ocExactOpener?: Element;
    };
    runtime.__ocExactOpener = opener;
    (opener as HTMLButtonElement).click();
    const dialog = document.querySelector<HTMLDialogElement>("dialog.oc-panel");
    const title = dialog?.querySelector<HTMLElement>(".oc-title");
    return {
      activeIsTitle: document.activeElement === title,
      dialogOpen: dialog?.open ?? false,
      modal: dialog?.matches(":modal") ?? false,
      openerConnected: opener.isConnected,
      titleTabIndex: title?.tabIndex,
    };
  });
  expect(openSameTask).toEqual({
    activeIsTitle: true,
    dialogOpen: true,
    modal: true,
    openerConnected: true,
    titleTabIndex: -1,
  });

  const dialog = page.getByRole("dialog", { name: "Your choices, clearly." });
  const title = dialog.locator(".oc-title");
  await expect(dialog).toHaveAttribute(
    "aria-describedby",
    /oc-\d+-description/u,
  );
  await expect(title).toBeFocused();
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            const panel =
              document.querySelector<HTMLDialogElement>("dialog.oc-panel");
            resolve({
              activeInside: panel?.contains(document.activeElement) === true,
              modal: panel?.matches(":modal") ?? false,
              open: panel?.open ?? false,
            });
          }),
        ),
    ),
  ).toEqual({ activeInside: true, modal: true, open: true });

  await ordinaryControl.focus();
  await expect(title).toBeFocused();
  if (ordinaryBox !== null) {
    await page.mouse.click(
      ordinaryBox.x + ordinaryBox.width / 2,
      ordinaryBox.y + ordinaryBox.height / 2,
    );
  }
  expect(await page.evaluate(() => globalThis.__ocOutsideClicks ?? 0)).toBe(0);

  await title.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Close preferences" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("checkbox").first()).toBeFocused();

  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      __ocEscapeSameTask?: object;
      __ocExactOpener?: Element;
    };
    const panel = document.querySelector<HTMLDialogElement>("dialog.oc-panel");
    panel?.addEventListener(
      "cancel",
      () => {
        runtime.__ocEscapeSameTask = {
          activeIsExactOpener:
            document.activeElement === runtime.__ocExactOpener,
          modal: panel.matches(":modal"),
          open: panel.open,
          openerConnected: runtime.__ocExactOpener?.isConnected === true,
        };
      },
      { once: true },
    );
  });
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => globalThis.__ocEscapeSameTask)).toEqual({
    activeIsExactOpener: true,
    modal: false,
    open: false,
    openerConnected: true,
  });
  await expect(settings).toBeFocused();
  await expect(bar).toBeVisible();

  await page.getByRole("button", { name: "Reject all" }).click();
  const launcher = privacyButton(page);
  await expect(launcher).toBeFocused();
  const launcherOpenSameTask = await launcher.evaluate((opener) => {
    const runtime = globalThis as typeof globalThis & {
      __ocExactLauncher?: Element;
    };
    runtime.__ocExactLauncher = opener;
    (opener as HTMLButtonElement).click();
    const panel = document.querySelector<HTMLDialogElement>("dialog.oc-panel");
    return {
      activeInside: panel?.contains(document.activeElement) === true,
      modal: panel?.matches(":modal") ?? false,
      open: panel?.open ?? false,
      openerConnected: opener.isConnected,
    };
  });
  expect(launcherOpenSameTask).toEqual({
    activeInside: true,
    modal: true,
    open: true,
    openerConnected: true,
  });
  await page.keyboard.press("Escape");
  await expect(launcher).toBeFocused();
  expect(
    await launcher.evaluate(
      (opener) =>
        opener.isConnected &&
        opener ===
          (
            globalThis as typeof globalThis & {
              __ocExactLauncher?: Element;
            }
          ).__ocExactLauncher,
    ),
  ).toBe(true);
  await expect(page.getByRole("dialog")).toBeHidden();
});

// A first visit moves focus to the bar when the page has not focused anything.
// Escape dismisses that visit without storing a choice. A stored rejection
// survives reload, and the bar does not take focus again.
test("TEST-BAR-FIRST-VISIT-FOCUS", async ({ page }) => {
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  const bar = page.locator(".oc-bar");
  await expect(bar).toBeVisible();

  const focusTarget = (): Promise<"bar" | "page" | "rest"> =>
    page.evaluate(() => {
      const region = document.querySelector(".oc-bar");
      const active = document.activeElement;
      if (region !== null && active === region) return "bar";
      if (
        active !== null &&
        active !== document.body &&
        active !== document.documentElement &&
        region?.contains(active) !== true
      ) {
        return "page";
      }
      return "rest";
    });
  let barTookFocus = false;
  try {
    await expect.poll(() => focusTarget(), { timeout: 5_000 }).toBe("bar");
    barTookFocus = true;
  } catch (error) {
    // A page that already focused something, including autofocus, keeps it.
    if ((await focusTarget()) !== "page") throw error;
  }
  if (barTookFocus) {
    await page.keyboard.press("Escape");
    await expect(bar).toBeHidden();
  }

  const fresh = await page.goto("/", { waitUntil: "networkidle" });
  expect(fresh?.status()).toBe(200);
  await expect(page.locator(".oc-bar")).toBeVisible();
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect(
    page.getByRole("button", { name: "Privacy choices" }),
  ).toBeVisible();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".oc-bar")).toBeHidden();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          const root = document.querySelector("[data-oc-root]");
          if (root !== null && active !== null && root.contains(active)) {
            return "banner";
          }
          if (
            active === null ||
            active === document.body ||
            active === document.documentElement
          ) {
            return "body";
          }
          return "page";
        }),
      { timeout: 5_000 },
    )
    .toMatch(/^(?:body|page)$/u);
});

// WCAG 1.4.4 and 1.4.10: at 200 and 400 per cent zoom of a 1280 by 800
// screen the bar keeps every word reachable without two-dimensional page
// scrolling, and at intermediate widths its text column never collapses.
async function expectBarReflows(page: Page): Promise<void> {
  const original = page.viewportSize();
  for (const [width, height] of [
    [640, 400],
    [320, 256],
  ] as const) {
    await page.setViewportSize({ height, width });
    const layout = await page.locator(".oc-bar").evaluate((bar) => {
      const box = bar.getBoundingClientRect();
      const overflowing = bar.scrollHeight > bar.clientHeight + 1;
      const scrolls = ["auto", "scroll"].includes(
        globalThis.getComputedStyle(bar).overflowY,
      );
      return {
        fitsViewport:
          box.top >= 0 && box.bottom <= globalThis.innerHeight + 0.5,
        reachable: !overflowing || scrolls,
        pageScrollsSideways:
          document.documentElement.scrollWidth > globalThis.innerWidth,
      };
    });
    expect(layout, `${String(width)} by ${String(height)}`).toEqual({
      fitsViewport: true,
      pageScrollsSideways: false,
      reachable: true,
    });
  }
  for (const width of [600, 700]) {
    await page.setViewportSize({ height: 700, width });
    const copyWidth = await page
      .locator(".oc-bar-copy")
      .evaluate((copy) => copy.getBoundingClientRect().width);
    expect(copyWidth, `text column at ${String(width)} px`).toBeGreaterThan(
      200,
    );
  }
  if (original !== null) await page.setViewportSize(original);
}

test("TEST-A11Y-VISUAL-MODES", async ({ page }, testInfo) => {
  await page.emulateMedia({
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  await openFirstVisit(page);
  await expectBarReflows(page);
  await expectNoBlockingAxeViolations(page, testInfo, "first-visit-light");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // Opening moves focus to the title for screen readers. Its ring follows
  // the engine's :focus-visible, so a mouse click draws none where the engine
  // treats the focus as pointer-driven; WebKit treats it as keyboard focus.
  const title = page.locator("dialog.oc-panel .oc-title");
  await expect(title).toBeFocused();
  const ring = await title.evaluate((element) => ({
    keyboard: element.matches(":focus-visible"),
    outline: globalThis.getComputedStyle(element).outlineStyle,
  }));
  expect(ring.outline === "none").toBe(!ring.keyboard);
  await expectNoBlockingAxeViolations(page, testInfo, "details-light");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Reject all", exact: true }).click();
  await expect(privacyButton(page)).toBeVisible();
  await privacyButton(page).click();
  await expectNoBlockingAxeViolations(page, testInfo, "reopened-light");

  const panel = page.locator("dialog.oc-panel");
  expect(
    await panel
      .locator("strong")
      .evaluate((element) => globalThis.getComputedStyle(element).color),
  ).toBe("rgb(15, 23, 42)");
  const background = () =>
    panel.evaluate(
      (element) => globalThis.getComputedStyle(element).backgroundColor,
    );
  // The dark palette follows the page, not the visitor's OS: a page that
  // declares only light stays light when the OS turns dark.
  await page.evaluate(() => {
    document.documentElement.style.colorScheme = "light";
  });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  expect(await background()).toBe("rgb(255, 255, 255)");
  await page.evaluate(() => {
    document.documentElement.style.colorScheme = "light dark";
  });
  await expect.poll(background).toBe("rgb(11, 18, 32)");
  expect(
    await panel.evaluate((element) => {
      const strong = element.querySelector("strong");
      if (strong === null) throw new Error("expected a purpose title");
      return globalThis.getComputedStyle(strong).color;
    }),
  ).toBe("rgb(232, 238, 252)");
  await expectNoBlockingAxeViolations(
    page,
    testInfo,
    "reopened-dark-reduced-motion",
  );
});
