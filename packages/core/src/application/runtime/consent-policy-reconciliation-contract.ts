import type {
  ConsentPolicyReconciliation,
  ConsentPolicyReconciliationInput,
} from "../../reconciliation/contract.js";

/** Package-private projection boundary injected into lifecycle kernels. */
export type ConsentRuntimePolicyProjector = (
  input: ConsentPolicyReconciliationInput,
) => ConsentPolicyReconciliation;
