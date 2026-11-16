import { useState } from "react";
import { useOpenCookieSnapshot } from "@opencookie-dev/react";
import type { OpenCookieSnapshot } from "@opencookie-dev/core";

function appendAnalyticsResource(sequence: number): void {
  const script = document.createElement("script");
  script.type = "text/plain";
  script.dataset["ocResource"] = "analytics-script";
  script.dataset["ocCategory"] = "analytics";
  script.dataset["src"] =
    `http://tracker.react-vite.opencookie.test:4400/analytics.js?resource=dynamic-${String(sequence)}`;
  document.head.append(script);
}

export default function App() {
  const snapshot = useOpenCookieSnapshot<OpenCookieSnapshot>();
  const [routeSequence, setRouteSequence] = useState(0);

  const openDynamicRoute = (): void => {
    const nextSequence = routeSequence + 1;
    history.pushState(
      { fixture: "react-vite" },
      "",
      `/spa/${String(nextSequence)}`,
    );
    appendAnalyticsResource(nextSequence);
    setRouteSequence(nextSequence);
  };

  return (
    <>
      <header className="site-header">
        <a className="brand" href="/">
          OpenCookie React fixture
        </a>
        <button
          id="route-control"
          data-testid="route-control"
          type="button"
          onClick={openDynamicRoute}
        >
          Open dynamic route
        </button>
      </header>
      <main id="content-sentinel" data-testid="content-sentinel">
        <p className="eyebrow">React 19 and Vite 8 production fixture</p>
        <h1>Consent behavior should survive real application navigation.</h1>
        <p>
          This page uses the workspace React binding and the same vanilla
          interface that consumers install.
        </p>
        <dl className="status-grid">
          <div>
            <dt>Route</dt>
            <dd>
              <output
                id="fixture-status"
                data-testid="fixture-status"
                aria-live="polite"
              >
                {routeSequence === 0
                  ? "Initial route"
                  : `Dynamic route ${String(routeSequence)}`}
              </output>
            </dd>
          </div>
          <div>
            <dt>Consent</dt>
            <dd data-testid="consent-status">
              {snapshot.runtime.consentEvaluation.status}
            </dd>
          </div>
        </dl>
      </main>
    </>
  );
}
