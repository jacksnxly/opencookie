import { adaptConsentRuntimeDecisionPorts } from "./consent-runtime-receipt-aftercare.js";
import type { ConsentRuntimeDecisionPorts } from "./execute-consent-runtime-decision.js";
import {
  executeConsentRuntimeWithdrawalKernel,
  type ConsentRuntimeWithdrawalCommand,
  type ConsentRuntimeWithdrawalResult,
} from "./execute-consent-runtime-withdrawal-kernel.js";
import { projectVerifiedConsentPolicy } from "./verified-consent-runtime-projector.js";
import { resolveEffectiveAccess } from "../../domain/terminal-enforcement/index.js";
import { snapshotConsentRuntimeProjectionContext } from "./snapshot-consent-runtime-projection-context.js";

export type {
  ConsentRuntimeWithdrawalCommand,
  ConsentRuntimeWithdrawalResult,
} from "./execute-consent-runtime-withdrawal-kernel.js";

/**
 * Withdraws an existing consent record through the conservative denial path.
 * A withdrawal never claims that already-executed third-party effects were
 * reversed; enforcement adapters report those effects independently.
 *
 * @public
 */
export async function executeConsentRuntimeWithdrawal(
  ports: ConsentRuntimeDecisionPorts,
  command: ConsentRuntimeWithdrawalCommand,
): Promise<ConsentRuntimeWithdrawalResult> {
  // The hostile ports are captured inside the closure so rejected and
  // unchanged commands keep returning before any port field is observed.
  return executeConsentRuntimeWithdrawalKernel(
    () => adaptConsentRuntimeDecisionPorts(ports),
    command,
    snapshotConsentRuntimeProjectionContext(
      command,
      projectVerifiedConsentPolicy,
      resolveEffectiveAccess,
    ),
  );
}
