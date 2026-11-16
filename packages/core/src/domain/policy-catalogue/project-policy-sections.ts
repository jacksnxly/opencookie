import { deepFreeze, type DefinedPolicy } from "./define-policy.js";
import { resolvePolicyGraph } from "../shared/policy-graph.js";

/** One deterministic purpose group for presentation adapters. @public */
export interface PolicySection {
  readonly categoryId: string | null;
  readonly purposeIds: readonly string[];
}

/**
 * Projects the policy category DAG into immutable, single-owner purpose
 * sections. Presentation roots and category links are already normalized by
 * `definePolicy`; walking them here keeps diamond ownership in the domain.
 *
 * @public
 */
export function projectPolicySections(
  policy: DefinedPolicy,
): readonly PolicySection[] {
  const rootIds = policy.presentationRootCategoryIds;
  const claimedPurposeIds = new Set<string>();
  const sections: PolicySection[] = [];
  resolvePolicyGraph(policy.categories, rootIds, (category) => {
    const purposeIds = category.purposeIds.filter((purposeId) => {
      if (claimedPurposeIds.has(purposeId)) return false;
      claimedPurposeIds.add(purposeId);
      return true;
    });
    if (purposeIds.length) {
      sections.push({ categoryId: category.id, purposeIds });
    }
    return 0;
  });

  const ungroupedPurposeIds = policy.purposes
    .map(({ id }) => id)
    .filter((purposeId) => !claimedPurposeIds.has(purposeId));
  if (ungroupedPurposeIds.length || !rootIds.length) {
    sections.push({ categoryId: null, purposeIds: ungroupedPurposeIds });
  }

  return deepFreeze(sections);
}
