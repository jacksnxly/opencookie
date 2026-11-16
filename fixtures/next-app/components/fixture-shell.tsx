"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const FIXTURE_NAME = "next-app";

function routeSequence(pathname: string): number {
  const match = pathname.match(/^\/spa\/(\d+)$/u);
  return match === null ? 0 : Number.parseInt(match[1] ?? "0", 10);
}

function appendAnalyticsResource(sequence: number): void {
  if (
    document.querySelector(
      `script[data-oc-route-sequence="${String(sequence)}"]`,
    ) !== null
  ) {
    return;
  }
  const script = document.createElement("script");
  script.type = "text/plain";
  script.dataset.ocResource = "analytics-script";
  script.dataset.ocCategory = "analytics";
  script.dataset.ocRouteSequence = String(sequence);
  script.dataset.src = `http://tracker.${FIXTURE_NAME}.opencookie.test:4400/analytics.js?resource=dynamic-${String(sequence)}`;
  document.head.append(script);
}

export function FixtureShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();
  const sequence = routeSequence(pathname);

  useEffect(() => {
    if (sequence > 0) appendAnalyticsResource(sequence);
  }, [sequence]);

  return (
    <>
      <header className="site-header">
        <Link className="brand" href="/">
          OpenCookie Next App fixture
        </Link>
        <button
          id="route-control"
          data-testid="route-control"
          type="button"
          onClick={() => router.push(`/spa/${String(sequence + 1)}`)}
        >
          Open dynamic route
        </button>
      </header>
      <main
        id="content-sentinel"
        data-fixture-root="next-app"
        data-testid="content-sentinel"
      >
        <p className="eyebrow">Next 16 App Router production fixture</p>
        <h1>Consent behavior should survive server and client navigation.</h1>
        <p>
          This page uses the workspace Next binding and the same vanilla
          interface that consumers install.
        </p>
        <dl className="status-grid">
          <div>
            <dt>Route</dt>
            <dd>
              <output id="fixture-status" data-testid="fixture-status">
                {sequence === 0
                  ? "Initial route"
                  : `Dynamic route ${String(sequence)}`}
              </output>
            </dd>
          </div>
          <div>
            <dt>Router</dt>
            <dd>App Router</dd>
          </div>
        </dl>
        <template
          data-oc-iframe=""
          title="Optional product video"
          data-oc-resource="product-video"
          data-oc-category="analytics"
          data-src={`http://tracker.${FIXTURE_NAME}.opencookie.test:4400/frame`}
        />
        {children}
      </main>
    </>
  );
}
