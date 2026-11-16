import {
  createAutoOpenCookieFactory,
  establishAutoGoogleConsentDefaults,
  type AutoOpenCookieGoogleInput,
  type AutoOpenCookieGpcInput,
  type AutoOpenCookieGpcObservation,
  type AutoOpenCookiePersistenceInput,
  type AutoOpenCookiePolicySection,
  type AutoOpenCookieRuntimeOptions,
  type AutoOpenCookieStorage,
} from "@opencookie-dev/core/auto";

import {
  createVanillaBrowserRuntime,
  type VanillaBrowserRuntime,
} from "./browser-runtime.js";
import { VANILLA_COPY_DE } from "./locale-de.js";
import {
  composeVanillaProduct,
  createVanillaBrowserClock,
  DEFAULT_CONSENT_DURATION_MS,
  defaultBrowserIdGenerator,
  defaultBrowserStorage,
  type DefaultBrowserStorage,
} from "./product-composition.js";

const RUNNING = Symbol.for("opencookie.drop-in");

/** One raw browser cookie jar handle. @internal */
export interface AutoBootstrapCookieJar {
  readonly read: () => string;
  readonly write: (serializedCookie: string) => void;
}

/** Testable runtime overrides for the classic-script auto entry. @internal */
export interface AutoBootstrapRuntimeOptions {
  /** The page claim an earlier task of this copy already holds. */
  readonly claim?: object;
  readonly cookieJar?: AutoBootstrapCookieJar;
  /** A Google input whose defaults an earlier task already sent. */
  readonly google?: AutoOpenCookieGoogleInput;
  readonly idGenerator?: AutoOpenCookieRuntimeOptions["idGenerator"];
  readonly now?: () => number;
  readonly reload?: () => void;
  readonly storage?: AutoOpenCookieStorage;
}

/** A reader of the stored decision exactly as stored, or undefined if none. */
function storedDecisionReader(
  persistence: AutoOpenCookiePersistenceInput,
): () => Promise<string | undefined> {
  if (persistence.kind === "unavailable")
    return () => Promise.resolve(undefined);
  // The defaults core applies: a cookie name may not contain a dot.
  const key =
    persistence.key ??
    (persistence.kind === "cookie"
      ? "opencookie-consent"
      : "opencookie.consent");
  const read = (): string | undefined => {
    if (persistence.kind !== "cookie") {
      // The default storage's peek leaves its write guard untouched.
      const { storage } = persistence;
      const { peek } = storage as Partial<DefaultBrowserStorage>;
      return (
        (peek === undefined ? storage.getItem(key) : peek(key)) ?? undefined
      );
    }
    const values = persistence
      .read()
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith(`${key}=`));
    return values.length === 0 ? undefined : values.join(";");
  };
  return () => Promise.resolve().then(read);
}

function optionalAttribute(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0
    ? undefined
    : normalized;
}

function configuredConsentDuration(script: HTMLScriptElement): number {
  const value = optionalAttribute(script.dataset["ocConsentDurationMs"]);
  if (value === undefined) return DEFAULT_CONSENT_DURATION_MS;
  const durationMs = Number(value);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new TypeError(
      "data-oc-consent-duration-ms must be a positive safe integer.",
    );
  }
  return durationMs;
}

function documentCookieJar(document: Document): AutoBootstrapCookieJar {
  return Object.freeze({
    read: () => document.cookie,
    write: (serializedCookie: string) => {
      document.cookie = serializedCookie;
    },
  });
}

