import type { DecisionStore } from "../application/persistence/persist-grant.js";
import { createOpenCookieKernel } from "../application/runtime/create-open-cookie-kernel.js";
import type { ConsentRuntimeProjectionContext } from "../application/runtime/consent-runtime-projection-context.js";
import { projectCurrentConsentPolicy } from "../application/runtime/project-consent-runtime-kernel.js";
import type { ConsentRuntimeTransitionEffect } from "../application/runtime/execute-consent-runtime-decision-kernel.js";
import type {
  ConsentRuntimeAftercareHook,
  OpenCookie,
  OpenCookieIdKind,
  OpenCookieKernelOptions,
  OpenCookiePortContext,
} from "../application/runtime/open-cookie-kernel-contract.js";
import { CONSENT_RECORD_SCHEMA_VERSION } from "../domain/consent-decisioning/consent-record.js";
import {
  defineAutoPolicy,
  defineAutoResourcePolicy,
} from "../domain/policy-catalogue/define-auto-policy.js";
import { resolveGpcRestrictions } from "../domain/privacy-preference-resolution/resolve-gpc-restrictions.js";
import { resolveGpcSignal } from "../domain/privacy-preference-resolution/resolve-gpc-signal.js";
import type { ProcessingRestrictionSet } from "../domain/shared/processing-restriction.js";
import { resolveAllOfEffectiveAccess } from "../domain/terminal-enforcement/resolve-effective-access.js";
import {
  createAccessEnforcementReconciler,
  projectAccessEnforcementDecisions,
  type DiscoveredResourceState,
  type EnforcementOperationResult,
} from "../infrastructure/enforcement/reconcile-access.js";
import {
  createGoogleConsentModeBroadcaster,
  projectGoogleConsentModeState,
  type GoogleConsentModeBroadcaster,
  type GoogleConsentModeCommand,
} from "../infrastructure/signals/google-consent-mode.js";
import { createCapturedCookieDecisionStore } from "../infrastructure/storage/cookie-decision-store.js";
import { createLocalStorageDecisionStore } from "../infrastructure/storage/local-storage-decision-store.js";
import {
  captureAutoGoogleValues,
  captureAutoOpenCookieDefinitionValues,
  captureAutoOpenCookieRuntimeValues,
  type CapturedAutoController,
  type CapturedAutoGoogleMapping,
  type CapturedAutoGoogleValues,
  type CapturedAutoGpcValues,
  type CapturedAutoOpenCookieRuntimeOptions,
  type CapturedAutoPersistenceValues,
} from "./capture-auto-inputs.js";
import { createUnavailableDecisionStore } from "./unavailable-decision-store.js";

/** The complete policy definition of the auto product. @public */
export interface AutoOpenCookieDefinition {
  readonly catalogueRevision?: string;
  readonly consentDurationMs: number;
  readonly consentId?: string;
  readonly disclosure?: string;
  readonly locale?: string;
  readonly policyVersion?: string;
  readonly purposeId?: string;
  readonly purposeLabel?: string;
}

/** A declarative resource bound to the captured purpose. @public */
export interface AutoOpenCookieResourceInput {
  readonly id: string;
  readonly serviceId: string;
}

/** Raw Web Storage handle for the local-storage persistence kind. @public */
export interface AutoOpenCookieStorage {
  readonly getItem: (key: string) => string | null;
  readonly removeItem: (key: string) => void;
  readonly setItem: (key: string, value: string) => void;
}

/** Raw persistence configuration resolved inside the auto product. @public */
export type AutoOpenCookiePersistenceInput =
  | {
      readonly domain?: string;
      readonly hostname: string;
      readonly key?: string;
      readonly kind: "cookie";
      readonly read: () => string;
      readonly registrableDomain?: string;
      readonly secure: boolean;
      readonly write: (serializedCookie: string) => void;
    }
  | {
      readonly key?: string;
      readonly kind: "local-storage";
      readonly storage: AutoOpenCookieStorage;
    }
  | { readonly kind: "unavailable" };

