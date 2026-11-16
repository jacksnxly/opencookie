import type { EffectiveAccessPlan } from "../../domain/terminal-enforcement/index.js";

/** @public */
export type EnforcedAccess = "allowed" | "blocked";

/** @public */
export type DiscoveredResourceState =
  "active" | "blocked" | "dormant" | "partial";

/** @public */
export interface EnforcementOperationResult {
  readonly irreversibleEffects: readonly string[];
}

/** @public */
export interface AccessEnforcementController {
  readonly block: () => Promise<EnforcementOperationResult>;
  readonly cleanup: () => Promise<EnforcementOperationResult>;
  readonly discover: () => Promise<DiscoveredResourceState>;
  readonly start: () => Promise<EnforcementOperationResult>;
  readonly stop: () => Promise<void>;
}

/** @public */
export interface AccessEnforcementDecision {
  readonly access: EnforcedAccess;
  readonly resourceId: string;
}

/** @public */
export interface AccessEnforcementReconcilerOptions {
  readonly resources: Readonly<Record<string, AccessEnforcementController>>;
}

/** @public */
export type AccessEnforcementActionName =
  "blocked" | "cleaned" | "started" | "stopped";

/** @public */
export interface AccessEnforcementAction {
  readonly action: AccessEnforcementActionName;
  readonly resourceId: string;
}

/** @public */
export type AccessEnforcementOperation =
  "block" | "cleanup" | "discover" | "start" | "stop";

/** @public */
export interface AccessEnforcementFailure {
  readonly operation: AccessEnforcementOperation;
  readonly resourceId: string;
  readonly type: "operation-failed" | "unknown-resource";
}

/** @public */
export interface IrreversibleAccessEffect {
  readonly effect: string;
  readonly resourceId: string;
}

/** @public */
export interface AccessEnforcementResult {
  readonly actions: readonly AccessEnforcementAction[];
  readonly failures: readonly AccessEnforcementFailure[];
  readonly irreversibleEffects: readonly IrreversibleAccessEffect[];
  readonly status:
    | "applied"
    | "applied-with-irreversible-effects"
    | "partial-failure"
    | "unchanged";
}

/** @public */
export interface AccessEnforcementReconciler {
  readonly reconcile: (
    decisions: readonly AccessEnforcementDecision[],
  ) => Promise<AccessEnforcementResult>;
}

/** @public */
export function projectAccessEnforcementDecisions(
  plan: EffectiveAccessPlan,
): readonly AccessEnforcementDecision[] {
  return Object.freeze(
    plan.resources.map((resource) =>
      Object.freeze({
        access: resource.access === "allowed" ? "allowed" : "blocked",
        resourceId: resource.resourceId,
      }),
    ),
  );
}

interface ResourceProgress {
  actual?: DiscoveredResourceState;
  blockComplete?: boolean;
  cleanupComplete?: boolean;
  stopPending?: boolean;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateDecisions(
  decisions: readonly AccessEnforcementDecision[],
): readonly AccessEnforcementDecision[] {
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (!decision.resourceId.trim()) {
      throw new TypeError("Enforcement resource identifiers cannot be blank.");
    }
    if (seen.has(decision.resourceId)) {
      throw new TypeError(
        `Enforcement plan contains duplicate resource ${decision.resourceId}.`,
      );
    }
    seen.add(decision.resourceId);
  }
  return [...decisions].sort((left, right) =>
    compareStrings(left.resourceId, right.resourceId),
  );
}

