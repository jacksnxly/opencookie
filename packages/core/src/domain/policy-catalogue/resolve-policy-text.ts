import type { DefinedPolicy } from "./define-policy.js";
import { deepFreeze } from "./policy-primitives.js";

/** The text a policy shows in one language. @public */
export interface PolicyText {
  /** A category without a label has none here either; show its id. */
  readonly categories: readonly {
    readonly id: string;
    readonly label?: string;
  }[];
  readonly purposes: readonly {
    readonly disclosure: string;
    readonly id: string;
    readonly label: string;
  }[];
}

function translationFor<Translation extends { readonly locale: string }>(
  translations: readonly Translation[] | undefined,
  locale: string,
): Translation | undefined {
  const wanted = locale.toLowerCase();
  const primary = wanted.split("-")[0];
  return (
    translations?.find((entry) => entry.locale.toLowerCase() === wanted) ??
    translations?.find((entry) => entry.locale.toLowerCase() === primary)
  );
}

/**
 * The text to show for a policy in a page's language: each purpose's label
 * and disclosure, and each category's label, from the translation whose
 * locale matches ignoring case, else the one for its primary language, else
 * the policy's own text. The policy and its identity are unchanged; only what
 * is shown differs.
 *
 * @public
 */
export function resolvePolicyText(
  policy: DefinedPolicy,
  locale: string,
): PolicyText {
  return deepFreeze({
    categories: policy.categories.map((category) => {
      const label =
        translationFor(category.translations, locale)?.label ?? category.label;
      return label === undefined
        ? { id: category.id }
        : { id: category.id, label };
    }),
    purposes: policy.purposes.map((purpose) => {
      const translation = translationFor(purpose.translations, locale);
      return {
        disclosure: translation?.disclosure ?? purpose.disclosure,
        id: purpose.id,
        label: translation?.label ?? purpose.label,
      };
    }),
  });
}
