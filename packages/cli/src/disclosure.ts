import type { PolicySnapshot } from "@opencookie-dev/core/domain";

/** Plain-language content for one catalogue identifier. @public */
export interface PolicyTerm {
  readonly description?: string;
  readonly label: string;
}

/** Plain-language terms, keyed by catalogue identifier. @public */
export type PolicyTerms = Readonly<Record<string, PolicyTerm>>;

/**
 * The policy references identifiers that have no plain-language term.
 *
 * Publishing anyway would show a visitor a bare identifier such as
 * `usage-data`, which is the vague disclosure PP-16 describes.
 *
 * @public
 */
export interface UndisclosedReferenceIssue {
  readonly kind: "undisclosed-reference";
  readonly referenceIds: readonly string[];
}

/** A term was present but its label was empty. @public */
export interface BlankTermLabelIssue {
  readonly kind: "blank-term-label";
  readonly referenceId: string;
}

/** A term describes an identifier the policy never references. @public */
export interface UnreferencedTermIssue {
  readonly kind: "unreferenced-term";
  readonly referenceId: string;
}

/**
 * A term names a category. A category's heading is its label in the policy,
 * which a visitor sees in every language the policy carries.
 *
 * @public
 */
export interface CategoryTermIssue {
  readonly kind: "category-term";
  readonly referenceId: string;
}

/** @public */
export type DisclosureIssue =
  | BlankTermLabelIssue
  | CategoryTermIssue
  | UndisclosedReferenceIssue
  | UnreferencedTermIssue;

/** @public */
export type DisclosureResult =
  | { readonly issue: DisclosureIssue; readonly ok: false }
  | { readonly ok: true; readonly terms: PolicyTerms };

/** Every identifier a reader of the declaration could be shown. */
function referencedIdentifiers(snapshot: PolicySnapshot): Set<string> {
  const referenced = new Set<string>();
  for (const purpose of snapshot.policy.purposes) {
    referenced.add(purpose.id);
    for (const id of [
      ...purpose.dataCategoryIds,
      ...purpose.operationIds,
      ...purpose.providerIds,
      ...purpose.recipientIds,
      ...purpose.retentionIds,
    ]) {
      referenced.add(id);
    }
  }
  return referenced;
}

/**
 * Requires plain language for every identifier a declaration would show.
 *
 * A catalogue identifier is written for the operator, not the visitor. Button
 * parity does not fix a disclosure that reads `usage-data`, so a declaration is
 * refused until every referenced identifier has a term, and the refusal names
 * the identifiers that are missing rather than reporting a generic failure.
 *
 * Terms are presentation only. They are held beside the policy, never inside
 * it, so wording can be corrected without altering the enforced decision
 * surface or the catalogue identity.
 *
 * @public
 */
export function declarePolicyTerms(
  snapshot: PolicySnapshot,
  declared: PolicyTerms,
): DisclosureResult {
  const referenced = referencedIdentifiers(snapshot);
  for (const [referenceId, term] of Object.entries(declared)) {
    if (!referenced.has(referenceId)) {
      const kind = snapshot.policy.categories.some(
        (category) => category.id === referenceId,
      )
        ? "category-term"
        : "unreferenced-term";
      return { issue: { kind, referenceId }, ok: false };
    }
    if (term.label.trim() === "") {
      return { issue: { kind: "blank-term-label", referenceId }, ok: false };
    }
  }
  const missing = [...referenced]
    .filter((referenceId) => declared[referenceId] === undefined)
    .sort();
  if (missing.length > 0) {
    return {
      issue: { kind: "undisclosed-reference", referenceIds: missing },
      ok: false,
    };
  }
  return { ok: true, terms: { ...declared } };
}

/** One disclosed catalogue entry as a visitor reads it. @public */
export interface DisclosedReference {
  readonly description?: string;
  readonly id: string;
  readonly label: string;
}

/** Resolves identifiers to the terms an operator declared. */
export function disclose(
  ids: readonly string[],
  terms: PolicyTerms | undefined,
): readonly DisclosedReference[] {
  return ids.flatMap((id) => {
    const term = terms?.[id];
    if (term === undefined) return [];
    return [
      {
        ...(term.description === undefined
          ? {}
          : { description: term.description }),
        id,
        label: term.label,
      },
    ];
  });
}
