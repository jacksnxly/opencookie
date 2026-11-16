import type { ConsentRuntimePolicyProjector } from "./consent-policy-reconciliation-contract.js";
import { createPolicyReconciler } from "../../reconciliation.js";

const reconciler = createPolicyReconciler();

/** Full identity-verifying projector injected by generic application facades. */
export const projectVerifiedConsentPolicy: ConsentRuntimePolicyProjector =
  reconciler.reconcile;
Object.freeze(projectVerifiedConsentPolicy);
