import { Window } from "happy-dom";

// docs:consumer-path: examples/shared-subdomain.html
// docs:display:start
export const sharedSubdomainSnippet = String.raw`<script defer data-oc-storage="cookie" data-oc-storage-key="site_consent" data-oc-cookie-domain="apps.example.com" data-oc-registrable-domain="example.com" integrity="sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS" crossorigin="anonymous" src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.4.0/dist/auto.iife.js"></script>`;
// docs:display:end

export function run(): void {
  const window = new Window({ url: "https://shop.apps.example.com/" });
  window.document.body.innerHTML = sharedSubdomainSnippet;
  const script = window.document.querySelector("script");
  const expected = {
    "data-oc-cookie-domain": "apps.example.com",
    "data-oc-registrable-domain": "example.com",
    "data-oc-storage": "cookie",
    "data-oc-storage-key": "site_consent",
    integrity:
      "sha384-hkKtmu0yhY+0myfpO6CDVN9dgdER+9VCnH+Cwh7vGYt4jbN6GdbD5L+fcmeMlMWS",
    crossorigin: "anonymous",
  };
  for (const [attribute, value] of Object.entries(expected)) {
    if (script?.getAttribute(attribute) !== value) {
      throw new Error(`The shared-cookie sample has an invalid ${attribute}.`);
    }
  }
  window.close();
}
