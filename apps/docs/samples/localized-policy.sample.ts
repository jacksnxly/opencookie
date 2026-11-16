import { Window } from "happy-dom";

// docs:consumer-path: src/localized-policy.ts
// docs:display:start
import type { PolicyDefinition } from "@opencookie-dev/core";
import { bootstrapOpenCookie, VANILLA_COPY_DE } from "@opencookie-dev/vanilla";

// One policy for every language the site shows, so a decision made on the
// German page stays current on the English one.
export const policyDefinition: PolicyDefinition = {
  categories: [
    {
      id: "statistics",
      label: "Messung",
      purposeIds: ["analytics"],
      translations: [{ label: "Measurement", locale: "en" }],
    },
  ],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "aggregate-measurement" }],
  presentationRootCategoryIds: ["statistics"],
  providers: [{ id: "site-operator" }],
  purposes: [
    {
      dataCategoryIds: ["usage-event"],
      disclosure: "Misst die Nutzung der Seiten in zusammengefasster Form.",
      id: "analytics",
      label: "Statistik",
      operationIds: ["aggregate-measurement"],
      providerIds: ["site-operator"],
      recipientIds: ["site-operator"],
      retentionIds: ["thirteen-months"],
      translations: [
        {
          disclosure: "Measures page use in aggregate.",
          label: "Statistics",
          locale: "en",
        },
      ],
    },
  ],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: "thirteen-months" }],
};

// The German page passes the German copy; the English page, the default.
export function startGermanPage(document: Document) {
  return bootstrapOpenCookie({
    copy: VANILLA_COPY_DE,
    document,
    policyDefinition,
  });
}

export function startEnglishPage(document: Document) {
  return bootstrapOpenCookie({ document, policyDefinition });
}
// docs:display:end

function heading(document: Document): string | null | undefined {
  return document.querySelector("label.oc-category")?.textContent;
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function run(): Promise<void> {
  const window = new Window({ url: "https://shop.example.test/" });
  const document = window.document as unknown as Document;

  const german = startGermanPage(document);
  await german.ready;
  // A first visit opens the settings from the bar.
  document
    .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
    ?.click();
  if (heading(document) !== "Messung") {
    throw new Error(`The German page showed ${String(heading(document))}.`);
  }
  await german.client.acceptAll();
  german.destroy();

  const english = startEnglishPage(document);
  await english.ready;
  if (english.client.getSnapshot().runtime.consentEvaluation.prompt) {
    throw new Error(
      "The English page asked again for a decision made in German.",
    );
  }
  english.client.openPreferences();
  await nextTask();
  if (heading(document) !== "Measurement") {
    throw new Error(`The English page showed ${String(heading(document))}.`);
  }
  english.destroy();
  window.close();
}
