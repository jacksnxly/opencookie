import type { ConsentReceipt } from "../../domain/consent-evidence/index.js";
import type { DecisionStore } from "../persistence/persist-grant.js";
import { adaptConsentRuntimeDecisionPorts } from "./consent-runtime-receipt-aftercare.js";
import {
  executeConsentRuntimeDecisionKernel,
  type ConsentRuntimeDecisionCommand,
  type ConsentRuntimeDecisionResult,
  type ConsentRuntimeTransitionEffect,
} from "./execute-consent-runtime-decision-kernel.js";
import { projectVerifiedConsentPolicy } from "./verified-consent-runtime-projector.js";
import { resolveEffectiveAccess } from "../../domain/terminal-enforcement/index.js";
import { snapshotConsentRuntimeProjectionContext } from "./snapshot-consent-runtime-projection-context.js";

export type {
  ConsentRuntimeDecisionCommand,
  ConsentRuntimeDecisionDiagnostic,
  ConsentRuntimeDecisionResult,
  ConsentRuntimeTransition,
  ConsentRuntimeTransitionEffect,
  DenialReceiptDiagnostic,
  PendingGrantRuntimeTransition,
} from "./execute-consent-runtime-decision-kernel.js";

/** @public */
export interface ConsentRuntimeDecisionPorts {
  readonly broadcast: (effect: ConsentRuntimeTransitionEffect) => Promise<void>;
  readonly commit: (effect: ConsentRuntimeTransitionEffect) => void;
  readonly notify: (effect: ConsentRuntimeTransitionEffect) => void;
  readonly receipt: (receipt: ConsentReceipt) => Promise<void>;
  readonly reconcile: (effect: ConsentRuntimeTransitionEffect) => Promise<void>;
  readonly store: DecisionStore;
}

/**
 * Executes one explicit visitor decision through persistence and every derived
 * runtime projection. Adapters receive complete immutable effects rather than
 * reconstructing access or signal state themselves.
 *
 * @public
 */
export async function executeConsentRuntimeDecision(
  ports: ConsentRuntimeDecisionPorts,
  command: ConsentRuntimeDecisionCommand,
): Promise<ConsentRuntimeDecisionResult> {
  // The hostile ports are captured inside the closure so rejected and
  // unchanged commands keep returning before any port field is observed.
  return executeConsentRuntimeDecisionKernel(
    () => adaptConsentRuntimeDecisionPorts(ports),
    command,
    snapshotConsentRuntimeProjectionContext(
      command,
      projectVerifiedConsentPolicy,
      resolveEffectiveAccess,
    ),
  );
}
