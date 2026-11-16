import { compareStrings } from "../shared/compare-strings.js";
import type { ProcessingRestrictionSet } from "../shared/processing-restriction.js";

import type { GpcSignalResolution } from "./resolve-gpc-signal.js";

/** @public */
export interface GpcRestrictionMapping {
  readonly purposeIds?: readonly string[];
  readonly resourceIds?: readonly string[];
  readonly serviceIds?: readonly string[];
}

/** @public */
export interface ResolveGpcRestrictionsInput {
  readonly resolution: GpcSignalResolution;
  readonly whenEnabled: GpcRestrictionMapping;
}

function stableUnique(
  values: readonly string[] | undefined,
): readonly string[] {
  return Object.freeze([...new Set(values ?? [])].sort(compareStrings));
}

/** @public */
export function resolveGpcRestrictions(
  input: ResolveGpcRestrictionsInput,
): ProcessingRestrictionSet {
  const mapping =
    input.resolution.effectiveValue === "enabled" ? input.whenEnabled : {};

  return Object.freeze({
    purposeIds: stableUnique(mapping.purposeIds),
    resourceIds: stableUnique(mapping.resourceIds),
    serviceIds: stableUnique(mapping.serviceIds),
    source: "gpc",
  });
}
