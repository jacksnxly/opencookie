import {
  projectConsentReceipt,
  type ConsentReceipt,
} from "../../domain/consent-evidence/index.js";
import type { DecisionStore } from "../persistence/persist-grant.js";
import type {
  ConsentRuntimeAftercareHook,
  OpenCookiePortContext,
} from "./open-cookie-kernel-contract.js";
import {
  snapshotConsentRuntimePortRecord,
  type CapturedConsentRuntimeKernelPorts,
  type CapturedConsentRuntimeTransitionEffect,
} from "./snapshot-consent-runtime-inputs.js";

export interface CapturedConsentRuntimeDecisionPorts {
  readonly broadcast: (
    effect: CapturedConsentRuntimeTransitionEffect,
  ) => Promise<void>;
  readonly commit: (effect: CapturedConsentRuntimeTransitionEffect) => void;
  readonly notify: (effect: CapturedConsentRuntimeTransitionEffect) => void;
  readonly receipt: (receipt: ConsentReceipt) => Promise<void>;
  readonly reconcile: (
    effect: CapturedConsentRuntimeTransitionEffect,
  ) => Promise<void>;
  readonly store: DecisionStore;
}

export function snapshotConsentRuntimePorts(
  candidate: unknown,
): CapturedConsentRuntimeDecisionPorts {
  return snapshotConsentRuntimePortRecord(candidate, [
    "broadcast",
    "commit",
    "notify",
    "receipt",
    "reconcile",
  ]) as unknown as CapturedConsentRuntimeDecisionPorts;
}

/**
 * Adapts a consent-receipt sink into the receipt-neutral aftercare hook the
 * kernels invoke. The receipt is projected from the aftercare payload at the
 * exact position the receipt port used to run, so projection failures keep
 * surfacing as the same receipt diagnostics.
 */
export function consentReceiptAftercare(
  receipt: (
    receipt: ConsentReceipt,
    context?: OpenCookiePortContext,
  ) => Promise<void>,
): ConsentRuntimeAftercareHook {
  return (input, context) => {
    const projected = projectConsentReceipt({
      ...input.record,
      occurredAt: input.occurredAt,
      persistenceStatus: input.persistenceStatus,
      transitionId: input.transitionId,
    });
    return context === undefined
      ? receipt(projected)
      : receipt(projected, context);
  };
}

/**
 * Captures hostile receipt-bearing executor ports exactly once and re-shapes
 * them into the kernels' receipt-neutral port record.
 */
export function adaptConsentRuntimeDecisionPorts(
  ports: unknown,
): CapturedConsentRuntimeKernelPorts {
  const captured = snapshotConsentRuntimePorts(ports);
  return Object.freeze({
    aftercare: consentReceiptAftercare(captured.receipt),
    broadcast: captured.broadcast,
    commit: captured.commit,
    notify: captured.notify,
    reconcile: captured.reconcile,
    store: captured.store,
  });
}
