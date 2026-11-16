import { Window } from "happy-dom";

// docs:consumer-path: src/german.ts
// docs:display:start
import { mountOpenCookie, VANILLA_COPY_DE } from "@opencookie-dev/vanilla";

import { createOpenCookieStore } from "../opencookie.config.js";

export function mountGermanPreferences(document: Document) {
  return mountOpenCookie({
    client: createOpenCookieStore(),
    copy: VANILLA_COPY_DE,
    document,
  });
}
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window();
  const document = window.document as unknown as Document;
  document.documentElement.lang = "de";
  const mounted = mountGermanPreferences(document);
  await mounted.ready;
  const actions = Array.from(document.querySelectorAll(".oc-btn--choice")).map(
    (element) => element.textContent,
  );
  if (actions.join("|") !== "Alle ablehnen|Alle akzeptieren|Einstellungen") {
    throw new Error(
      `The German equal-choice actions did not render: ${actions.join("|")}`,
    );
  }
  const banner = document.querySelector(".oc-root");
  if (banner?.closest("[lang]")?.getAttribute("lang") !== "de") {
    throw new Error(
      "The banner is not inside the page's German language scope.",
    );
  }
  mounted.destroy();
  window.close();
}