/** One raw Global Privacy Control observation. @public */
export interface AutoOpenCookieGpcObservation {
  readonly observedAtMs: number;
  readonly source: "browser" | "server";
  readonly value: "absent" | "disabled" | "enabled";
}

/** Raw GPC observations resolved inside the auto product. @public */
export interface AutoOpenCookieGpcInput {
  readonly navigationId: string;
  readonly observations: readonly AutoOpenCookieGpcObservation[];
}

/** Google Consent Mode resource mapping for the four v2 signals. @public */
export interface AutoOpenCookieGoogleResourceMapping {
  readonly adPersonalizationResourceIds?: readonly string[];
  readonly adStorageResourceIds?: readonly string[];
  readonly adUserDataResourceIds?: readonly string[];
  readonly analyticsStorageResourceIds?: readonly string[];
}

/** Raw Google Consent Mode configuration for the auto product. @public */
export interface AutoOpenCookieGoogleInput {
  readonly command: GoogleConsentModeCommand;
  readonly mapping?: AutoOpenCookieGoogleResourceMapping;
  readonly mode: "advanced" | "basic";
}

/** Raw enforcement controller for one declared resource. @public */
export interface AutoOpenCookieController {
  readonly block: () => Promise<EnforcementOperationResult>;
  readonly cleanup: () => Promise<EnforcementOperationResult>;
  readonly discover: () => Promise<DiscoveredResourceState>;
  readonly start: () => Promise<EnforcementOperationResult>;
  readonly stop: () => Promise<void>;
}

/** Raw runtime inputs of one auto client composition. @public */
export interface AutoOpenCookieRuntimeOptions {
  readonly broadcast?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly controllers?: Readonly<Record<string, AutoOpenCookieController>>;
  readonly google?: AutoOpenCookieGoogleInput;
  readonly gpc?: AutoOpenCookieGpcInput;
  readonly idGenerator: (kind: OpenCookieIdKind) => string;
  readonly initialTime?: number;
  readonly now: () => number;
  readonly onEnforcementReady?: (
    enforceCurrentAccess: () => Promise<void>,
  ) => void;
  readonly onListenerError?: (error: unknown) => void;
  readonly persistence: AutoOpenCookiePersistenceInput;
  readonly reconcile?: (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ) => Promise<void>;
  readonly resources?: readonly AutoOpenCookieResourceInput[];
}

/** The captured auto factory. @public */
export interface AutoOpenCookieFactory {
  readonly consentDurationMs: number;
  readonly create: (options: AutoOpenCookieRuntimeOptions) => OpenCookie;
  readonly expandCategorySelection: (
    categoryIds: readonly string[],
  ) => readonly string[];
  readonly policySections: readonly AutoOpenCookiePolicySection[];
  readonly purposeId: string;
}

/** One category-backed presentation section for the compact auto policy. @public */
export interface AutoOpenCookiePolicySection {
  readonly categoryId: string;
  readonly purposeIds: readonly string[];
}

const noopAftercare: ConsentRuntimeAftercareHook = Object.freeze(() =>
  Promise.resolve(),
);
const captureNoopAftercare = Object.freeze(
  (): ConsentRuntimeAftercareHook => noopAftercare,
);

function autoDecisionStore(
  persistence: CapturedAutoPersistenceValues,
  consentDurationMs: number,
): DecisionStore {
  if (persistence[0] === "unavailable") {
    return createUnavailableDecisionStore();
  }
  if (persistence[0] === "local-storage") {
    return createLocalStorageDecisionStore({
      key: persistence[1],
      schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
      storage: persistence[2],
    });
  }
  const [, domain, hostname, key, read, registrableDomain, secure, write] =
    persistence;
  return createCapturedCookieDecisionStore({
    ...(domain === undefined || registrableDomain === undefined
      ? {}
      : {
          domain,
          registrableDomain,
        }),
    hostname,
    jar: Object.freeze({ read, write }),
    key,
    maxAgeSeconds: Math.ceil(consentDurationMs / 1_000),
    schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
    secure,
  });
}

