import type {
  ConsentDomainEvent,
  ConsentRecord,
} from "../../domain/consent-decisioning/index.js";
import type { DecisionStore } from "../persistence/persist-grant.js";
import type { PersistedDecisionRecord } from "./persisted-consent-record.js";
import type { ConsentRuntimeProjection } from "./project-consent-runtime-kernel.js";

export interface CapturedConsentRuntimeTransitionEffect {
  readonly events: readonly ConsentDomainEvent[];
  readonly persistenceStatus:
    "confirmed" | "failed" | "failed-conservative" | "pending";
  readonly record: ConsentRecord;
  readonly runtime: ConsentRuntimeProjection;
  readonly transitionId: string;
}

/** Receipt-neutral aftercare payload delivered after a terminal transition. */
export interface ConsentRuntimeAftercareInput {
  readonly occurredAt: number;
  readonly persistenceStatus: "confirmed" | "failed" | "failed-conservative";
  readonly record: PersistedDecisionRecord;
  readonly transitionId: string;
}

export interface CapturedConsentRuntimeKernelPorts {
  readonly aftercare: (input: ConsentRuntimeAftercareInput) => Promise<void>;
  readonly broadcast: (
    effect: CapturedConsentRuntimeTransitionEffect,
  ) => Promise<void>;
  readonly commit: (effect: CapturedConsentRuntimeTransitionEffect) => void;
  readonly notify: (effect: CapturedConsentRuntimeTransitionEffect) => void;
  readonly reconcile: (
    effect: CapturedConsentRuntimeTransitionEffect,
  ) => Promise<void>;
  readonly store: DecisionStore;
}

function invalidPorts(): never {
  throw new TypeError("Invalid consent runtime ports.");
}

function inputObject(value: unknown): object {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidPorts();
    }
    return value;
  } catch {
    return invalidPorts();
  }
}

function ownValue(source: object, field: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor === undefined || !("value" in descriptor)) {
      return invalidPorts();
    }
    return descriptor.value;
  } catch {
    return invalidPorts();
  }
}

function capturedPort(
  source: object,
  field: string,
): (...args: never[]) => unknown {
  const value = ownValue(source, field);
  if (typeof value !== "function") return invalidPorts();
  return (...args: never[]): unknown =>
    Reflect.apply(value, source, args) as unknown;
}

function capturedPorts(
  source: object,
  fields: readonly string[],
): Record<string, (...args: never[]) => unknown> {
  return Object.fromEntries(
    fields.map((field) => [field, capturedPort(source, field)]),
  );
}

/** Captures one store plus the named callback fields through own data descriptors. */
export function snapshotConsentRuntimePortRecord(
  candidate: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const ports = inputObject(candidate);
  const store = inputObject(ownValue(ports, "store"));
  const capturedStore = capturedPorts(store, [
    "clear",
    "clearIfCurrent",
    "compareAndSet",
    "read",
  ]) as unknown as DecisionStore;
  return Object.freeze({
    ...capturedPorts(ports, fields),
    store: Object.freeze(capturedStore),
  });
}

export function snapshotConsentRuntimeKernelPorts(
  candidate: unknown,
): CapturedConsentRuntimeKernelPorts {
  return snapshotConsentRuntimePortRecord(candidate, [
    "aftercare",
    "broadcast",
    "commit",
    "notify",
    "reconcile",
  ]) as unknown as CapturedConsentRuntimeKernelPorts;
}
