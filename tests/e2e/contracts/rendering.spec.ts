import { expect, test, type Page } from "@playwright/test";

interface Geometry {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface RenderingMetrics {
  readonly cls: number;
  readonly surfacePaint: null | {
    readonly background: string;
    readonly display: string;
    readonly opacity: string;
    readonly position: string;
    readonly stylesheetPresent: boolean;
    readonly visibility: string;
  };
  readonly firstGeometry: Geometry | null;
  readonly shifts: readonly {
    readonly sources: readonly string[];
    readonly value: number;
  }[];
  readonly ssrGeometry: Geometry | null;
}

async function openFirstVisit(page: Page): Promise<void> {
  const response = await page.goto("/", { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(page.locator(".oc-bar")).toBeVisible();
  await expect(page.locator("dialog.oc-panel")).toHaveCount(1);
  await expect(page.locator("dialog.oc-panel")).toBeHidden();
}

test(
  "TEST-SSR-HYDRATION-MATCH TEST-CLS-AND-FOUC",
  { tag: "@binding" },
  async ({ page }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        runtimeErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    await page.addInitScript(() => {
      const runtime = globalThis as typeof globalThis & {
        __ocFirstGeometry?: Geometry;
        __ocLayoutShift?: number;
        __ocPaint?: RenderingMetrics["surfacePaint"];
        __ocShifts?: RenderingMetrics["shifts"];
        __ocSsrGeometry?: Geometry;
      };
      runtime.__ocLayoutShift = 0;
      runtime.__ocShifts = [];
      let documentReady = false;
      let geometryQueued = false;
      let paintQueued = false;
      const captureGeometry = (): void => {
        geometryQueued = false;
        const sentinel = document.querySelector("#content-sentinel");
        if (sentinel === null || runtime.__ocFirstGeometry !== undefined)
          return;
        const rect = sentinel.getBoundingClientRect();
        runtime.__ocFirstGeometry = {
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      };
      const queueGeometry = (): void => {
        if (!documentReady || geometryQueued) return;
        geometryQueued = true;
        requestAnimationFrame(captureGeometry);
      };
      const capturePaint = (): void => {
        paintQueued = false;
        const surface = document.querySelector<HTMLElement>(".oc-bar");
        if (surface === null || runtime.__ocPaint !== undefined) {
          return;
        }
        const surfaceStyle = getComputedStyle(surface);
        runtime.__ocPaint = {
          background: surfaceStyle.backgroundColor,
          display: surfaceStyle.display,
          opacity: surfaceStyle.opacity,
          position: surfaceStyle.position,
          stylesheetPresent:
            document.querySelector("style[data-opencookie]") !== null,
          visibility: surfaceStyle.visibility,
        };
      };
      const queuePaint = (): void => {
        if (paintQueued || runtime.__ocPaint !== undefined) return;
        paintQueued = true;
        requestAnimationFrame(capturePaint);
      };
      const capture = (): void => {
        queuePaint();
        queueGeometry();
      };
      const observe = (): void => {
        capture();
        new MutationObserver(capture).observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      };
      if (document.documentElement === null) {
        document.addEventListener("DOMContentLoaded", observe, { once: true });
      } else {
        observe();
      }
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          documentReady = true;
          queueGeometry();
        },
        { once: true },
      );
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & {
              readonly hadRecentInput?: boolean;
              readonly value?: number;
            };
            if (shift.hadRecentInput !== true) {
              runtime.__ocLayoutShift =
                (runtime.__ocLayoutShift ?? 0) + (shift.value ?? 0);
              const sources = (
                shift as typeof shift & {
                  readonly sources?: readonly { readonly node?: Node }[];
                }
              ).sources;
              runtime.__ocShifts = [
                ...(runtime.__ocShifts ?? []),
                {
                  sources:
                    sources?.map(({ node }) => {
                      if (!(node instanceof Element))
                        return node?.nodeName ?? "unknown";
                      const identifier =
                        node.id.length === 0 ? "" : `#${node.id}`;
                      return `${node.tagName.toLowerCase()}${identifier}`;
                    }) ?? [],
                  value: shift.value ?? 0,
                },
              ];
            }
          }
        }).observe({ buffered: true, type: "layout-shift" });
      } catch {
        // Non-Chromium engines use the geometry assertion below.
      }
    });

    await openFirstVisit(page);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const runtime = globalThis as typeof globalThis & {
            __ocFirstGeometry?: Geometry;
          };
          return runtime.__ocFirstGeometry !== undefined;
        }),
      )
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const currentGeometry = await page
      .locator("#content-sentinel")
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      });
    const metrics = await page.evaluate<RenderingMetrics>(() => {
      const runtime = globalThis as typeof globalThis & {
        __ocFirstGeometry?: Geometry;
        __ocLayoutShift?: number;
        __ocPaint?: RenderingMetrics["surfacePaint"];
        __ocShifts?: RenderingMetrics["shifts"];
        __ocSsrGeometry?: Geometry;
      };
      if (runtime.__ocPaint === undefined) {
        throw new Error(
          'The visible consent bar must produce an ".oc-bar" paint capture.',
        );
      }
      return {
        cls: runtime.__ocLayoutShift ?? 0,
        surfacePaint: runtime.__ocPaint,
        firstGeometry: runtime.__ocFirstGeometry ?? null,
        shifts: runtime.__ocShifts ?? [],
        ssrGeometry: runtime.__ocSsrGeometry ?? null,
      };
    });

    await testInfo.attach("rendering-metrics.json", {
      body: Buffer.from(
        `${JSON.stringify({ currentGeometry, metrics, runtimeErrors }, null, 2)}\n`,
      ),
      contentType: "application/json",
    });

    expect(metrics.firstGeometry).not.toBeNull();
    for (const initial of [metrics.firstGeometry, metrics.ssrGeometry]) {
      if (initial === null) continue;
      expect(Math.abs(initial.x - currentGeometry.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(initial.y - currentGeometry.y)).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(initial.width - currentGeometry.width),
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(initial.height - currentGeometry.height),
      ).toBeLessThanOrEqual(0.5);
    }
    if (testInfo.project.name.includes("-chromium-")) {
      expect(metrics.cls).toBeLessThanOrEqual(0.01);
    }
    expect(metrics.surfacePaint).toMatchObject({
      display: "grid",
      opacity: "1",
      position: "fixed",
      stylesheetPresent: true,
      visibility: "visible",
    });
    expect(metrics.surfacePaint?.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      runtimeErrors.filter((message) =>
        /hydration|did not match|server rendered|content does not match/iu.test(
          message,
        ),
      ),
    ).toEqual([]);
  },
);