function autoPrivacyRestrictions(
  gpc: CapturedAutoGpcValues | undefined,
  purposeId: string,
): ProcessingRestrictionSet | undefined {
  if (gpc === undefined) return undefined;
  const [navigationId, observations] = gpc;
  return resolveGpcRestrictions({
    resolution: resolveGpcSignal({
      navigationId,
      observations,
    }),
    whenEnabled: { purposeIds: [purposeId] },
  });
}

function requireGoogleUpdate(
  broadcaster: GoogleConsentModeBroadcaster,
  effect: ConsentRuntimeTransitionEffect,
  mapping: CapturedAutoGoogleMapping,
): void {
  const result = broadcaster.update(
    projectGoogleConsentModeState(effect.runtime.effectiveAccess, mapping),
  );
  if (result.status !== "sent") {
    throw new Error(
      `Google Consent Mode update failed with status ${result.status}.`,
    );
  }
}

function autoBroadcast(
  broadcast: CapturedAutoOpenCookieRuntimeOptions["broadcast"],
  google: CapturedAutoGoogleValues | undefined,
  broadcaster: GoogleConsentModeBroadcaster | undefined,
): OpenCookieKernelOptions["broadcast"] {
  if (broadcaster === undefined || google === undefined) {
    return broadcast;
  }
  return async (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ): Promise<void> => {
    requireGoogleUpdate(broadcaster, effect, google[1]);
    await broadcast?.(effect, context);
  };
}

type AutoAccessEnforcement = (
  plan: ConsentRuntimeTransitionEffect["runtime"]["effectiveAccess"],
) => Promise<void>;

function autoAccessEnforcement(
  controllers: Readonly<Record<string, CapturedAutoController>> | undefined,
): AutoAccessEnforcement | undefined {
  if (controllers === undefined) return undefined;
  const reconciler = createAccessEnforcementReconciler({
    resources: controllers,
  });
  return async (plan) => {
    const result = await reconciler.reconcile(
      projectAccessEnforcementDecisions(plan),
    );
    if (result.failures.length) {
      throw new Error(
        `OpenCookie could not enforce ${String(result.failures.length)} declarative resource operation(s).`,
      );
    }
  };
}

function autoReconcile(
  reconcile: CapturedAutoOpenCookieRuntimeOptions["reconcile"],
  enforcement: AutoAccessEnforcement | undefined,
): OpenCookieKernelOptions["reconcile"] {
  if (enforcement === undefined) return reconcile;
  return async (
    effect: ConsentRuntimeTransitionEffect,
    context?: OpenCookiePortContext,
  ): Promise<void> => {
    await enforcement(effect.runtime.effectiveAccess);
    await reconcile?.(effect, context);
  };
}

/**
 * Sends the denied Google Consent Mode defaults now, before a factory exists.
 *
 * The defaults must precede any measurement command, but building the factory
 * and its client in that same task is what makes a cold first load long. The
 * returned input is the captured one with a command that drops the one
 * default a later `create` repeats; updates pass through. It fails as
 * `create` would: an invalid input throws a TypeError, and a failing command
 * throws.
 *
 * @public
 */
export function establishAutoGoogleConsentDefaults(
  input: AutoOpenCookieGoogleInput,
): AutoOpenCookieGoogleInput {
  const [command, mapping, mode] = captureAutoGoogleValues(input);
  const defaults = createGoogleConsentModeBroadcaster({
    command,
    mode,
  }).establishDeniedDefaults();
  if (defaults.status !== "sent") {
    throw new Error(
      `Google Consent Mode defaults failed with status ${defaults.status}.`,
    );
  }
  let repeated = false;
  const forward: GoogleConsentModeCommand = (...call) => {
    if (!repeated && call[1] === "default") {
      repeated = true;
      return;
    }
    command(...call);
  };
  return Object.freeze({ command: forward, mapping, mode });
}

