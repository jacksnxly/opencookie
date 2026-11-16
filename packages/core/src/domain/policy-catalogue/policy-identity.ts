import {
  definePolicy,
  type DefinedPolicy,
  type PolicyDefinition,
} from "./define-policy.js";
import {
  canonicalPolicyRepresentations,
  snapshotDefinedPolicy,
  type PolicyCanonicalRepresentations,
} from "./policy-primitives.js";

export { isSupportedPolicyIdentity } from "./supported-policy-identity.js";

export type { PolicyCanonicalRepresentations } from "./policy-primitives.js";

/** @public */
export interface PolicySnapshotDefinition {
  readonly catalogueRevision: string;
  readonly policy: DefinedPolicy;
  readonly policyVersion: string;
}

/** @public */
export interface PolicySnapshot {
  readonly catalogueDigest: string;
  readonly catalogueRevision: string;
  readonly decisionSurfaceDigest: string;
  readonly policy: DefinedPolicy;
  readonly policyVersion: string;
}

function requireDefinedPolicy(policy: DefinedPolicy): DefinedPolicy {
  const validation = definePolicy(policy as unknown as PolicyDefinition);
  if (!validation.ok) throw new TypeError("Invalid defined policy.");
  return validation.policy;
}

/** @public */
export function canonicalizePolicy(
  policy: DefinedPolicy,
): PolicyCanonicalRepresentations {
  return canonicalPolicyRepresentations(requireDefinedPolicy(policy));
}

/** @public */
export function createPolicySnapshot(
  definition: PolicySnapshotDefinition,
): PolicySnapshot {
  return snapshotDefinedPolicy({
    ...definition,
    policy: requireDefinedPolicy(definition.policy),
  });
}
