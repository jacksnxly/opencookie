import { Window } from "happy-dom";
import {
  bootstrapOpenCookie,
  OPENCOOKIE_CHANGE_EVENT,
  type OpenCookieChangeDetail,
} from "@opencookie-dev/vanilla";

// docs:consumer-path: snippets/vendor-bridge.html
// docs:display:start
export const vendorBridge = String.raw`<a href="#" data-oc-open-preferences>Cookie settings</a>
<script>
  document.addEventListener("opencookie:change", (event) => {
    if (event.detail.permitted.includes("analytics")) startAnalyticsVendor();
    else stopAnalyticsVendor();
  });
</script>`;
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window({ url: "https://shop.example.test/" });
  const document = window.document as unknown as Document;
  const running: boolean[] = [];
  document.addEventListener(OPENCOOKIE_CHANGE_EVENT, (event) => {
    const { detail } = event as CustomEvent<OpenCookieChangeDetail>;
    running.push(detail.permitted.includes("analytics"));
  });
  const started = bootstrapOpenCookie({ document });
  await started.ready;
  await started.client.acceptAll();
  await started.client.rejectAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (running.join(",") !== "false,true,false") {
    throw new Error(`The bridge heard ${running.join(",")}.`);
  }
  started.destroy();
  window.close();
}
