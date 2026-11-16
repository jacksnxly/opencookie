import { deepFreeze, type DefinedPolicy } from "./define-policy.js";
import { resolvePolicyGraph } from "../shared/policy-graph.js";

/** @public */
export type PurposeDecisionInput = Readonly<
  Record<string, "denied" | "granted">
>;

/** Completes or prunes a purpose selection in one dependency-DAG pass. @public */
export function resolvePurposeSelection(
  policy: DefinedPolicy,
  purposeIds: readonly string[],
  mode: "complete" | "supported",
): readonly string[] {
  const selected = new Set(purposeIds);
  const resolved = resolvePolicyGraph(policy.purposes, selected, (purpose) =>
    mode === "complete" || selected.has(purpose.id) ? 0 : 1,
  );
  return deepFreeze(
    [...resolved].flatMap(([id, state]) => (state === 0 ? id : [])),
  );
}

/** @public */
export function resolvePurposeDependencies(
  policy: DefinedPolicy,
  decisions: PurposeDecisionInput,
): readonly string[] {
  return resolvePurposeSelection(
    policy,
    Object.entries(decisions).flatMap(([purposeId, decision]) =>
      decision === "granted" ? [purposeId] : [],
    ),
    "complete",
  );
}
