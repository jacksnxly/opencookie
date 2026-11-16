import { Window } from "happy-dom";
import { createBlockedScriptController } from "@opencookie-dev/vanilla";

// docs:consumer-path: snippets/declared-storage.html
// docs:display:start
export const declaredStorage = String.raw`<script
  type="text/plain"
  data-src="/metrics.js"
  data-oc-resource="aggregate-metrics"
  data-oc-category="analytics"
  data-oc-stores="cookie:_metrics local:metrics_*"
></script>`;
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = declaredStorage;
  window.localStorage.setItem("metrics_visit", "1");
  window.localStorage.setItem("cart", "1");
  await createBlockedScriptController({
    category: "analytics",
    document: window.document as unknown as Document,
    resourceId: "aggregate-metrics",
  }).cleanup();
  if (
    window.localStorage.getItem("metrics_visit") !== null ||
    window.localStorage.getItem("cart") !== "1"
  ) {
    throw new Error("Only the declared entry must be deleted.");
  }
  window.close();
}
