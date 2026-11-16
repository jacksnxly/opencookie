import { Window } from "happy-dom";

// docs:consumer-path: src/pre-consent-blocking.ts
// docs:display:start
import { createBlockedScriptController } from "@opencookie-dev/vanilla";

export function protectAnalytics(document: Document) {
  return createBlockedScriptController({
    category: "analytics",
    document,
    resourceId: "aggregate-metrics",
  });
}
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window();
  window.document.body.innerHTML = [
    '<script type="text/plain"',
    ' data-oc-category="analytics"',
    ' data-oc-resource="aggregate-metrics"',
    ' data-src="/metrics.js"></script>',
  ].join("");
  const controller = protectAnalytics(window.document as unknown as Document);
  if ((await controller.discover()) !== "blocked") {
    throw new Error("The optional script was not inert before consent.");
  }
  window.close();
}
