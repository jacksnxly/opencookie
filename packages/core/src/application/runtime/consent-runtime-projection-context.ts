import type {
  DefinedResourcePolicy,
  PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import type { ProcessingRestrictionSet } from "../../domain/privacy-preference-resolution/index.js";
import type {
  EffectiveAccessPlan,
  ResolveEffectiveAccessInput,
  ServicePreferenceRecord,
} from "../../domain/terminal-enforcement/index.js";
import type { ConsentRuntimePolicyProjector } from "./consent-policy-reconciliation-contract.js";

/** Internal immutable inputs shared by runtime projection call sites. */
export interface ConsentRuntimeProjectionContext {
  readonly policyHistory: readonly PolicySnapshot[];
  readonly policySnapshot: PolicySnapshot;
  readonly privacyRestrictions?: ProcessingRestrictionSet;
  readonly projectPolicy: ConsentRuntimePolicyProjector;
  /** The product's access rule; the compact auto product leaves out any-of. */
  readonly resolveAccess: (
    input: ResolveEffectiveAccessInput,
  ) => EffectiveAccessPlan;
  readonly resourcePolicy: DefinedResourcePolicy;
  readonly servicePreferences?: ServicePreferenceRecord;
}
