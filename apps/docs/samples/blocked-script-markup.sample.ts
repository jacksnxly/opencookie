import { Window } from "happy-dom";

// docs:consumer-path: snippets/blocked-analytics.html
// docs:display:start
export const blockedAnalytics = String.raw`<script
  type="text/plain"
  data-src="/metrics.js"
  data-oc-resource="aggregate-metrics"
  data-oc-category="analytics"
></script>`;
// docs:display:end

export function run(): void {
  const window = new Window();
  window.document.body.innerHTML = blockedAnalytics;
  const script = window.document.querySelector("script");
  if (
    script?.type !== "text/plain" ||
    script.hasAttribute("src") ||
    script.dataset["src"] !== "/metrics.js" ||
    script.dataset["ocResource"] !== "aggregate-metrics" ||
    script.dataset["ocCategory"] !== "analytics"
  ) {
    throw new Error("The optional script is not inert and fully declared.");
  }
  window.close();
}
