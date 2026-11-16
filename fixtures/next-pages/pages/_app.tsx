import App, { type AppContext, type AppProps } from "next/app";
import Head from "next/head";

import { ConsentRuntime } from "@/components/consent-runtime";
import { FixtureShell } from "@/components/fixture-shell";
import "@/styles/globals.css";

interface FixturePageProps {
  readonly expiryProfile?: "short-real-time" | "standard";
  readonly fixtureNonce?: string;
  readonly gpcSource?: "none" | "sec-gpc" | "synthetic-test-only";
}

const STANDARD_CONSENT_DURATION_MS = 180 * 24 * 60 * 60 * 1000;
const SHORT_CONSENT_DURATION_MS = 1_000;

export default function FixtureApp({
  Component,
  pageProps,
}: AppProps<FixturePageProps>) {
  const nonce =
    typeof document === "undefined"
      ? (pageProps.fixtureNonce ?? "")
      : (document
          .querySelector<HTMLMetaElement>('meta[name="oc-nonce"]')
          ?.getAttribute("content") ?? "");
  const expiryProfile =
    typeof document === "undefined"
      ? (pageProps.expiryProfile ?? "standard")
      : document
            .querySelector<HTMLMetaElement>('meta[name="oc-expiry-profile"]')
            ?.getAttribute("content") === "short-real-time"
        ? "short-real-time"
        : "standard";
  const documentGpcSource =
    typeof document === "undefined"
      ? null
      : document
          .querySelector<HTMLMetaElement>('meta[name="oc-gpc-source"]')
          ?.getAttribute("content");
  const gpcSource =
    typeof document === "undefined"
      ? (pageProps.gpcSource ?? "none")
      : documentGpcSource === "sec-gpc" ||
          documentGpcSource === "synthetic-test-only"
        ? documentGpcSource
        : "none";
  const consentDurationMs =
    expiryProfile === "short-real-time"
      ? SHORT_CONSENT_DURATION_MS
      : STANDARD_CONSENT_DURATION_MS;

  return (
    <>
      <Head>
        <title>OpenCookie Next Pages fixture</title>
      </Head>
      <ConsentRuntime
        consentDurationMs={consentDurationMs}
        expiryProfile={expiryProfile}
        gpcSource={gpcSource}
        nonce={nonce}
      >
        <FixtureShell>
          <Component {...pageProps} />
        </FixtureShell>
      </ConsentRuntime>
    </>
  );
}

FixtureApp.getInitialProps = async (context: AppContext) => {
  const appProps = await App.getInitialProps(context);
  const header = context.ctx.req?.headers["x-nonce"];
  const fixtureNonce = Array.isArray(header) ? header[0] : header;
  const requestedExpiry =
    context.ctx.req?.headers["x-opencookie-expiry-profile"];
  const expiryHeader = Array.isArray(requestedExpiry)
    ? requestedExpiry[0]
    : requestedExpiry;
  const expiryProfile =
    expiryHeader === "short-real-time" ? "short-real-time" : "standard";
  const requestedGpc = context.ctx.req?.headers["x-opencookie-gpc-source"];
  const gpcHeader = Array.isArray(requestedGpc)
    ? requestedGpc[0]
    : requestedGpc;
  const gpcSource =
    gpcHeader === "sec-gpc" || gpcHeader === "synthetic-test-only"
      ? gpcHeader
      : "none";
  return {
    ...appProps,
    pageProps: {
      ...appProps.pageProps,
      expiryProfile,
      gpcSource,
      ...(fixtureNonce === undefined ? {} : { fixtureNonce }),
    },
  };
};