function configuredPersistence(
  document: Document,
  script: HTMLScriptElement,
  storageKey: string | undefined,
  runtime: AutoBootstrapRuntimeOptions,
): AutoOpenCookiePersistenceInput {
  const storageKind = optionalAttribute(script.dataset["ocStorage"]);
  const cookieDomain = optionalAttribute(script.dataset["ocCookieDomain"]);
  const registrableDomain = optionalAttribute(
    script.dataset["ocRegistrableDomain"],
  );

  if (
    storageKind !== undefined &&
    storageKind !== "local-storage" &&
    storageKind !== "cookie"
  ) {
    throw new TypeError(
      'data-oc-storage must be either "local-storage" or "cookie".',
    );
  }
  if (storageKind !== "cookie") {
    if (cookieDomain !== undefined || registrableDomain !== undefined) {
      throw new TypeError(
        'Cookie boundary attributes require data-oc-storage="cookie".',
      );
    }
    if (runtime.cookieJar !== undefined) {
      throw new TypeError(
        'A cookie jar override requires data-oc-storage="cookie".',
      );
    }
    return {
      ...(storageKey === undefined ? {} : { key: storageKey }),
      kind: "local-storage",
      storage: runtime.storage ?? defaultBrowserStorage(document),
    };
  }
  if (runtime.storage !== undefined) {
    throw new TypeError(
      "A Web Storage override cannot be used with cookie storage.",
    );
  }
  if ((cookieDomain === undefined) !== (registrableDomain === undefined)) {
    throw new TypeError(
      "Cookie domain and registrable domain must be configured together.",
    );
  }

  const hostname = document.defaultView?.location.hostname;
  if (hostname === undefined || hostname.length === 0) {
    throw new TypeError("Cookie storage requires a document hostname.");
  }
  const jar = runtime.cookieJar ?? documentCookieJar(document);
  return {
    ...(cookieDomain === undefined ? {} : { domain: cookieDomain }),
    hostname,
    ...(storageKey === undefined ? {} : { key: storageKey }),
    kind: "cookie",
    read: jar.read,
    ...(registrableDomain === undefined ? {} : { registrableDomain }),
    secure: document.defaultView?.location.protocol === "https:",
    write: jar.write,
  };
}

function configuredGoogleInput(
  document: Document,
  script: HTMLScriptElement,
): AutoOpenCookieGoogleInput | undefined {
  const mode = optionalAttribute(script.dataset["ocGoogleConsentMode"]);
  const resourceAttributes = {
    adPersonalizationResourceIds: optionalAttribute(
      script.dataset["ocGoogleAdPersonalizationResource"],
    ),
    adStorageResourceIds: optionalAttribute(
      script.dataset["ocGoogleAdStorageResource"],
    ),
    adUserDataResourceIds: optionalAttribute(
      script.dataset["ocGoogleAdUserDataResource"],
    ),
    analyticsStorageResourceIds: optionalAttribute(
      script.dataset["ocGoogleAnalyticsResource"],
    ),
  };
  const hasMapping = Object.values(resourceAttributes).some(
    (value) => value !== undefined,
  );
  if (mode === undefined) {
    if (hasMapping) {
      throw new TypeError(
        "Google resource mappings require data-oc-google-consent-mode.",
      );
    }
    return undefined;
  }
  if (mode !== "basic" && mode !== "advanced") {
    throw new TypeError(
      'data-oc-google-consent-mode must be either "basic" or "advanced".',
    );
  }
  const command = (
    document.defaultView as unknown as
      { readonly gtag?: AutoOpenCookieGoogleInput["command"] } | undefined
  )?.gtag;
  if (typeof command !== "function") {
    throw new TypeError(
      "Google Consent Mode requires a gtag command function before OpenCookie starts.",
    );
  }
  return {
    command,
    mapping: Object.fromEntries(
      Object.entries(resourceAttributes).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, [value]]],
      ),
    ),
    mode,
  };
}

function serverGpcValue(
  value: string | undefined,
): "absent" | "enabled" | undefined {
  if (value === undefined) return undefined;
  if (value !== "absent" && value !== "enabled") {
    throw new TypeError(
      'data-oc-server-gpc must be either "absent" or "enabled".',
    );
  }
  return value;
}

