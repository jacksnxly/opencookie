import { compareStrings } from "../shared/compare-strings.js";
import { captureDataArray } from "../shared/capture-data-property.js";
import { checkedSafeInteger } from "../shared/checked-safe-integer.js";

/** @public */
export type GpcSignalSource = "browser" | "server";

/** @public */
export type GpcSignalValue = "absent" | "disabled" | "enabled";

/** @public */
export interface GpcSignalObservation {
  readonly navigationId: string;
  readonly observedAtMs: number;
  readonly source: GpcSignalSource;
  readonly value: GpcSignalValue;
}

/** @public */
export interface ResolveGpcSignalInput {
  readonly navigationId: string;
  readonly observations: readonly GpcSignalObservation[];
}

/** @public */
export interface PrivacySignalConflictDetectedEvent {
  readonly navigationId: string;
  readonly observations: readonly GpcSignalObservation[];
  readonly signal: "gpc";
  readonly type: "privacy-signal-conflict-detected";
}

/** @public */
export interface GpcSignalResolution {
  readonly conflict: PrivacySignalConflictDetectedEvent | null;
  readonly effectiveValue: GpcSignalValue;
  readonly navigationId: string;
  readonly observations: readonly GpcSignalObservation[];
}

const SOURCE_ORDER: Readonly<Record<GpcSignalSource, number>> = Object.freeze({
  server: 0,
  browser: 1,
});

const VALUE_PRECEDENCE: Readonly<Record<GpcSignalValue, number>> =
  Object.freeze({
    absent: 0,
    disabled: 1,
    enabled: 2,
  });

function compareObservations(
  left: GpcSignalObservation,
  right: GpcSignalObservation,
): number {
  return (
    SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] ||
    left.observedAtMs - right.observedAtMs ||
    compareStrings(left.value, right.value)
  );
}

function freezeObservation(
  observation: GpcSignalObservation,
): GpcSignalObservation {
  const { navigationId, observedAtMs, source, value } = observation;
  checkedSafeInteger(observedAtMs, "observedAtMs");
  return Object.freeze({ navigationId, observedAtMs, source, value });
}

/** @public */
export function resolveGpcSignal(
  input: ResolveGpcSignalInput,
): GpcSignalResolution {
  const navigationId = input.navigationId;
  const observations = Object.freeze(
    // Invalid capture stays undefined at runtime, so this first array operation
    // throws before any observation field can be read.
    (
      captureDataArray<GpcSignalObservation>(
        input.observations,
      ) as GpcSignalObservation[]
    )
      .map(freezeObservation)
      .filter((observation) => observation.navigationId === navigationId)
      .sort(compareObservations),
  );

  const effectiveValue = observations.reduce<GpcSignalValue>(
    (current, observation) =>
      VALUE_PRECEDENCE[observation.value] > VALUE_PRECEDENCE[current]
        ? observation.value
        : current,
    "absent",
  );
  const hasConflict =
    new Set(observations.map((observation) => observation.value)).size > 1;
  const conflict = hasConflict
    ? Object.freeze({
        navigationId,
        observations,
        signal: "gpc" as const,
        type: "privacy-signal-conflict-detected" as const,
      })
    : null;

  return Object.freeze({
    conflict,
    effectiveValue,
    navigationId,
    observations,
  });
}
