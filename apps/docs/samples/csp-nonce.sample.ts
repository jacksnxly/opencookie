import { Window } from "happy-dom";

// docs:consumer-path: src/csp-nonce.ts
// docs:display:start
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

export function mountWithNonce(document: Document, nonce: string) {
  return bootstrapOpenCookie({ document, nonce });
}
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window();
  window.document.body.innerHTML = [
    '<script type="text/plain"',
    ' data-oc-category="analytics"',
    ' data-oc-resource="aggregate-metrics">',
    "globalThis.__metricsLoaded = true;</script>",
  ].join("");
  const mounted = mountWithNonce(
    window.document as unknown as Document,
    "request-nonce-42",
  );
  await mounted.ready;
  const style = window.document.querySelector("style[data-opencookie]");
  if (style?.getAttribute("nonce") !== "request-nonce-42") {
    throw new Error("The CSP nonce did not reach the generated style element.");
  }
  await mounted.client.acceptAll();
  const active = window.document.querySelector(
    'script[data-oc-active-resource="aggregate-metrics"]',
  ) as HTMLScriptElement | null;
  if (active?.nonce !== "request-nonce-42") {
    throw new Error("The CSP nonce did not reach the activated script.");
  }
  mounted.destroy();
  window.close();
}