/**
 * Creates the dedicated compact auto product factory. The complete definition
 * is captured once through own data descriptors, with the consent duration
 * validated before any other observation; the factory exposes only that
 * captured purpose id and consent duration, so cookie lifetime, policy
 * retention, and record expiry all derive from the same validated value.
 * Each `create` call captures its raw persistence, GPC, Google, controller,
 * clock, identifier, and callback inputs, resolves them into core-owned
 * frozen state, and composes the shared receipt-neutral lifecycle kernel
 * with a frozen no-op aftercare hook. The private kernel stays reachable
 * only through this closure.
 *
 * @public
 */
export function createAutoOpenCookieFactory(
  definition: AutoOpenCookieDefinition,
): AutoOpenCookieFactory {
  const [
    catalogueRevision,
    consentDurationMs,
    consentId,
    disclosure,
    locale,
    policyVersion,
    purposeId,
    purposeLabel,
  ] = captureAutoOpenCookieDefinitionValues(definition);
  const policy = defineAutoPolicy({
    catalogueRevision,
    consentDurationMs,
    disclosure,
    policyVersion,
    purposeId,
    purposeLabel,
  });

  const create = (options: AutoOpenCookieRuntimeOptions): OpenCookie => {
    const [
      runtimeBroadcast,
      controllers,
      google,
      gpc,
      idGenerator,
      initialTime,
      now,
      onEnforcementReady,
      onListenerError,
      persistence,
      runtimeReconcile,
      resources,
    ] = captureAutoOpenCookieRuntimeValues(options);
    const resourcePolicy = defineAutoResourcePolicy(policy, resources);
    const store = autoDecisionStore(persistence, consentDurationMs);
    const privacyRestrictions = autoPrivacyRestrictions(gpc, policy.purposeId);
    const projectionContext: ConsentRuntimeProjectionContext = Object.freeze({
      policyHistory: Object.freeze([policy.snapshot]),
      policySnapshot: policy.snapshot,
      ...(privacyRestrictions === undefined ? {} : { privacyRestrictions }),
      projectPolicy: projectCurrentConsentPolicy,
      // Each resource serves the one purpose, so the any-of rule stays out.
      resolveAccess: resolveAllOfEffectiveAccess,
      resourcePolicy,
    });
    let broadcaster: GoogleConsentModeBroadcaster | undefined;
    if (google !== undefined) {
      broadcaster = createGoogleConsentModeBroadcaster({
        command: google[0],
        mode: google[2],
      });
      const defaults = broadcaster.establishDeniedDefaults();
      if (defaults.status !== "sent") {
        throw new Error(
          `Google Consent Mode defaults failed with status ${defaults.status}.`,
        );
      }
    }
    const broadcast = autoBroadcast(runtimeBroadcast, google, broadcaster);
    const enforcement = autoAccessEnforcement(controllers);
    const reconcile = autoReconcile(runtimeReconcile, enforcement);

    const client = createOpenCookieKernel(
      Object.freeze({
        ...(broadcast === undefined ? {} : { broadcast }),
        consentDurationMs,
        ...(consentId === undefined ? {} : { consentId }),
        idGenerator,
        ...(initialTime === undefined ? {} : { initialTime }),
        ...(locale === undefined ? {} : { locale }),
        now,
        ...(onListenerError === undefined ? {} : { onListenerError }),
        ...(reconcile === undefined ? {} : { reconcile }),
        store,
      }),
      captureNoopAftercare,
      projectionContext,
    );
    if (onEnforcementReady !== undefined) {
      const enforceCurrentAccess =
        enforcement === undefined
          ? () => Promise.resolve()
          : () => enforcement(client.getSnapshot().runtime.effectiveAccess);
      Object.freeze(enforceCurrentAccess);
      onEnforcementReady(enforceCurrentAccess);
    }
    return client;
  };

  return Object.freeze({
    consentDurationMs,
    create,
    expandCategorySelection: policy.expandCategorySelection,
    policySections: policy.policySections,
    purposeId: policy.purposeId,
  });
}
