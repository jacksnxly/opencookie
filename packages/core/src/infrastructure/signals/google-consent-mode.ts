import type { EffectiveAccessPlan } from "../../domain/terminal-enforcement/index.js";
import { captureDataArray } from "../../domain/shared/capture-data-property.js";

/** @public */
export type GoogleConsentStatus = "denied" | "granted";

/** @public */
export interface GoogleConsentModeState {
  readonly adPersonalization: GoogleConsentStatus;
  readonly adStorage: GoogleConsentStatus;
  readonly adUserData: GoogleConsentStatus;
  readonly analyticsStorage: GoogleConsentStatus;
}

/** @public */
export interface GoogleConsentModeResourceMapping {
  readonly adPersonalizationResourceIds?: readonly string[];
  readonly adStorageResourceIds?: readonly string[];
  readonly adUserDataResourceIds?: readonly string[];
  readonly analyticsStorageResourceIds?: readonly string[];
}

/**
 * The purposes each Consent Mode signal stands for, such as advertising for
 * the three ad signals. A signal is granted while every one is permitted.
 *
 * @public
 */
export interface GoogleConsentModePurposeMapping {
  readonly adPersonalizationPurposeIds?: readonly string[];
  readonly adStoragePurposeIds?: readonly string[];
  readonly adUserDataPurposeIds?: readonly string[];
  readonly analyticsStoragePurposeIds?: readonly string[];
}

/** @public */
export interface GoogleConsentModePayload {
  readonly ad_personalization: GoogleConsentStatus;
  readonly ad_storage: GoogleConsentStatus;
  readonly ad_user_data: GoogleConsentStatus;
  readonly analytics_storage: GoogleConsentStatus;
  readonly wait_for_update?: number;
}

/** @public */
export type GoogleConsentModeCall = [
  command: "consent",
  action: "default" | "update",
  payload: GoogleConsentModePayload,
];

/** @public */
export type GoogleConsentModeCommand = (...call: GoogleConsentModeCall) => void;

/** @public */
export type GoogleConsentModeImplementation = "advanced" | "basic";

/** @public */
export interface GoogleConsentModeBroadcasterOptions {
  readonly command: GoogleConsentModeCommand;
  readonly mode?: GoogleConsentModeImplementation;
  readonly waitForUpdateMs?: number;
}

/** @public */
export type GoogleConsentModeBroadcastResult =
  | { readonly status: "already-sent" }
  | { readonly status: "command-failed" }
  | { readonly status: "defaults-not-established" }
  | { readonly status: "sent" };

/** @public */
export interface GoogleConsentModeBroadcaster {
  readonly establishDeniedDefaults: () => GoogleConsentModeBroadcastResult;
  readonly mode: GoogleConsentModeImplementation;
  readonly update: (
    state: GoogleConsentModeState,
  ) => GoogleConsentModeBroadcastResult;
}

function payloadFromState(
  state: GoogleConsentModeState,
): GoogleConsentModePayload {
  return Object.freeze({
    ad_storage: state.adStorage,
    ad_user_data: state.adUserData,
    ad_personalization: state.adPersonalization,
    analytics_storage: state.analyticsStorage,
  });
}

/**
 * Projects effective resource access into the four Consent Mode v2 fields.
 * Empty, unknown, blocked, or declared-exception-only mappings remain denied.
 *
 * @public
 */
export function projectGoogleConsentModeState(
  plan: EffectiveAccessPlan,
  mapping: GoogleConsentModeResourceMapping,
): GoogleConsentModeState {
  const resources = new Map(
    plan.resources.map((resource) => [resource.resourceId, resource]),
  );
  const statusFor = (resourceIds: unknown): GoogleConsentStatus => {
    const captured = captureDataArray<string>(resourceIds, Infinity);
    return captured?.length &&
      captured.every((resourceId) => {
        const resource = resources.get(resourceId);
        return (
          resource?.access === "allowed" &&
          resource.basis === "explicit-consent"
        );
      })
      ? "granted"
      : "denied";
  };

  return Object.freeze({
    adPersonalization: statusFor(mapping.adPersonalizationResourceIds),
    adStorage: statusFor(mapping.adStorageResourceIds),
    adUserData: statusFor(mapping.adUserDataResourceIds),
    analyticsStorage: statusFor(mapping.analyticsStorageResourceIds),
  });
}

/**
 * Projects the permitted purposes into the four Consent Mode v2 fields, for
 * tags that load inside a container serving several purposes. A signal is
 * granted while every purpose mapped to it is permitted; one mapped to none
 * stays denied.
 *
 * @public
 */
export function projectGoogleConsentModePurposeState(
  permittedPurposeIds: readonly string[],
  mapping: GoogleConsentModePurposeMapping,
): GoogleConsentModeState {
  const permitted = new Set(permittedPurposeIds);
  const statusFor = (purposeIds: unknown): GoogleConsentStatus => {
    const captured = captureDataArray<string>(purposeIds, Infinity);
    return captured?.length &&
      captured.every((purposeId) => permitted.has(purposeId))
      ? "granted"
      : "denied";
  };

  return Object.freeze({
    adPersonalization: statusFor(mapping.adPersonalizationPurposeIds),
    adStorage: statusFor(mapping.adStoragePurposeIds),
    adUserData: statusFor(mapping.adUserDataPurposeIds),
    analyticsStorage: statusFor(mapping.analyticsStoragePurposeIds),
  });
}

/** @public */
export function createGoogleConsentModeBroadcaster(
  options: GoogleConsentModeBroadcasterOptions,
): GoogleConsentModeBroadcaster {
  const mode = options.mode ?? "basic";
  if (
    options.waitForUpdateMs !== undefined &&
    (!Number.isSafeInteger(options.waitForUpdateMs) ||
      options.waitForUpdateMs < 1)
  ) {
    throw new TypeError("Consent Mode wait time must be a positive integer.");
  }
  if (mode === "basic" && options.waitForUpdateMs !== undefined) {
    throw new TypeError(
      "Consent Mode wait time is only meaningful in advanced mode.",
    );
  }

  let defaultsEstablished = false;

  return Object.freeze({
    establishDeniedDefaults(): GoogleConsentModeBroadcastResult {
      if (defaultsEstablished) return { status: "already-sent" };

      const denied: GoogleConsentModePayload = {
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
        analytics_storage: "denied",
        ...(options.waitForUpdateMs === undefined
          ? {}
          : { wait_for_update: options.waitForUpdateMs }),
      };
      try {
        options.command("consent", "default", Object.freeze(denied));
      } catch {
        return { status: "command-failed" };
      }
      defaultsEstablished = true;
      return { status: "sent" };
    },
    mode,
    update(state: GoogleConsentModeState): GoogleConsentModeBroadcastResult {
      if (!defaultsEstablished) {
        return { status: "defaults-not-established" };
      }
      try {
        options.command("consent", "update", payloadFromState(state));
      } catch {
        return { status: "command-failed" };
      }
      return { status: "sent" };
    },
  });
}
