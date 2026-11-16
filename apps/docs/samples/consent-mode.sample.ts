import { Window } from "happy-dom";

// docs:consumer-path: src/consent-mode.ts
// docs:display:start
import type {
  GoogleConsentModeCall,
  GoogleConsentModeCommand,
} from "@opencookie-dev/core/infrastructure";
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

export function mountConsentMode(
  document: Document,
  command: GoogleConsentModeCommand,
) {
  return bootstrapOpenCookie({
    document,
    googleConsentMode: {
      command,
      mapping: { analyticsStorageResourceIds: ["aggregate-metrics"] },
      mode: "basic",
    },
  });
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
  const calls: GoogleConsentModeCall[] = [];
  const mounted = mountConsentMode(
    window.document as unknown as Document,
    (...call) => calls.push(call),
  );
  if (calls.length !== 1 || calls[0]?.[1] !== "default") {
    throw new Error("Consent Mode defaults were not established first.");
  }
  await mounted.ready;
  await mounted.client.acceptAll();
  mounted.client.openPreferences();
  await mounted.client.withdrawConsent();
  const finalCalls = calls.slice();
  if (
    finalCalls.length !== 3 ||
    finalCalls[1]?.[1] !== "update" ||
    finalCalls[1]?.[2].analytics_storage !== "granted" ||
    finalCalls[2]?.[1] !== "update" ||
    finalCalls[2]?.[2].analytics_storage !== "denied"
  ) {
    throw new Error("Consent Mode did not follow default, grant, withdrawal.");
  }
  mounted.destroy();
  window.close();
}
