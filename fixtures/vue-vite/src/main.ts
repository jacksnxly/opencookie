import { createApp } from "vue";
import {
  resolveGpcRestrictions,
  resolveGpcSignal,
  type GpcSignalObservation,
  type GpcSignalValue,
} from "@opencookie-dev/core/domain";
import type {
  GoogleConsentModeCall,
  GoogleConsentModeCommand,
} from "@opencookie-dev/core/infrastructure";
import type {
  OpenCookieSnapshot,
  ProcessingRestrictionSet,
} from "@opencookie-dev/core";
import { createOpenCookiePlugin } from "@opencookie-dev/vue";
import { bootstrapOpenCookie } from "@opencookie-dev/vanilla";

import App from "./App.vue";
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
      "The Vue Vite fixture requires an exact server GPC observation marker.",
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
  storage: createFixtureCookieStorage("vue-vite.opencookie.test"),
});
fixtureGlobals.__ocOpenCookieSnapshot = () => bootstrap.client.getSnapshot();

void bootstrap.ready.then(() => {
  document.documentElement.dataset["ocReady"] = "true";
});

createApp(App).use(createOpenCookiePlugin(bootstrap.client)).mount("#app");
