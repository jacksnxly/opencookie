import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  CONSENT_RECORD_SCHEMA_VERSION,
  resolveGpcRestrictions,
  resolveGpcSignal,
  type GpcSignalObservation,
  type GpcSignalValue,
} from "@opencookie-dev/core/domain";
import {
  createCookieDecisionStore,
  type GoogleConsentModeCall,
  type GoogleConsentModeCommand,
} from "@opencookie-dev/core/infrastructure";
import type {
  OpenCookieSnapshot,
  ProcessingRestrictionSet,
} from "@opencookie-dev/core";
import { OpenCookieProvider } from "@opencookie-dev/react";
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

import App from "./App.tsx";
import { createFixtureCookieStorage } from "./cookie-storage.ts";
import "./style.css";

interface FixtureSignalGlobals {
  __ocConsentModeCalls: GoogleConsentModeCall[];
  __ocOpenCookieSnapshot?: () => OpenCookieSnapshot;
}

function serverGpcValue(): GpcSignalValue {
  const value = document.documentElement.dataset["ocServerGpc"];
  if (value !== "absent" && value !== "enabled") {
    throw new TypeError(
      "The React Vite fixture requires an exact server GPC observation marker.",
    );
  }
  return value;
}

function gpcRestrictions(): ProcessingRestrictionSet {
  const navigationId = document.location.href;
  const observedAtMs = Date.now();
  const observations: GpcSignalObservation[] = [
    {
      navigationId,
      observedAtMs,
      source: "server",
      value: serverGpcValue(),
    },
  ];
  const browserValue = (
    navigator as Navigator & {
      readonly globalPrivacyControl?: unknown;
    }
  ).globalPrivacyControl;
  if (typeof browserValue === "boolean") {
    observations.push({
      navigationId,
      observedAtMs,
      source: "browser",
      value: browserValue ? "enabled" : "absent",
    });
  }

  return resolveGpcRestrictions({
    resolution: resolveGpcSignal({ navigationId, observations }),
    whenEnabled: { purposeIds: ["analytics"] },
  });
}

const fixtureGlobals = globalThis as typeof globalThis & FixtureSignalGlobals;
fixtureGlobals.__ocConsentModeCalls = [];
const consentModeCommand: GoogleConsentModeCommand = (...call) => {
  fixtureGlobals.__ocConsentModeCalls.push(call);
};
const consentDurationMs =
  document.location.pathname === "/short-expiry"
    ? 1_000
    : 180 * 24 * 60 * 60 * 1_000;
document.documentElement.dataset.ocExpiryMs = String(consentDurationMs);
const storageFixture = document.documentElement.dataset["ocStorageFixture"];
if (
  storageFixture !== undefined &&
  storageFixture !== "local" &&
  storageFixture !== "cookie"
) {
  throw new TypeError(`Unknown fixture storage mode: ${storageFixture}`);
}
const persistence =
  storageFixture === "local"
    ? {}
    : storageFixture === "cookie"
      ? {
          store: createCookieDecisionStore({
            hostname: document.location.hostname,
            jar: {
              read: () => document.cookie,
              write(serializedCookie: string): void {
                document.cookie = serializedCookie;
              },
            },
            key: "opencookie.consent",
            maxAgeSeconds: Math.floor(consentDurationMs / 1_000),
            path: "/",
            schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
            scope: {
              domain: "react-vite.opencookie.test",
              kind: "shared",
              registrableDomainResolver: {
                resolve: (hostname: string) =>
                  hostname === "opencookie.test" ||
                  hostname.endsWith(".opencookie.test")
                    ? "opencookie.test"
                    : null,
              },
            },
            secure: document.location.protocol === "https:",
          }),
        }
      : {
          storage: createFixtureCookieStorage("react-vite.opencookie.test"),
        };
if (storageFixture !== undefined) {
  document.documentElement.dataset["ocStorageAdapter"] =
    storageFixture === "local"
      ? "default-local-storage"
      : "cookie-decision-store";
}

const bootstrap = bootstrapOpenCookie({
  consentDurationMs,
  googleConsentMode: {
    command: consentModeCommand,
    mapping: { analyticsStorageResourceIds: ["analytics-script"] },
    mode: "basic",
  },
  nonce: "fixture-nonce",
  onError(error) {
    document.documentElement.dataset["ocError"] =
      error instanceof Error ? error.message : String(error);
  },
  privacyRestrictions: gpcRestrictions(),
  policyVersion:
    document.location.pathname === "/policy-v2" ? "policy-2" : "policy-1",
  ...persistence,
});
fixtureGlobals.__ocOpenCookieSnapshot = () => bootstrap.client.getSnapshot();

void bootstrap.ready.then(() => {
  document.documentElement.dataset["ocReady"] = "true";
});

const root = document.querySelector<HTMLElement>("#root");
if (root === null) throw new Error("React fixture root is missing.");

createRoot(root).render(
  <StrictMode>
    <OpenCookieProvider store={bootstrap.client}>
      <App />
    </OpenCookieProvider>
  </StrictMode>,
);
