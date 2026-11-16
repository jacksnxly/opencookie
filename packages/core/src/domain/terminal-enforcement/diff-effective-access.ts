import { compareStrings } from "../shared/compare-strings.js";

import type {
  EffectiveAccessPlan,
  EffectiveResourceAccess,
} from "./resolve-effective-access.js";

/** @public */
export type EffectiveAccessLifecycle = "none" | "start" | "stop";

/** @public */
export interface DiffEffectiveAccessInput {
  readonly current: EffectiveAccessPlan;
  readonly previous: EffectiveAccessPlan;
}

/** @public */
export interface EffectiveAccessChange {
  readonly after: EffectiveResourceAccess;
  readonly before: EffectiveResourceAccess;
  readonly lifecycle: EffectiveAccessLifecycle;
  readonly resourceId: string;
}

/** @public */
export interface EffectiveAccessDiff {
  readonly changes: readonly EffectiveAccessChange[];
}

const NO_BLOCK_REASONS: readonly [] = Object.freeze([]);

function cloneResource(
  resource: EffectiveResourceAccess,
): EffectiveResourceAccess {
  return resource.access === "allowed"
    ? Object.freeze({
        access: "allowed",
        basis: resource.basis,
        blockReasons: NO_BLOCK_REASONS,
        resourceId: resource.resourceId,
        serviceId: resource.serviceId,
      })
    : Object.freeze({
        access: "blocked",
        blockReasons: Object.freeze([...resource.blockReasons]),
        resourceId: resource.resourceId,
        serviceId: resource.serviceId,
      });
}

function indexPlan(
  plan: EffectiveAccessPlan,
): ReadonlyMap<string, EffectiveResourceAccess> {
  const resources = new Map<string, EffectiveResourceAccess>();
  for (const resource of plan.resources) {
    if (resources.has(resource.resourceId)) {
      throw new RangeError(
        "Effective access plans must contain the same complete resource set without duplicates.",
      );
    }
    resources.set(resource.resourceId, resource);
  }
  return resources;
}

function assertSameResourceSet(
  current: ReadonlyMap<string, EffectiveResourceAccess>,
  previous: ReadonlyMap<string, EffectiveResourceAccess>,
): void {
  if (
    current.size !== previous.size ||
    [...previous.keys()].some((resourceId) => !current.has(resourceId))
  ) {
    throw new RangeError(
      "Effective access plans must contain the same complete resource set.",
    );
  }
}

function sameReasons(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reason, index) => reason === right[index])
  );
}

function sameResource(
  left: EffectiveResourceAccess,
  right: EffectiveResourceAccess,
): boolean {
  return (
    left.access === right.access &&
    left.resourceId === right.resourceId &&
    left.serviceId === right.serviceId &&
    sameReasons(left.blockReasons, right.blockReasons) &&
    (left.access !== "allowed" ||
      right.access !== "allowed" ||
      left.basis === right.basis)
  );
}

function lifecycleFor(
  before: EffectiveResourceAccess,
  after: EffectiveResourceAccess,
): EffectiveAccessLifecycle {
  if (before.access === "blocked" && after.access === "allowed") return "start";
  if (before.access === "allowed" && after.access === "blocked") return "stop";
  return "none";
}

/** @public */
export function diffEffectiveAccess(
  input: DiffEffectiveAccessInput,
): EffectiveAccessDiff {
  const current = indexPlan(input.current);
  const previous = indexPlan(input.previous);
  assertSameResourceSet(current, previous);

  const changes: EffectiveAccessChange[] = [];
  for (const resourceId of [...previous.keys()].sort(compareStrings)) {
    const before = previous.get(resourceId);
    const after = current.get(resourceId);
    if (!before || !after || sameResource(before, after)) continue;

    changes.push(
      Object.freeze({
        after: cloneResource(after),
        before: cloneResource(before),
        lifecycle: lifecycleFor(before, after),
        resourceId,
      }),
    );
  }

  return Object.freeze({ changes: Object.freeze(changes) });
}
