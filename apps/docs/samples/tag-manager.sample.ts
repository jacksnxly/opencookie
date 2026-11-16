import { Window } from "happy-dom";

// docs:consumer-path: src/tag-manager.ts
// docs:display:start
import type { PolicyDefinition } from "@opencookie-dev/core";
import { bootstrapOpenCookieFromHead } from "@opencookie-dev/vanilla";

declare const gtag: (...call: unknown[]) => void;
declare const policyDefinition: PolicyDefinition;

// Run from <head>, before the tag manager's own snippet: the denied default
// goes first, and each signal follows the purposes it stands for, while the
// container loads when any one of them is permitted.
export function startConsent(document: Document) {
  return bootstrapOpenCookieFromHead({
    document,
    googleConsentMode: {
      command: gtag,
      mode: "basic",
      purposeMapping: {
        adPersonalizationPurposeIds: ["advertising"],
        adStoragePurposeIds: ["advertising"],
        adUserDataPurposeIds: ["advertising"],
        analyticsStoragePurposeIds: ["analytics"],
      },
    },
    policyDefinition,
  });
}
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

export async function run(): Promise<void> {
  const calls: unknown[][] = [];
  Object.assign(globalThis, {
    gtag: (...call: unknown[]) => calls.push(call),
    policyDefinition: {
      categories: [
        { id: "optional", purposeIds: ["advertising", "analytics"] },
      ],
      dataCategories: [{ id: "usage-event" }],
      operations: [{ id: "measure" }],
      presentationRootCategoryIds: ["optional"],
      providers: [{ id: "site-operator" }],
      purposes: [purpose("advertising"), purpose("analytics")],
      recipients: [{ id: "site-operator" }],
      retentions: [{ id: "thirteen-months" }],
    } satisfies PolicyDefinition,
  });
  const window = new Window({ url: "https://shop.example.test/" });
  const started = await startConsent(window.document as unknown as Document);
  await started.ready;
  await started.client.savePreferences(["analytics"]);
  const update = calls.at(-1)?.[2] as Record<string, string> | undefined;
  if (
    calls[0]?.[1] !== "default" ||
    update?.["analytics_storage"] !== "granted" ||
    update["ad_storage"] !== "denied"
  ) {
    throw new Error("Each signal must follow its own purposes.");
  }
  started.destroy();
  window.close();
}
