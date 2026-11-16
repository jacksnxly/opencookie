import { Window } from "happy-dom";
import type { PolicyDefinition } from "@opencookie-dev/core";
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

// docs:consumer-path: snippets/tag-manager.html
// docs:display:start
export const tagManager = String.raw`<script
  type="text/plain"
  data-src="https://tags.example.com/container.js"
  data-oc-resource="tag-manager"
  data-oc-category="analytics advertising"
  data-oc-match="any"
  data-oc-stores="analytics=cookie:_sample_an advertising=cookie:_sample_ad_*"
></script>`;
// docs:display:end

const purpose = (id: string) => ({
  dataCategoryIds: ["usage-event"] as [string],
  disclosure: `Uses ${id}.`,
  id,
  operationIds: ["measure"] as [string],
  providerIds: ["site-operator"] as [string],
  recipientIds: ["site-operator"] as [string],
  retentionIds: ["thirteen-months"] as [string],
});

const policyDefinition: PolicyDefinition = {
  categories: [{ id: "optional", purposeIds: ["advertising", "analytics"] }],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "measure" }],
  presentationRootCategoryIds: ["optional"],
  providers: [{ id: "site-operator" }],
  purposes: [purpose("advertising"), purpose("analytics")],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: "thirteen-months" }],
};

export async function run(): Promise<void> {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = tagManager;
  const document = window.document as unknown as Document;
  const started = bootstrapOpenCookie({ document, policyDefinition });
  await started.ready;
  await started.client.savePreferences(["analytics"]);
  if (
    document.querySelector('[data-oc-active-resource="tag-manager"]') === null
  ) {
    throw new Error(
      "The container must load when one of its purposes is permitted.",
    );
  }
  started.destroy();
  window.close();
}