test("TEST-VISUAL-BASELINE", async ({ page }) => {
  await openFirstVisit(page);
  await page.evaluate(() => document.fonts.ready);
  const bar = page.locator(".oc-bar");
  await expect(bar).toHaveScreenshot("consent-bar.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.03,
    scale: "css",
    threshold: 0.25,
  });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const panel = page.locator("dialog.oc-panel");
  await expect(panel).toBeVisible();

  await expect(panel).toHaveScreenshot("consent-preferences.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.03,
    scale: "css",
    threshold: 0.25,
  });
});

test("documents rejected blank and layout-control identifiers in a real browser", async ({
  page,
}, testInfo) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const rendering = await page.evaluate(
    ({ blankGlyphs, separators }) => {
      const pixelsFor = (text: string): Uint8ClampedArray => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("Canvas 2D must be available.");
        context.font = "32px sans-serif";
        context.fillText(text, 0, 40);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [linePixels, paragraphPixels] = separators.map(pixelsFor);
      return {
        separatorPixelsEqual: linePixels?.every(
          (channel, index) => paragraphPixels?.[index] === channel,
        ),
        zeroPaint: blankGlyphs.map(
          (glyph) => !pixelsFor(glyph).some((channel) => channel !== 0),
        ),
      };
    },
    {
      blankGlyphs: ["\u2800", "\uFFF9", "\uFFFA", "\uFFFB", "\uFFFC"],
      separators: ["a\u2028b", "a\u2029b"],
    },
  );

  await testInfo.attach("identifier-glyph-evidence.json", {
    body: Buffer.from(`${JSON.stringify(rendering, null, 2)}\n`),
    contentType: "application/json",
  });
  // The Linux container's fonts draw a placeholder box for these code points, so the paint fact is a macOS one.
  expect(rendering.zeroPaint).toHaveLength(5);
  expect(
    rendering.zeroPaint.every((painted) => typeof painted === "boolean"),
  ).toBe(true);
  if (process.platform === "darwin") {
    expect(rendering.zeroPaint.slice(0, 4)).toEqual([true, true, true, true]);
  }
});

