import type { PolicyDefinition } from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie, VANILLA_COPY_DE } from "./index.js";

// A category with one purpose of the same name used to show that name twice,
// once as the heading and once as the choice.

function policy(categoryLabel: string): PolicyDefinition {
  return {
    categories: [
      { id: "statistics", label: categoryLabel, purposeIds: ["analytics"] },
    ],
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "measure" }],
    presentationRootCategoryIds: ["statistics"],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Misst die Nutzung der Seiten.",
        id: "analytics",
        label: "Statistik",
        operationIds: ["measure"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["thirteen-months"],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "thirteen-months" }],
  };
}

async function settings(categoryLabel: string) {
  const window = new Window({ url: "https://shop.example.test/" });
  const document = window.document as unknown as Document;
  const started = bootstrapOpenCookie({
    copy: VANILLA_COPY_DE,
    document,
    policyDefinition: policy(categoryLabel),
  });
  await started.ready;
  document
    .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
    ?.click();
  const panel = document.querySelector(".oc-panel");
  const seen = {
    heading: panel?.querySelector("label.oc-category")?.textContent ?? null,
    names: [...(panel?.querySelectorAll(".oc-purpose strong") ?? [])].map(
      (name) => name.textContent,
    ),
    times: panel?.textContent.split("Statistik").length ?? 0,
  };
  started.destroy();
  window.close();
  return seen;
}

describe("a category named like its only purpose", () => {
  it("shows the shared name once", async () => {
    expect(await settings(" statistik ")).toEqual({
      heading: null,
      names: ["Statistik"],
      times: 2,
    });
  });

  it("keeps the heading when the names differ", async () => {
    const seen = await settings("Messung");
    expect(seen.heading).toBe("Messung");
    expect(seen.names).toEqual(["Statistik"]);
  });
});
