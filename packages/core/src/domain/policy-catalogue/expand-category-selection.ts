import {
  deepFreeze,
  type DefinedPolicy,
  normalizeIdentifier,
} from "./define-policy.js";
import { resolvePolicyGraph } from "../shared/policy-graph.js";

/** @public */
export function expandCategorySelection(
  policy: DefinedPolicy,
  selectedCategoryIds: readonly string[],
): readonly string[] {
  const purposeIds = new Set<string>();
  resolvePolicyGraph(
    policy.categories,
    selectedCategoryIds,
    (category) => {
      for (const purposeId of category.purposeIds) purposeIds.add(purposeId);
      return 0;
    },
    normalizeIdentifier,
  );

  return deepFreeze([...purposeIds].sort());
}
