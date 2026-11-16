import { sha256Hex } from "./sha256.js";

const POLICY_IDENTITY_PREFIX = "sha256-v1:";

export const INVISIBLE_DISCLOSURE = /^[\s\x85\u2800\uFFFC\p{Cf}\p{DI}]*$/u;

const INVALID_IDENTIFIER =
  /[\u2028-\u2029\u2800\uFFFC\p{Cc}\p{Cs}\p{Cf}\p{DI}]/u;

/** Canonicalizes a policy identifier or returns an empty string when it is invalid. @public */
export function normalizeIdentifier(value: unknown): string {
  return typeof value === "string" &&
    !INVALID_IDENTIFIER.test(value) &&
    !INVALID_IDENTIFIER.test(
      (value = value.normalize("NFKC").toLowerCase().normalize("NFKC")),
    )
    ? (value as string).trim()
    : "";
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

/** @public */
export interface PolicyCanonicalRepresentations {
  readonly catalogue: string;
  readonly decisionSurface: string;
}

interface CanonicalPolicy {
  readonly purposes: readonly {
    readonly editorialNote?: string;
  }[];
}

interface TrustedPolicySnapshotDefinition<TPolicy extends CanonicalPolicy> {
  readonly catalogueRevision: string;
  readonly policy: TPolicy;
  readonly policyVersion: string;
}

interface TrustedPolicySnapshot<TPolicy extends CanonicalPolicy> {
  readonly catalogueDigest: string;
  readonly catalogueRevision: string;
  readonly decisionSurfaceDigest: string;
  readonly policy: TPolicy;
  readonly policyVersion: string;
}

function policyIdentity(
  kind: "catalogue" | "decision-surface",
  canonical: string,
): string {
  return `${POLICY_IDENTITY_PREFIX}${sha256Hex(
    `opencookie-policy-identity-v1\u0000${kind}\u0000${canonical}`,
  )}`;
}

export function canonicalPolicyRepresentations(
  canonical: CanonicalPolicy,
): PolicyCanonicalRepresentations {
  return deepFreeze({
    // Every identifier list is hashed sorted. Most are stored sorted already;
    // the order of categories and their purposes is the operator's, shown to
    // visitors, and reordering them re-asks nobody.
    catalogue: JSON.stringify(canonical, (key, value: unknown) =>
      key.endsWith("Ids") ? [...(value as string[])].sort() : value,
    ),
    decisionSurface: JSON.stringify({
      purposes: canonical.purposes.map((purpose) => {
        // The editorial note is deliberately excluded from decision identity.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { editorialNote: _, ...decision } = purpose;
        return decision;
      }),
    }),
  });
}

/**
 * Derives identity for a policy already validated by an internal invariant
 * boundary. Public callers must validate through `definePolicy` first.
 */
export function snapshotDefinedPolicy<TPolicy extends CanonicalPolicy>(
  definition: TrustedPolicySnapshotDefinition<TPolicy>,
): TrustedPolicySnapshot<TPolicy> {
  const canonical = canonicalPolicyRepresentations(definition.policy);
  return deepFreeze({
    catalogueDigest: policyIdentity("catalogue", canonical.catalogue),
    catalogueRevision: definition.catalogueRevision,
    decisionSurfaceDigest: policyIdentity(
      "decision-surface",
      canonical.decisionSurface,
    ),
    policy: definition.policy,
    policyVersion: definition.policyVersion,
  });
}
