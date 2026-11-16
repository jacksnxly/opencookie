import { useEffect, useState, type ReactNode } from "react";
import {
  type OpenCookie,
  type OpenCookieSnapshot,
} from "@opencookie-dev/core";
import {
  createGoogleConsentModeBroadcaster,
  projectGoogleConsentModeState,
  type GoogleConsentModeCall,
} from "@opencookie-dev/core/infrastructure";
import { OpenCookieProvider, useOpenCookieSnapshot } from "@opencookie-dev/next";
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

import { createFixtureCookieStorage } from "./cookie-storage";

declare global {
  interface Window {
    __ocConsentModeCalls?: GoogleConsentModeCall[];
  }
}

function ConsentStatus() {
  const snapshot = useOpenCookieSnapshot<OpenCookieSnapshot>();
  return (
    <output className="consent-marker" data-testid="consent-status">
      {snapshot.runtime.consentEvaluation.status}
    </output>
  );
}

export function ConsentRuntime({
  children,
  consentDurationMs,
  expiryProfile,
  gpcSource,
  nonce,
}: Readonly<{
  children: ReactNode;
  consentDurationMs: number;
  expiryProfile: "short-real-time" | "standard";
  gpcSource: "none" | "sec-gpc" | "synthetic-test-only";
  nonce: string;
}>) {
  const [client, setClient] = useState<OpenCookie>();

  useEffect(() => {
    let active = true;
    const reportError = (error: unknown): void => {
      document.documentElement.dataset.ocError =
        error instanceof Error ? error.message : String(error);
    };
    const consentModeCalls: GoogleConsentModeCall[] = [];
    window.__ocConsentModeCalls = consentModeCalls;
    const consentMode = createGoogleConsentModeBroadcaster({
      command: (...call) => consentModeCalls.push(call),
    });
    consentMode.establishDeniedDefaults();
    if (gpcSource !== "none") {
      for (const resource of document.querySelectorAll<HTMLElement>(
        '[data-oc-category="analytics"][data-oc-resource]',
      )) {
        resource.dataset.ocGpcBlocked = gpcSource;
        delete resource.dataset.ocResource;
      }
    }
    const bootstrap = bootstrapOpenCookie({
      consentDurationMs,
      nonce,
      onError: reportError,
      policyVersion:
        document.location.pathname === "/policy-v2" ? "policy-2" : "policy-1",
      storage: createFixtureCookieStorage("next-pages.opencookie.test"),
    });
    let lastBroadcastRecord = "";
    const broadcastCurrentRecord = (): void => {
      const snapshot = bootstrap.client.getSnapshot();
      if (snapshot.record === undefined) return;
      const recordKey = `${snapshot.record.recordId}:${String(snapshot.record.decidedAt)}:${snapshot.record.method}`;
      if (recordKey === lastBroadcastRecord) return;
      lastBroadcastRecord = recordKey;
      consentMode.update(
        projectGoogleConsentModeState(snapshot.runtime.effectiveAccess, {
          analyticsStorageResourceIds: ["analytics-script"],
        }),
      );
    };
    const unsubscribe = bootstrap.client.subscribe(broadcastCurrentRecord);
    document.documentElement.dataset.ocHydrated = "true";
    document.documentElement.dataset.ocExpiryMs = String(consentDurationMs);
    document.documentElement.dataset.ocExpiryProfile = expiryProfile;
    document.documentElement.dataset.ocGpcSource = gpcSource;
    void bootstrap.ready
      .then(() => {
        broadcastCurrentRecord();
        if (!active) return;
        setClient(bootstrap.client);
        document.documentElement.dataset.ocReady = "true";
      })
      .catch(reportError);

    return () => {
      active = false;
      unsubscribe();
      bootstrap.destroy();
      delete document.documentElement.dataset.ocExpiryProfile;
      delete document.documentElement.dataset.ocExpiryMs;
      delete document.documentElement.dataset.ocGpcSource;
      delete document.documentElement.dataset.ocHydrated;
      delete document.documentElement.dataset.ocReady;
    };
  }, [consentDurationMs, expiryProfile, gpcSource, nonce]);

  return (
    <>
      {client === undefined ? null : (
        <OpenCookieProvider store={client}>
          <ConsentStatus />
        </OpenCookieProvider>
      )}
      {children}
    </>
  );
}
