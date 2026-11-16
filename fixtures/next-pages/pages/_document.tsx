import Document, {
  Head,
  Html,
  Main,
  NextScript,
  type DocumentContext,
  type DocumentInitialProps,
} from "next/document";

interface FixtureDocumentProps extends DocumentInitialProps {
  readonly expiryProfile: "short-real-time" | "standard";
  readonly gpcSource: "none" | "sec-gpc" | "synthetic-test-only";
  readonly nonce: string;
}

export default class FixtureDocument extends Document<FixtureDocumentProps> {
  static override async getInitialProps(
    context: DocumentContext,
  ): Promise<FixtureDocumentProps> {
    const initialProps = await Document.getInitialProps(context);
    const header = context.req?.headers["x-nonce"];
    const nonce = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    const requestedExpiry = context.req?.headers["x-opencookie-expiry-profile"];
    const expiryHeader = Array.isArray(requestedExpiry)
      ? requestedExpiry[0]
      : requestedExpiry;
    const expiryProfile =
      expiryHeader === "short-real-time" ? "short-real-time" : "standard";
    const requestedGpc = context.req?.headers["x-opencookie-gpc-source"];
    const gpcHeader = Array.isArray(requestedGpc)
      ? requestedGpc[0]
      : requestedGpc;
    const gpcSource =
      gpcHeader === "sec-gpc" || gpcHeader === "synthetic-test-only"
        ? gpcHeader
        : "none";
    return { ...initialProps, expiryProfile, gpcSource, nonce };
  }

  override render() {
    const { expiryProfile, gpcSource, nonce } = this.props;
    return (
      <Html
        lang="en"
        data-expiry-profile={expiryProfile}
        data-gpc-source={gpcSource}
        data-oc-server-gpc={gpcSource === "sec-gpc" ? "enabled" : "absent"}
      >
        <Head nonce={nonce}>
          <meta name="oc-nonce" content={nonce} />
          <meta name="oc-expiry-profile" content={expiryProfile} />
          <meta name="oc-gpc-source" content={gpcSource} />
        </Head>
        <body>
          <Main />
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
            data-src="http://tracker.next-pages.opencookie.test:4400/analytics.js?resource=initial"
          />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}
