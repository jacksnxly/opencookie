import {
  projectPolicySections,
  resolveCategorySelectionStates,
  type DefinedPolicy,
} from "@opencookie-dev/core/domain";

import type { VanillaPolicyPresentationSection } from "./mount.js";

/** Joins domain-owned sections and category selection states. @internal */
export function projectPolicyPresentation(
  policy: DefinedPolicy,
  selectedPurposeIds: ReadonlySet<string>,
): readonly VanillaPolicyPresentationSection[] {
  const states = new Map(
    resolveCategorySelectionStates(policy, selectedPurposeIds).map((state) => [
      state.categoryId,
      state,
    ]),
  );
  return Object.freeze(
    projectPolicySections(policy).map((section) =>
      Object.freeze({
        checked: false,
        indeterminate: false,
        ...states.get(section.categoryId ?? ""),
        ...section,
      }),
    ),
  );
}
