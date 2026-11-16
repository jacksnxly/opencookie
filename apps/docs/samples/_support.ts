import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type OpenCookie,
  type OpenCookieExternalStore,
  type OpenCookieOptions,
  type PersistedConsentState,
  type PolicySnapshot,
} from "@opencookie-dev/core";

export interface DemoSnapshot {
  readonly preferencesOpen: boolean;
  readonly readiness: "ready" | "uninitialized";
}

export function createDemoStore(): OpenCookieExternalStore<DemoSnapshot> {
  const snapshot = Object.freeze({
    preferencesOpen: true,
    readiness: "ready" as const,
  });
  return Object.freeze({
    getServerSnapshot: () => snapshot,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  });
}

export function createDemoPolicySnapshot(
  policyVersion = "privacy-2026-08",
  analyticsDisclosure = "Measure aggregate product usage.",
  catalogueRevision = "catalogue-1",
): PolicySnapshot {
  const catalogue = definePolicy({
    categories: [
      { id: "optional", purposeIds: ["analytics", "personalization"] },
    ],
    dataCategories: [{ id: "display-preference" }, { id: "usage-event" }],
    operations: [
      { id: "aggregate-usage-measurement" },
      { id: "remember-display-preference" },
    ],
    presentationRootCategoryIds: ["optional"],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: analyticsDisclosure,
        id: "analytics",
        label: "Aggregate analytics",
        operationIds: ["aggregate-usage-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["up-to-180-days"],
      },
      {
        dataCategoryIds: ["display-preference"],
        id: "personalization",
        disclosure: "Remember optional display preferences.",
        label: "Personalization",
        operationIds: ["remember-display-preference"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["until-preference-reset"],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "until-preference-reset" }, { id: "up-to-180-days" }],
  });
  if (!catalogue.ok) throw new Error("The demonstration policy is invalid.");
  return createPolicySnapshot({
    catalogueRevision,
    policy: catalogue.policy,
    policyVersion,
  });
}

export function createDemoOptions(): OpenCookieOptions {
  const policySnapshot = createDemoPolicySnapshot();
  const resources = defineResourcePolicy({
    policy: policySnapshot.policy,
    resources: [],
    services: [],
  });
  if (!resources.ok)
    throw new Error("The demonstration resources are invalid.");
  let state: PersistedConsentState | null = null;
  let sequence = 0;
  return {
    consentDurationMs: 180 * 24 * 60 * 60 * 1_000,
    idGenerator: (kind) => `${kind}-${String(++sequence)}`,
    now: () => 1_780_000_000_000 + sequence,
    policyHistory: [policySnapshot],
    policySnapshot,
    resourcePolicy: resources.resourcePolicy,
    store: {
      clear: () => {
        state = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (state === null) return Promise.resolve("cleared" as const);
        if (JSON.stringify(state) !== JSON.stringify(expected)) {
          return Promise.resolve("conflict" as const);
        }
        state = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        if (JSON.stringify(state) !== JSON.stringify(expected)) {
          return Promise.resolve({ status: "conflict" });
        }
        state = candidate;
        return Promise.resolve({ status: "written" });
      },
      read: () =>
        Promise.resolve(
          state === null
            ? ({ status: "missing" } as const)
            : ({ state, status: "stored" } as const),
        ),
    },
  };
}

export function createDemoClient(): OpenCookie {
  return createOpenCookie(createDemoOptions());
}

const vanillaRoot = new URL(
  "../../../packages/adapters/vanilla/",
  import.meta.url,
);

/**
 * The file a subpath of @opencookie-dev/vanilla resolves to through the
 * package's exports map, as a bundler or a CDN path would reach it. The docs
 * app does not install the package, so its manifest is read directly.
 */
export async function resolveVanillaExport(subpath: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("package.json", vanillaRoot), "utf8"),
  ) as { exports: Record<string, unknown> };
  for (const [pattern, target] of Object.entries(manifest.exports)) {
    if (typeof target !== "string" || !pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    if (!subpath.startsWith(prefix)) continue;
    return fileURLToPath(
      new URL(target.slice(0, -1) + subpath.slice(prefix.length), vanillaRoot),
    );
  }
  throw new Error(`@opencookie-dev/vanilla does not export ${subpath}.`);
}
