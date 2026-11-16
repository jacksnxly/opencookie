import {
  projectAccessConsent,
  projectAccessPolicy,
  projectConsentPolicy,
  projectConsentRuntimeStateWith,
  type ConsentRuntimeProjection,
  type ConsentRuntimeProjectionInput,
} from "./project-consent-runtime-kernel.js";
import { resolveEffectiveAccess } from "../../domain/terminal-enforcement/index.js";
import { snapshotConsentRuntimeProjectionInput } from "./snapshot-consent-runtime-projection-context.js";
import { projectVerifiedConsentPolicy } from "./verified-consent-runtime-projector.js";

export {
  projectAccessConsent,
  projectAccessPolicy,
  projectConsentPolicy,
  type ConsentRuntimeProjection,
  type ConsentRuntimeProjectionInput,
};

/**
 * Projects one generic runtime snapshot through canonical verified policy
 * reconciliation. Package-private products use the explicit projector kernel
 * instead of importing this full application facade.
 *
 * @public
 */
export function projectConsentRuntimeState(
  input: ConsentRuntimeProjectionInput,
): ConsentRuntimeProjection {
  return projectConsentRuntimeStateWith(
    snapshotConsentRuntimeProjectionInput(input),
    projectVerifiedConsentPolicy,
    resolveEffectiveAccess,
  );
}
