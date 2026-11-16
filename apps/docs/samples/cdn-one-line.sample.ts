import { Window } from "happy-dom";

// docs:consumer-path: index.html
// docs:display:start
export const openCookieCdn = String.raw`<script defer src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js" integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS" crossorigin="anonymous" data-oc-policy-version="2026-08-22" data-oc-storage-key="oc_consent" data-oc-purpose-id="analytics" data-oc-purpose-label="Analytics" data-oc-purpose-description="Measure site usage without identifying visitors."></script>`;
// docs:display:end

export function run(): void {
  const window = new Window();
  window.document.body.innerHTML = openCookieCdn;
  const script = window.document.querySelector("script");
  if (script?.defer !== true) {
    throw new Error(
      "The CDN sample did not create the pinned deferred script.",
    );
  }
  const expected = {
    src: "https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js",
    integrity:
      "sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS",
    crossorigin: "anonymous",
    "data-oc-policy-version": "2026-08-22",
    "data-oc-storage-key": "oc_consent",
    "data-oc-purpose-id": "analytics",
    "data-oc-purpose-label": "Analytics",
    "data-oc-purpose-description":
      "Measure site usage without identifying visitors.",
  };
  for (const [attribute, value] of Object.entries(expected)) {
    if (script.getAttribute(attribute) !== value) {
      throw new Error(`The CDN sample has an invalid ${attribute} attribute.`);
    }
  }
  window.close();
}
