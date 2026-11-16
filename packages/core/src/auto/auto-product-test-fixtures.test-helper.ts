import { expect } from "vitest";

import { createAutoOpenCookieFactory } from "../auto.js";
import {
  createOpenCookie,
  type OpenCookie,
  type OpenCookieIdKind,
  type OpenCookieSnapshot,
} from "../application/runtime/create-open-cookie.js";
import { CONSENT_RECORD_SCHEMA_VERSION } from "../domain/consent-decisioning/index.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type PolicyDefinition,
} from "../domain/policy-catalogue/index.js";
import {
  resolveGpcRestrictions,
  resolveGpcSignal,
  type GpcSignalObservation,
  type GpcSignalSource,
  type GpcSignalValue,
} from "../domain/privacy-preference-resolution/index.js";
import { createCookieDecisionStore } from "../infrastructure/storage/cookie-decision-store.js";
import {
  createLocalStorageDecisionStore,
  type StorageLike,
} from "../infrastructure/storage/local-storage-decision-store.js";
import { createUnavailableDecisionStore } from "./unavailable-decision-store.js";

export const AUTO_TEST_STORAGE_KEY = "opencookie.consent";
export const AUTO_TEST_COOKIE_KEY = "opencookie-consent";

export function singlePurposeTestPolicy(
  id: string,
  label: string,
  disclosure: string,
  consentDurationMs: number,
  editorialNote?: string,
): PolicyDefinition {
  const retentionId = `duration-${String(consentDurationMs)}-ms`;
  return {
    categories: [{ id: "optional", purposeIds: [id] }],
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "aggregate-measurement" }],
    presentationRootCategoryIds: ["optional"],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure,
        ...(editorialNote === undefined ? {} : { editorialNote }),
        id,
        label,
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: [retentionId],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: retentionId }],
  };
}

export interface TestClock {
  readonly advance: (milliseconds: number) => void;
  readonly now: () => number;
}

export function createTestClock(initialTime = 1_000): TestClock {
  let time = initialTime;
  return Object.freeze({
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    now: () => time,
  });
}

