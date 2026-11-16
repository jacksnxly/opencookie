import { Window } from "happy-dom";

// docs:consumer-path: src/presentation.ts
// docs:display:start
import { mountOpenCookie } from "@opencookie-dev/vanilla";

import { createOpenCookieStore } from "../opencookie.config.js";

export function mountLocalizedPreferences(document: Document) {
  return mountOpenCookie({
    client: createOpenCookieStore(),
    copy: {
      acceptAll: "Allow all",
      rejectAll: "Reject all",
      title: "Privacy choices",
    },
    document,
  });
}
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window();
  const document = window.document as unknown as Document;
  const mounted = mountLocalizedPreferences(document);
  await mounted.ready;
  const actions = Array.from(document.querySelectorAll(".oc-btn--choice")).map(
    (element) => element.textContent,
  );
  if (actions.join("|") !== "Reject all|Allow all|Settings") {
    throw new Error("The localized equal-choice actions did not render.");
  }
  const settings = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(({ textContent }) => textContent === "Settings");
  settings?.click();
  const category = document.querySelector<HTMLInputElement>(
    'input[name="opencookie-category"][value="optional"]',
  );
  const analytics = document.querySelector<HTMLInputElement>(
    'input[name="opencookie-purpose"][value="analytics"]',
  );
  if (!category || !analytics) {
    throw new Error(
      "The optional category and Analytics purpose did not render.",
    );
  }
  category.click();
  if (!category.checked || category.indeterminate || !analytics.checked) {
    throw new Error("The optional category did not select its purposes.");
  }
  analytics.click();
  if (category.checked || !category.indeterminate) {
    throw new Error(
      "The optional category did not reflect a partial selection.",
    );
  }
  mounted.destroy();
  window.close();
}