function configuredGpcInput(
  document: Document,
  script: HTMLScriptElement,
  configuredPurposeId: string,
  now: () => number,
): AutoOpenCookieGpcInput | undefined {
  const purposeId = optionalAttribute(script.dataset["ocGpcPurposeId"]);
  const serverValue = serverGpcValue(
    optionalAttribute(script.dataset["ocServerGpc"]),
  );
  if (purposeId === undefined) {
    if (serverValue !== undefined) {
      throw new TypeError(
        "A server GPC observation requires data-oc-gpc-purpose-id.",
      );
    }
    return undefined;
  }
  if (purposeId.normalize("NFKC").toLowerCase() !== configuredPurposeId) {
    throw new TypeError(
      "data-oc-gpc-purpose-id must name the configured purpose.",
    );
  }

  const navigationId = document.defaultView?.location.href ?? "document";
  const observedAtMs = now();
  const observations: AutoOpenCookieGpcObservation[] = [];
  if (serverValue !== undefined) {
    observations.push({
      observedAtMs,
      source: "server",
      value: serverValue,
    });
  }
  const browserValue = (
    document.defaultView?.navigator as unknown as
      { readonly globalPrivacyControl?: unknown } | undefined
  )?.globalPrivacyControl;
  if (typeof browserValue === "boolean") {
    observations.push({
      observedAtMs,
      source: "browser",
      value: browserValue ? "enabled" : "absent",
    });
  }

  return { navigationId, observations };
}

/**
 * Claims the page for one copy of the drop-in, or refuses because another
 * copy has it. Returns the release.
 */
function claimPage(document: Document, claim: object = {}): () => void {
  // A second copy would mount a second bar whose decisions go stale. Copies
  // are separate bundles that share only the page, and a copy presents tasks
  // after it starts, so until its root exists its claim on the document
  // speaks for it.
  const claims = document as unknown as Record<symbol, object | undefined>;
  if (
    document.querySelector("[data-oc-root]") !== null ||
    (claims[RUNNING] !== undefined && claims[RUNNING] !== claim)
  ) {
    throw new Error(
      "OpenCookie is already running on this page, so this copy did nothing.",
    );
  }
  claims[RUNNING] = claim;
  return () => {
    if (claims[RUNNING] === claim) claims[RUNNING] = undefined;
  };
}

/** Starts the one-line CDN bootstrap from a captured classic script. @internal */
export function startAutoBootstrap(
  document: Document,
  script: HTMLScriptElement,
  runtime: AutoBootstrapRuntimeOptions = {},
): VanillaBrowserRuntime {
  // Started in turns, the drop-in waits for the body instead.
  if (document.querySelector("body") === null) {
    throw new Error(
      "The OpenCookie drop-in requires a browser document with a body.",
    );
  }
  return prepareAutoBootstrap(document, script, runtime)();
}

const nextTask = (): Promise<unknown> =>
  new Promise((resolve) => setTimeout(resolve));

/** Resolves once the body exists; from `<head>`, when the document is parsed. */
const bodyParsed = (document: Document): Promise<unknown> =>
  document.querySelector("body") === null
    ? new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
      })
    : Promise.resolve();

/**
 * Starts the drop-in over four tasks. The script's own task claims the page
 * and sends the Consent Mode default, which must precede any later page
 * script, even from `<head>`. Once the body exists, the next builds the
 * factory, the one after it the runtime, and the last mounts the bar. A
 * failure in a later task leaves Consent Mode denied and frees the page.
 * @internal
 */
export function startAutoBootstrapInTurns(
  document: Document,
  script: HTMLScriptElement,
  runtime: AutoBootstrapRuntimeOptions = {},
): Promise<VanillaBrowserRuntime> {
  const claim = {};
  const release = claimPage(document, claim);
  let google: AutoOpenCookieGoogleInput | undefined;
  try {
    google = configuredGoogleInput(document, script);
    if (google !== undefined) {
      google = establishAutoGoogleConsentDefaults(google);
    }
  } catch (error) {
    release();
    throw error;
  }
  const options = {
    ...runtime,
    claim,
    ...(google === undefined ? {} : { google }),
  };
  return bodyParsed(document)
    .then(nextTask)
    .then(() => prepareAutoBootstrap(document, script, options))
    .then((launch) => nextTask().then(launch))
    .catch((error: unknown) => {
      release();
      throw error;
    });
}

/** Reads the attributes and builds the factory; the result starts the runtime. */
function prepareAutoBootstrap(
  document: Document,
  script: HTMLScriptElement,
  runtime: AutoBootstrapRuntimeOptions,
): () => VanillaBrowserRuntime {
  const release = claimPage(document, runtime.claim);
  try {
    return launchAutoBootstrap(document, script, runtime, release);
  } catch (error) {
    release();
    throw error;
  }
}