/** @public */
export function createAccessEnforcementReconciler(
  options: AccessEnforcementReconcilerOptions,
): AccessEnforcementReconciler {
  const resources = Object.freeze({ ...options.resources });
  const configuredResourceIds = Object.keys(resources).sort(compareStrings);
  const progress = new Map<string, ResourceProgress>();
  let queue: Promise<void> = Promise.resolve();

  function completeDecisions(
    decisions: readonly AccessEnforcementDecision[],
  ): readonly AccessEnforcementDecision[] {
    const validated = validateDecisions(decisions);
    const suppliedResourceIds = new Set(
      validated.map(({ resourceId }) => resourceId),
    );
    const completed = [...validated];
    for (const resourceId of configuredResourceIds) {
      if (!suppliedResourceIds.has(resourceId)) {
        completed.push({ access: "blocked", resourceId });
      }
    }
    return completed.sort((left, right) =>
      compareStrings(left.resourceId, right.resourceId),
    );
  }

  async function apply(
    decisions: readonly AccessEnforcementDecision[],
  ): Promise<AccessEnforcementResult> {
    const actions: AccessEnforcementAction[] = [];
    const failures: AccessEnforcementFailure[] = [];
    const irreversibleEffects: IrreversibleAccessEffect[] = [];

    function recordEffects(
      resourceId: string,
      result: EnforcementOperationResult,
    ): void {
      for (const effect of result.irreversibleEffects) {
        irreversibleEffects.push({ effect, resourceId });
      }
    }

    for (const decision of completeDecisions(decisions)) {
      const resource = resources[decision.resourceId];
      if (resource === undefined) {
        failures.push({
          operation: "discover",
          resourceId: decision.resourceId,
          type: "unknown-resource",
        });
        continue;
      }

      const state = progress.get(decision.resourceId) ?? {};
      progress.set(decision.resourceId, state);
      try {
        state.actual = await resource.discover();
      } catch {
        failures.push({
          operation: "discover",
          resourceId: decision.resourceId,
          type: "operation-failed",
        });
        if (decision.access === "allowed") continue;
        state.actual = "partial";
      }

      if (decision.access === "allowed") {
        if (state.actual !== "active" || state.blockComplete) {
          try {
            recordEffects(decision.resourceId, await resource.start());
            actions.push({
              action: "started",
              resourceId: decision.resourceId,
            });
            state.actual = "active";
            state.blockComplete = false;
            state.cleanupComplete = false;
            state.stopPending = false;
          } catch {
            failures.push({
              operation: "start",
              resourceId: decision.resourceId,
              type: "operation-failed",
            });
            continue;
          }
        }
        continue;
      }

      const shouldStop =
        state.actual === "active" ||
        state.actual === "partial" ||
        state.stopPending;
      if (shouldStop && !state.stopPending) {
        state.blockComplete = false;
        state.cleanupComplete = false;
      } else if (state.actual === "blocked") {
        state.blockComplete ??= true;
      }

      if (shouldStop) {
        try {
          await resource.stop();
          actions.push({ action: "stopped", resourceId: decision.resourceId });
          state.actual = "dormant";
          state.stopPending = false;
        } catch {
          state.stopPending = true;
          failures.push({
            operation: "stop",
            resourceId: decision.resourceId,
            type: "operation-failed",
          });
        }
      }

      if (!state.blockComplete) {
        try {
          recordEffects(decision.resourceId, await resource.block());
          actions.push({ action: "blocked", resourceId: decision.resourceId });
          state.blockComplete = true;
        } catch {
          failures.push({
            operation: "block",
            resourceId: decision.resourceId,
            type: "operation-failed",
          });
          continue;
        }
      }

      if (!state.cleanupComplete) {
        try {
          recordEffects(decision.resourceId, await resource.cleanup());
          actions.push({ action: "cleaned", resourceId: decision.resourceId });
          state.cleanupComplete = true;
        } catch {
          failures.push({
            operation: "cleanup",
            resourceId: decision.resourceId,
            type: "operation-failed",
          });
          continue;
        }
      }
      if (state.actual !== "active") {
        state.actual = "blocked";
      }
    }

    const status: AccessEnforcementResult["status"] =
      failures.length > 0
        ? "partial-failure"
        : irreversibleEffects.length > 0
          ? "applied-with-irreversible-effects"
          : actions.length > 0
            ? "applied"
            : "unchanged";
    return Object.freeze({
      actions: Object.freeze(actions),
      failures: Object.freeze(failures),
      irreversibleEffects: Object.freeze(irreversibleEffects),
      status,
    });
  }

  return Object.freeze({
    reconcile(
      decisions: readonly AccessEnforcementDecision[],
    ): Promise<AccessEnforcementResult> {
      const next = queue.then(() => apply(decisions));
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  });
}
