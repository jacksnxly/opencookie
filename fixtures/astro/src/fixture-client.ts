import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type OpenCookie,
  type OpenCookieIdKind,
} from "@opencookie-dev/core";
import {
  resolveGpcRestrictions,
  resolveGpcSignal,
} from "@opencookie-dev/core/domain";
import {
  createAccessEnforcementReconciler,
  createGoogleConsentModeBroadcaster,
  projectAccessEnforcementDecisions,
  projectGoogleConsentModeState,
  type GoogleConsentModeCall,
} from "@opencookie-dev/core/infrastructure";
import {
  createBlockedIframeController,
  createBlockedScriptController,
  mountOpenCookie,
} from "@opencookie-dev/vanilla";

import { createFixtureCookieStorage } from "./cookie-storage";

const FIXTURE_NAME = "astro";
const DEFAULT_DURATION_MS = 180 * 24 * 60 * 60 * 1000;
const SHORT_DURATION_MS = 1_000;

declare global {
  var __ocConsentModeCalls: GoogleConsentModeCall[] | undefined;
}

export interface BootstrappedFixtureOpenCookie {
  readonly client: OpenCookie;
  readonly destroy: () => void;
  readonly ready: Promise<void>;
}

function idGenerator(document: Document): (kind: OpenCookieIdKind) => string {
  let sequence = 0;
  return (kind) => {
    const random = document.defaultView?.crypto.randomUUID?.();
    return `${kind}-${random ?? `${String(Date.now())}-${String(++sequence)}`}`;
  };
}

function gpcRestrictions(document: Document) {
  const navigationId = `${FIXTURE_NAME}:${document.location.pathname}`;
  const observations = [];
  if (document.documentElement.dataset.ocServerGpc === "enabled") {
    observations.push({
      navigationId,
      observedAtMs: 0,
      source: "server" as const,
      value: "enabled" as const,
    });
  }
  const synthetic =
    new URL(document.location.href).searchParams.get("synthetic-gpc") === "1";
  const fixtureNavigator = document.defaultView?.navigator as
    (Navigator & { readonly globalPrivacyControl?: boolean }) | undefined;
  const browserGpc = fixtureNavigator?.globalPrivacyControl === true;
  if (synthetic || browserGpc) {
    observations.push({
      navigationId,
      observedAtMs: 1,
      source: "browser" as const,
      value: "enabled" as const,
    });
  }
  document.documentElement.dataset.ocGpcBrowser = synthetic
    ? "synthetic-enabled"
    : browserGpc
      ? "native-enabled"
      : "absent";
  const resolution = resolveGpcSignal({ navigationId, observations });
  document.documentElement.dataset.ocGpcEffective = resolution.effectiveValue;
  return resolveGpcRestrictions({
    resolution,
    whenEnabled: { purposeIds: ["analytics"] },
  });
}

export function bootstrapOpenCookieFixture(
  document: Document,
  nonce?: string,
): BootstrappedFixtureOpenCookie {
  const policy = definePolicy({
    categories: [{ id: "optional", purposeIds: ["analytics"] }],
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "aggregate-usage-measurement" }],
    presentationRootCategoryIds: ["optional"],
    providers: [{ id: "fixture-site" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Understand aggregate site usage.",
        id: "analytics",
        label: "Analytics",
        operationIds: ["aggregate-usage-measurement"],
        providerIds: ["fixture-site"],
        recipientIds: ["fixture-site"],
        retentionIds: ["browser-test-lifetime"],
      },
    ],
    recipients: [{ id: "fixture-site" }],
    retentions: [{ id: "browser-test-lifetime" }],
  });
  if (!policy.ok) throw new TypeError("Fixture policy is invalid.");
  const resources = defineResourcePolicy({
    policy: policy.policy,
    resources: [
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics"],
        serviceId: "analytics-service",
      },
      {
        access: "optional",
        id: "product-video",
        purposeIds: ["analytics"],
        serviceId: "analytics-service",
      },
    ],
    services: [{ id: "analytics-service" }],
  });
  if (!resources.ok) throw new TypeError("Fixture resource policy is invalid.");

  const controller = createBlockedScriptController({
    category: "analytics",
    document,
    ...(nonce === undefined ? {} : { nonce }),
    resourceId: "analytics-script",
  });
  const iframeController = createBlockedIframeController({
    category: "analytics",
    document,
    resourceId: "product-video",
  });
  const reconciler = createAccessEnforcementReconciler({
    resources: {
      "analytics-script": controller,
      "product-video": iframeController,
    },
  });
  const calls = (globalThis.__ocConsentModeCalls ??= []);
  calls.length = 0;
  const consentMode = createGoogleConsentModeBroadcaster({
    command: (...call) => calls.push(call),
    mode: "advanced",
  });
  consentMode.establishDeniedDefaults();

  const shortExpiry = document.location.pathname === "/short-expiry";
  const consentDurationMs = shortExpiry
    ? SHORT_DURATION_MS
    : DEFAULT_DURATION_MS;
  document.documentElement.dataset.ocExpiryMode = shortExpiry
    ? "real-clock-short"
    : "default";
  document.documentElement.dataset.ocExpiryMs = String(consentDurationMs);

  const client = createOpenCookie({
    broadcast(effect) {
      consentMode.update(
        projectGoogleConsentModeState(effect.runtime.effectiveAccess, {
          analyticsStorageResourceIds: ["analytics-script"],
        }),
      );
      return Promise.resolve();
    },
    consentDurationMs,
    idGenerator: idGenerator(document),
    now: Date.now,
    policySnapshot: createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: policy.policy,
      policyVersion:
        document.location.pathname === "/policy-v2" ? "policy-2" : "policy-1",
    }),
    privacyRestrictions: gpcRestrictions(document),
    reconcile: async (effect) => {
      const result = await reconciler.reconcile(
        projectAccessEnforcementDecisions(effect.runtime.effectiveAccess),
      );
      if (result.failures.length > 0) {
        throw new Error("Fixture access enforcement failed.");
      }
    },
    resourcePolicy: resources.resourcePolicy,
    store: createLocalStorageDecisionStore({
      key: "opencookie.consent",
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      storage: createFixtureCookieStorage(`${FIXTURE_NAME}.opencookie.test`),
    }),
  });
  const mounted = mountOpenCookie({
    client,
    document,
    ...(nonce === undefined ? {} : { nonce }),
  });

  let destroyed = false;
  const reconcileCurrent = async (): Promise<void> => {
    const snapshot = client.getSnapshot();
    if (snapshot.record !== undefined) {
      consentMode.update(
        projectGoogleConsentModeState(snapshot.runtime.effectiveAccess, {
          analyticsStorageResourceIds: ["analytics-script"],
        }),
      );
    }
    const result = await reconciler.reconcile(
      projectAccessEnforcementDecisions(snapshot.runtime.effectiveAccess),
    );
    if (result.failures.length > 0) {
      throw new Error("Fixture access enforcement failed.");
    }
  };
  const observer = new MutationObserver(() => {
    if (destroyed) return;
    void reconciler.reconcile(
      projectAccessEnforcementDecisions(
        client.getSnapshot().runtime.effectiveAccess,
      ),
    );
  });
  const ready = mounted.ready.then(async () => {
    await reconcileCurrent();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });

  return Object.freeze({
    client,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      mounted.destroy();
      void controller.stop();
    },
    ready,
  });
}
