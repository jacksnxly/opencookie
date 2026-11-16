import type { Metadata } from "next";
import { headers } from "next/headers";

import { ConsentRuntime } from "@/components/consent-runtime";
import { FixtureShell } from "@/components/fixture-shell";

import "./globals.css";

export const metadata: Metadata = {
  description: "Production fixture for the OpenCookie Next App Router binding.",
  title: "OpenCookie Next App fixture",
};

export const dynamic = "force-dynamic";

const STANDARD_CONSENT_DURATION_MS = 180 * 24 * 60 * 60 * 1000;
const SHORT_CONSENT_DURATION_MS = 1_000;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce");
  if (nonce === null || nonce.length === 0) {
    throw new Error("The fixture server did not provide a CSP nonce.");
  }
  const requestedGpcSource = requestHeaders.get("x-opencookie-gpc-source");
  const gpcSource =
    requestedGpcSource === "sec-gpc" ||
    requestedGpcSource === "synthetic-test-only"
      ? requestedGpcSource
      : "none";
  const expiryProfile =
    requestHeaders.get("x-opencookie-expiry-profile") === "short-real-time"
      ? "short-real-time"
      : "standard";
  const consentDurationMs =
    expiryProfile === "short-real-time"
      ? SHORT_CONSENT_DURATION_MS
      : STANDARD_CONSENT_DURATION_MS;

  return (
    <html
      lang="en"
      data-expiry-profile={expiryProfile}
      data-gpc-source={gpcSource}
      data-oc-server-gpc={gpcSource === "sec-gpc" ? "enabled" : "absent"}
    >
      <body>
        <ConsentRuntime
          consentDurationMs={consentDurationMs}
          expiryProfile={expiryProfile}
          gpcSource={gpcSource}
          nonce={nonce}
        >
          <FixtureShell>{children}</FixtureShell>
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html:
                "(()=>{const element=document.querySelector('#content-sentinel');if(element){const rect=element.getBoundingClientRect();globalThis.__ocSsrGeometry={height:rect.height,width:rect.width,x:rect.x,y:rect.y}}})()",
            }}
          />
          <script nonce={nonce} defer src="/essential.js" />
          <script
            nonce={nonce}
            type="text/plain"
            data-oc-resource="analytics-script"
            data-oc-category="analytics"
            data-src="http://tracker.next-app.opencookie.test:4400/analytics.js?resource=initial"
          />
        </ConsentRuntime>
      </body>
    </html>
  );
}