function launchAutoBootstrap(
  document: Document,
  script: HTMLScriptElement,
  runtime: AutoBootstrapRuntimeOptions,
  release: () => void,
): () => VanillaBrowserRuntime {
  const locale = optionalAttribute(script.dataset["ocLocale"]) ?? "en";
  if (locale !== "en" && locale !== "de") {
    throw new TypeError('data-oc-locale must be either "en" or "de".');
  }
  const policyVersion = optionalAttribute(script.dataset["ocPolicyVersion"]);
  const storageKey = optionalAttribute(script.dataset["ocStorageKey"]);
  const consentDurationMs = configuredConsentDuration(script);
  const purposeId = optionalAttribute(script.dataset["ocPurposeId"]);
  const purposeLabel = optionalAttribute(script.dataset["ocPurposeLabel"]);
  const purposeDescription = optionalAttribute(
    script.dataset["ocPurposeDescription"],
  );
  const nonce = optionalAttribute(script.nonce);
  const now = createVanillaBrowserClock(document, runtime.now ?? Date.now);
  const idGenerator =
    runtime.idGenerator ?? defaultBrowserIdGenerator(document, now);

  const factory = createAutoOpenCookieFactory({
    consentDurationMs,
    ...(purposeDescription === undefined
      ? {}
      : { disclosure: purposeDescription }),
    ...(policyVersion === undefined ? {} : { policyVersion }),
    ...(purposeId === undefined ? {} : { purposeId }),
    ...(purposeLabel === undefined ? {} : { purposeLabel }),
  });
  // The compact auto factory always materializes its single policy section.
  const section = factory.policySections[0] as AutoOpenCookiePolicySection;
  const purposeIds = section.purposeIds;
  const persistence = configuredPersistence(
    document,
    script,
    storageKey,
    runtime,
  );
  const google = runtime.google ?? configuredGoogleInput(document, script);
  const gpc = configuredGpcInput(document, script, factory.purposeId, now);

  return () => {
    let started: VanillaBrowserRuntime;
    try {
      started = createVanillaBrowserRuntime({
        ...(locale === "de" ? { copy: VANILLA_COPY_DE } : {}),
        categoryDependencyResolver: (_policy, selectedPurposeIds) =>
          selectedPurposeIds.length > 0 ? purposeIds : [],
        categoryResolver: (_policy, categoryIds) =>
          factory.expandCategorySelection(categoryIds),
        sectionResolver: (_policy, selectedPurposeIds) => [
          {
            ...section,
            checked: selectedPurposeIds.size > 0,
            indeterminate: false,
          },
        ],
        document,
        knownPurposeIds: new Set(purposeIds),
        ...(nonce === undefined ? {} : { nonce }),
        // The denied-state kernel starts in this task and the bar mounts in the
        // next, so neither half holds the main thread for the whole boot.
        presentationTurn: nextTask(),
        purposeResolver: () => purposeIds,
        readStoredDecision: storedDecisionReader(persistence),
        ...(runtime.reload === undefined ? {} : { reload: runtime.reload }),
        prepareProduct:
          (declarativeResources) =>
          ({ controllers, runWhileActive }) => {
            let enforceCurrentAccess: (() => Promise<void>) | undefined;
            const client = factory.create({
              controllers,
              ...(google === undefined ? {} : { google }),
              ...(gpc === undefined ? {} : { gpc }),
              idGenerator,
              now,
              onEnforcementReady: (enforce) => {
                enforceCurrentAccess = enforce;
              },
              persistence,
              // Post-enforcement destruction aftercare: when the runtime is torn
              // down while an enforcement operation is in flight, the shared
              // owner cleans the browser resources after the operation settles.
              reconcile: () => runWhileActive(() => Promise.resolve()),
              resources: declarativeResources.map((resource) => ({
                id: resource.resourceId,
                serviceId: resource.serviceId,
              })),
            });
            return composeVanillaProduct({
              client,
              enforceCurrentAccess: () =>
                runWhileActive(
                  () => enforceCurrentAccess?.() ?? Promise.resolve(),
                ),
              now,
            });
          },
      });
    } catch (error) {
      release();
      throw error;
    }
    // Once presented, the root speaks for this copy; a copy that never presents
    // leaves the page to the next one.
    void started.ready.then(release, release);
    return started;
  };
}
