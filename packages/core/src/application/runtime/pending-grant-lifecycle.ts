/* Protocol diagnostic surface. Runtime behavior lives in create-open-cookie-kernel.ts. */

/** @public */
export type GrantActivationDiagnostic =
  | { readonly code: "grant-activation-conflict" }
  | { readonly code: "grant-activation-unconfirmed" }
  | { readonly code: "grant-corrective-reconcile-failed" }
  | { readonly code: "grant-corrective-signal-failed" }
  | { readonly code: "grant-expired-before-activation" }
  | { readonly code: "grant-policy-mismatch-before-activation" }
  | { readonly code: "grant-receipt-failed" }
  | { readonly code: "grant-reconcile-failed" }
  | { readonly code: "grant-signal-broadcast-failed" }
  | { readonly code: "grant-superseded" };
