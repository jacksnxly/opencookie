import type { Page } from "@playwright/test";

/** Reads the fixture's real localStorage or script-readable cookie envelope. */
export async function storedDecision(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const local = localStorage.getItem("opencookie.consent");
    if (local !== null) return JSON.parse(local) as unknown;

    for (const segment of document.cookie.split(";")) {
      const candidate = segment.trim();
      const separator = candidate.indexOf("=");
      if (separator < 0) continue;
      const name = decodeURIComponent(candidate.slice(0, separator));
      if (name !== "opencookie.consent" && name !== "opencookie-consent") {
        continue;
      }
      return JSON.parse(
        decodeURIComponent(candidate.slice(separator + 1)),
      ) as unknown;
    }
    return null;
  });
}

/** Simulates complete client-side consent-storage loss for the active context. */
export async function clearConsentState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem("opencookie.consent");
  });
  await page.context().clearCookies();
}
