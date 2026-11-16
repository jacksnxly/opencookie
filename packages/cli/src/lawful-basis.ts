import type { PolicySnapshot } from "@opencookie-dev/core/domain";

/**
 * A purpose was given a lawful basis that the published policy does not define.
 *
 * @public
 */
export interface UnknownPurposeBasisIssue {
  readonly kind: "unknown-purpose-basis";
  readonly purposeId: string;
}

/** A lawful basis was present but empty. @public */
export interface BlankLawfulBasisIssue {
  readonly kind: "blank-lawful-basis";
  readonly purposeId: string;
}

/** @public */
export type LawfulBasisIssue = BlankLawfulBasisIssue | UnknownPurposeBasisIssue;

/** Operator-declared lawful bases, keyed by purpose identifier. @public */
export type PolicyLawfulBases = Readonly<Record<string, string>>;

/** @public */
export type LawfulBasisResult =
  | { readonly issue: LawfulBasisIssue; readonly ok: false }
  | { readonly lawfulBases: PolicyLawfulBases; readonly ok: true };

/**
 * Validates operator-declared lawful bases against a published policy.
 *
 * A lawful basis is metadata an operator asserts and publishes. OpenCookie
 * records it, checks that it refers to a purpose that exists, and refuses an
 * empty one rather than storing a legal claim with no content. It never derives
 * a basis, defaults one, or treats one as a reason to skip a consent decision:
 * the basis is deliberately kept outside the policy the runtime enforces, so it
 * cannot alter the decision surface.
 *
 * @public
 */
export function definePolicyLawfulBases(
  snapshot: PolicySnapshot,
  declared: PolicyLawfulBases,
): LawfulBasisResult {
  const known = new Set(snapshot.policy.purposes.map(({ id }) => id));
  for (const [purposeId, basis] of Object.entries(declared)) {
    if (!known.has(purposeId)) {
      return { issue: { kind: "unknown-purpose-basis", purposeId }, ok: false };
    }
    if (basis.trim() === "") {
      return { issue: { kind: "blank-lawful-basis", purposeId }, ok: false };
    }
  }
  return { lawfulBases: { ...declared }, ok: true };
}