export function createSequentialIdGenerator(): (
  kind: OpenCookieIdKind,
) => string {
  const counters = new Map<OpenCookieIdKind, number>();
  return (kind: OpenCookieIdKind): string => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}-${String(next)}`;
  };
}

export interface MemoryStorageBehavior {
  dropNextSet: boolean;
  failNextSet: boolean;
  vanishNextSet: boolean;
}

export interface MemoryStorage {
  readonly behavior: MemoryStorageBehavior;
  readonly storage: StorageLike;
  readonly values: Map<string, string>;
}

export function createMemoryStorage(
  initialEntries: readonly (readonly [string, string])[] = [],
): MemoryStorage {
  const values = new Map<string, string>(initialEntries);
  const behavior: MemoryStorageBehavior = {
    dropNextSet: false,
    failNextSet: false,
    vanishNextSet: false,
  };
  const storage: StorageLike = {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (behavior.failNextSet) {
        behavior.failNextSet = false;
        throw new Error("storage write failed");
      }
      if (behavior.dropNextSet) {
        behavior.dropNextSet = false;
        return;
      }
      if (behavior.vanishNextSet) {
        behavior.vanishNextSet = false;
        values.delete(key);
        return;
      }
      values.set(key, value);
    },
  };
  return { behavior, storage, values };
}

export interface MemoryCookieJar {
  readonly read: () => string;
  readonly values: Map<string, string>;
  readonly write: (serializedCookie: string) => void;
  readonly writes: string[];
}

export function createMemoryCookieJar(): MemoryCookieJar {
  const values = new Map<string, string>();
  const writes: string[] = [];
  return {
    read: () =>
      [...values.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    values,
    write: (serializedCookie: string) => {
      writes.push(serializedCookie);
      const [pair = "", ...attributes] = serializedCookie.split("; ");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const maxAge = attributes.find((attribute) =>
        attribute.toLowerCase().startsWith("max-age="),
      );
      if (maxAge !== undefined && Number(maxAge.slice(8)) <= 0) {
        values.delete(name);
      } else {
        values.set(name, value);
      }
    },
    writes,
  };
}

export interface RecordedPortCall {
  readonly payload: unknown;
  readonly port: "broadcast" | "receipt" | "reconcile";
}

export interface HarnessControl {
  broadcastGate: Promise<void> | undefined;
  failBroadcastOnce: boolean;
  failReconcileOnce: boolean;
}

export interface ParityGpcObservation {
  readonly observedAtMs: number;
  readonly source: GpcSignalSource;
  readonly value: GpcSignalValue;
}

export interface ParityGpcInput {
  readonly navigationId: string;
  readonly observations: readonly ParityGpcObservation[];
}

export interface ParityHarnessOptions {
  readonly catalogueRevision?: string;
  readonly consentDurationMs?: number;
  readonly disclosure?: string;
  readonly editorialNote?: string;
  readonly gpc?: ParityGpcInput;
  readonly initialEntries?: readonly (readonly [string, string])[];
  readonly persistence?: "cookie" | "local-storage" | "unavailable";
  readonly policyVersion?: string;
  readonly purposeId?: string;
  readonly purposeLabel?: string;
  readonly resources?: readonly { id: string; serviceId: string }[];
}

export type ProductKind = "auto" | "generic";

export interface ParityHarness {
  readonly calls: RecordedPortCall[];
  readonly client: OpenCookie;
  readonly clock: TestClock;
  readonly control: HarnessControl;
  readonly cookieJar: MemoryCookieJar;
  readonly kind: ProductKind;
  readonly storage: MemoryStorage;
}

export const DEFAULT_PARITY_RESOURCES: readonly {
  id: string;
  serviceId: string;
}[] = Object.freeze([
  Object.freeze({ id: "analytics-script", serviceId: "analytics-service" }),
]);

export function createParityHarness(
  kind: ProductKind,
  options: ParityHarnessOptions = {},
): ParityHarness {
  const consentDurationMs = options.consentDurationMs ?? 60_000;
  const purposeId = options.purposeId ?? "analytics";
  const resources = options.resources ?? DEFAULT_PARITY_RESOURCES;
  const persistence = options.persistence ?? "local-storage";
  const clock = createTestClock();
  const storage = createMemoryStorage(options.initialEntries ?? []);
  const cookieJar = createMemoryCookieJar();
  const idGenerator = createSequentialIdGenerator();
  const calls: RecordedPortCall[] = [];
  const control: HarnessControl = {
    broadcastGate: undefined,
    failBroadcastOnce: false,
    failReconcileOnce: false,
  };
  const broadcast = async (payload: unknown): Promise<void> => {
    calls.push({ payload, port: "broadcast" });
    if (control.failBroadcastOnce) {
      control.failBroadcastOnce = false;
      throw new Error("broadcast port failed");
    }
    if (control.broadcastGate !== undefined) await control.broadcastGate;
  };
  const reconcile = (payload: unknown): Promise<void> => {
    calls.push({ payload, port: "reconcile" });
    if (control.failReconcileOnce) {
      control.failReconcileOnce = false;
      return Promise.reject(new Error("reconcile port failed"));
    }
    return Promise.resolve();
  };

  if (kind === "auto") {
    const factory = createAutoOpenCookieFactory({
      ...(options.catalogueRevision === undefined
        ? {}
        : { catalogueRevision: options.catalogueRevision }),
      consentDurationMs,
      ...(options.disclosure === undefined
        ? {}
        : { disclosure: options.disclosure }),
      ...(options.policyVersion === undefined
        ? {}
        : { policyVersion: options.policyVersion }),
      purposeId,
      ...(options.purposeLabel === undefined
        ? {}
        : { purposeLabel: options.purposeLabel }),
    });
    const client = factory.create({
      broadcast,
      ...(options.gpc === undefined ? {} : { gpc: options.gpc }),
      idGenerator,
      now: clock.now,
      persistence:
        persistence === "unavailable"
          ? { kind: "unavailable" }
          : persistence === "cookie"
            ? {
                hostname: "example.com",
                kind: "cookie",
                read: cookieJar.read,
                secure: true,
                write: cookieJar.write,
              }
            : { kind: "local-storage", storage: storage.storage },
      reconcile,
      resources,
    });
    return { calls, client, clock, control, cookieJar, kind, storage };
  }

  const policyResult = definePolicy(
    singlePurposeTestPolicy(
      purposeId,
      options.purposeLabel ?? "Analytics",
      options.disclosure ?? "Understand aggregate site usage.",
      consentDurationMs,
      options.editorialNote,
    ),
  );
  if (!policyResult.ok) {
    throw new Error("The generic parity policy definition is invalid.");
  }
  const resourceResult = defineResourcePolicy({
    policy: policyResult.policy,
    resources: resources.map((resource) => ({
      access: "optional",
      id: resource.id,
      purposeIds: [purposeId],
      serviceId: resource.serviceId,
    })),
    services: resources.map((resource) => ({ id: resource.serviceId })),
  });
  if (!resourceResult.ok) {
    throw new Error("The generic parity resource policy is invalid.");
  }
  const gpc = options.gpc;
  const privacyRestrictions =
    gpc === undefined
      ? undefined
      : resolveGpcRestrictions({
          resolution: resolveGpcSignal({
            navigationId: gpc.navigationId,
            observations: gpc.observations.map(
              (observation): GpcSignalObservation => ({
                navigationId: gpc.navigationId,
                observedAtMs: observation.observedAtMs,
                source: observation.source,
                value: observation.value,
              }),
            ),
          }),
          whenEnabled: { purposeIds: [purposeId] },
        });
  const store =
    persistence === "unavailable"
      ? createUnavailableDecisionStore()
      : persistence === "cookie"
        ? createCookieDecisionStore({
            hostname: "example.com",
            jar: { read: cookieJar.read, write: cookieJar.write },
            key: AUTO_TEST_COOKIE_KEY,
            maxAgeSeconds: Math.ceil(consentDurationMs / 1_000),
            schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
            scope: { kind: "host-only" },
            secure: true,
          })
        : createLocalStorageDecisionStore({
            key: AUTO_TEST_STORAGE_KEY,
            schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
            storage: storage.storage,
          });
  const client = createOpenCookie({
    broadcast,
    consentDurationMs,
    idGenerator,
    now: clock.now,
    policySnapshot: createPolicySnapshot({
      catalogueRevision: options.catalogueRevision ?? "catalogue-1",
      policy: policyResult.policy,
      policyVersion: options.policyVersion ?? "policy-1",
    }),
    ...(privacyRestrictions === undefined ? {} : { privacyRestrictions }),
    receipt: async (payload: unknown): Promise<void> => {
      calls.push({ payload, port: "receipt" });
      await Promise.resolve();
    },
    reconcile,
    resourcePolicy: resourceResult.resourcePolicy,
    store,
  });
  return { calls, client, clock, control, cookieJar, kind, storage };
}

export function comparablePortCalls(
  harness: ParityHarness,
): readonly RecordedPortCall[] {
  return harness.calls.filter((call) => call.port !== "receipt");
}

export function receiptPortCalls(
  harness: ParityHarness,
): readonly RecordedPortCall[] {
  return harness.calls.filter((call) => call.port === "receipt");
}

export function storageEntries(
  harness: ParityHarness,
): Readonly<Record<string, string>> {
  return Object.fromEntries(harness.storage.values);
}

export interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

export function deferred(): Deferred {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (release === undefined) throw new Error("Deferred resolver is missing.");
  return { promise, resolve: release };
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("The awaited harness condition was not reached.");
}

export interface ParityScenarioRun {
  readonly auto: { harness: ParityHarness; outcome: unknown };
  readonly generic: { harness: ParityHarness; outcome: unknown };
}

export async function runScenarioOnBoth(
  options: ParityHarnessOptions,
  scenario: (harness: ParityHarness) => Promise<unknown>,
): Promise<ParityScenarioRun> {
  const generic = createParityHarness("generic", options);
  const auto = createParityHarness("auto", options);
  const genericOutcome = await scenario(generic);
  const autoOutcome = await scenario(auto);
  return {
    auto: { harness: auto, outcome: autoOutcome },
    generic: { harness: generic, outcome: genericOutcome },
  };
}

/**
 * The auto product must match the generic product in observable outcome,
 * published snapshot, ordered non-receipt port effects, and durable storage
 * bytes. Receipt delivery is the only allowed difference.
 */
export function expectProductParity(run: ParityScenarioRun): void {
  expect(run.auto.outcome).toEqual(run.generic.outcome);
  expect(run.auto.harness.client.getSnapshot()).toEqual(
    run.generic.harness.client.getSnapshot(),
  );
  expect(comparablePortCalls(run.auto.harness)).toEqual(
    comparablePortCalls(run.generic.harness),
  );
  expect(storageEntries(run.auto.harness)).toEqual(
    storageEntries(run.generic.harness),
  );
  expect(receiptPortCalls(run.auto.harness)).toEqual([]);
}

export function seededDecisionBytes(
  decide: (client: OpenCookie) => Promise<unknown>,
  options: ParityHarnessOptions = {},
): Promise<Readonly<Record<string, string>>> {
  const harness = createParityHarness("generic", options);
  return harness.client
    .initialize()
    .then(() => decide(harness.client))
    .then(() => storageEntries(harness));
}

export function expectSnapshotShape(
  snapshot: OpenCookieSnapshot,
  shape: Record<string, unknown>,
): void {
  expect(snapshot).toMatchObject(shape);
}