test(
  "TEST-CATALOGUE-NETWORK-COVERAGE TEST-THEMING-CONTRACT",
  { tag: "@binding" },
  async ({ page }, testInfo) => {
    const trackerRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname.startsWith("tracker.")) trackerRequests.push(url.href);
    });
    await openFirstVisit(page);
    await page.evaluate(() => {
      const style = document.createElement("style");
      const libraryStyle = document.querySelector<HTMLStyleElement>(
        "style[data-opencookie]",
      );
      if (libraryStyle?.nonce) style.nonce = libraryStyle.nonce;
      style.dataset["ocConsumerTheme"] = "true";
      style.textContent = ".oc-root{--oc-accent:#0b5fff}";
      document.head.prepend(style);
    });
    const stylesheetOrder = await page.locator("style").evaluateAll((styles) =>
      styles.map((style) => ({
        consumer: (style as HTMLElement).dataset["ocConsumerTheme"] === "true",
        library: (style as HTMLElement).dataset["opencookie"] !== undefined,
      })),
    );
    expect(stylesheetOrder.findIndex(({ consumer }) => consumer)).toBeLessThan(
      stylesheetOrder.findIndex(({ library }) => library),
    );
    const accept = page.getByRole("button", { name: "Accept all" });
    const reject = page.getByRole("button", { name: "Reject all" });
    const settings = page.getByRole("button", { name: "Settings" });
    await expect(accept).toHaveCSS("background-color", "rgb(11, 95, 255)");
    await expect(reject).toHaveCSS("background-color", "rgb(11, 95, 255)");
    await expect(settings).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(settings).toHaveCSS("color", "rgb(11, 95, 255)");
    await expect(settings).toHaveCSS("border-top-color", "rgb(11, 95, 255)");
    const computedTheme = await page.locator(".oc-root").evaluate((root) => {
      const acceptAction = root.querySelector<HTMLElement>(
        '[data-oc-action="accept-all"]',
      );
      const rejectAction = root.querySelector<HTMLElement>(
        '[data-oc-action="reject-all"]',
      );
      const settingsAction = root.querySelector<HTMLElement>(
        '[data-oc-action="settings"]',
      );
      if (
        acceptAction === null ||
        rejectAction === null ||
        settingsAction === null
      ) {
        throw new Error(
          "The consent bar must expose all three primary actions.",
        );
      }
      const settingsStyle = getComputedStyle(settingsAction);
      return {
        accent: getComputedStyle(root).getPropertyValue("--oc-accent").trim(),
        acceptBackground: getComputedStyle(acceptAction).backgroundColor,
        rejectBackground: getComputedStyle(rejectAction).backgroundColor,
        settingsBackground: settingsStyle.backgroundColor,
        settingsBorderTopColor: settingsStyle.borderTopColor,
        settingsColor: settingsStyle.color,
      };
    });
    expect(computedTheme).toEqual({
      accent: "#0b5fff",
      acceptBackground: "rgb(11, 95, 255)",
      rejectBackground: "rgb(11, 95, 255)",
      settingsBackground: "rgba(0, 0, 0, 0)",
      settingsBorderTopColor: "rgb(11, 95, 255)",
      settingsColor: "rgb(11, 95, 255)",
    });
    await settings.click();
    const themedPanel = page.locator("dialog.oc-panel");
    await expect(themedPanel).toBeVisible();
    const computedPanelTheme = await themedPanel.evaluate((panel) => {
      const marker = panel.querySelector<HTMLElement>(".oc-meta");
      if (marker === null) {
        throw new Error("The settings panel must expose its accent marker.");
      }
      return {
        panelAccent: getComputedStyle(panel)
          .getPropertyValue("--oc-accent")
          .trim(),
        panelMarkerBackground: getComputedStyle(marker, "::before")
          .backgroundColor,
      };
    });
    expect(computedPanelTheme).toEqual({
      panelAccent: "#0b5fff",
      // The quiet card does not paint an accent bar on the eyebrow.
      panelMarkerBackground: "rgba(0, 0, 0, 0)",
    });
    await testInfo.attach("theming-contract.json", {
      body: Buffer.from(
        `${JSON.stringify({ ...computedTheme, ...computedPanelTheme }, null, 2)}\n`,
      ),
      contentType: "application/json",
    });
    const themedPanelScreenshot = await themedPanel.screenshot({
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(themedPanel).toBeHidden();
    await testInfo.attach("theming-contract.png", {
      body: themedPanelScreenshot,
      contentType: "image/png",
    });
    const catalogue = await page
      .locator(
        "script[data-oc-resource],iframe[data-oc-resource],template[data-oc-iframe][data-oc-resource]",
      )
      .evaluateAll((elements) =>
        elements.map((element) => ({
          resourceId: (element as HTMLElement).dataset.ocResource,
          tagName: element.tagName.toLowerCase(),
        })),
      );
    expect(
      [...new Set(catalogue.map((entry) => entry.resourceId))].sort(),
    ).toEqual(["analytics-script", "product-video"]);
    expect(trackerRequests).toEqual([]);

    await page.getByRole("button", { name: "Accept all" }).click();
    await expect
      .poll(() =>
        [
          ...new Set(
            trackerRequests.map((request) => new URL(request).pathname),
          ),
        ]
          .sort()
          .join(","),
      )
      .toBe("/analytics.js,/frame");
    await expect(
      page.locator('script[data-oc-active-resource="analytics-script"]'),
    ).toHaveCount(1);
    await expect(page.locator('iframe[src*="/frame"]')).toHaveCount(1);
    await testInfo.attach("catalogue-network.json", {
      body: Buffer.from(
        `${JSON.stringify({ catalogue, trackerRequests }, null, 2)}\n`,
      ),
      contentType: "application/json",
    });
  },
);
