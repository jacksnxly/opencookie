import { deepFreeze, type DefinedPolicy } from "./define-policy.js";
import { resolvePolicyGraph } from "../shared/policy-graph.js";

/** One category checkbox state derived from purpose decisions. @public */
export interface CategorySelectionState {
  readonly categoryId: string;
  readonly checked: boolean;
  readonly indeterminate: boolean;
}

/** Resolves every category checkbox in one memoized policy-DAG pass. @public */
export function resolveCategorySelectionStates(
  policy: DefinedPolicy,
  selectedPurposeIds: ReadonlySet<string>,
): readonly CategorySelectionState[] {
  const states = resolvePolicyGraph(
    policy.categories,
    policy.categories.map(({ id }) => id),
    (category) =>
      category.purposeIds.reduce(
        (state, purposeId) =>
          state | (selectedPurposeIds.has(purposeId) ? 1 : 2),
        0,
      ),
  ) as ReadonlyMap<string, number>;

  return deepFreeze(
    [...states].map(([categoryId, state]) => ({
      categoryId,
      checked: state < 2,
      indeterminate: state === 3,
    })),
  );
}
