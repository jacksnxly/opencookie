/** @public */
export type StoredConsentInvalidReason =
  | "future-schema"
  | "invalid-record"
  | "malformed-json"
  | "read-failed"
  | "readback-mismatch";

import {
  snapshotPersistedConsentState,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "./persisted-consent-record.js";

export type {
  PersistedConsentState,
  PersistedDecisionRecord,
  PersistedDecisionRecordBase,
  PersistedPendingGrant,
} from "./persisted-consent-record.js";

/** @public */
export type DecisionStoreReadResult =
  | {
      readonly candidateCount: number;
      readonly status: "ambiguous-duplicate";
    }
  | {
      readonly reason: StoredConsentInvalidReason;
      readonly status: "invalid";
    }
  | { readonly status: "missing" }
  | {
      readonly state: PersistedConsentState;
      readonly status: "stored";
    };

/** @public */
export interface DecisionReader {
  readonly read: () => Promise<DecisionStoreReadResult>;
}

/** @public */
export type ConsentInitializationDiagnostic =
  | {
      readonly candidateCount: number;
      readonly code: "stored-consent-ambiguous-duplicate";
    }
  | {
      readonly code: "stored-consent-invalid";
      readonly reason: StoredConsentInvalidReason;
    };

/** @public */
export type ConsentInitializationResult =
  | {
      readonly diagnostics: readonly [];
      readonly status: "first-visit";
    }
  | {
      readonly diagnostics: readonly ConsentInitializationDiagnostic[];
      readonly status: "invalid";
    }
  | {
      readonly diagnostics: readonly [];
      readonly record: PersistedDecisionRecord;
      readonly state: PersistedConsentState;
      readonly status: "restored";
    }
  | {
      readonly diagnostics: readonly [];
      readonly state: Extract<
        PersistedConsentState,
        { readonly record?: never }
      >;
      readonly status: "pending";
    };

/** @public */
export async function initializeConsent(
  reader: DecisionReader,
): Promise<ConsentInitializationResult> {
  const result = await reader.read();

  switch (result.status) {
    case "missing":
      return { diagnostics: [], status: "first-visit" };
    case "stored": {
      const snapshot = snapshotPersistedConsentState(result.state);
      if (!snapshot.ok) {
        return {
          diagnostics: [
            { code: "stored-consent-invalid", reason: "invalid-record" },
          ],
          status: "invalid",
        };
      }
      const state = snapshot.state;
      return state.record === undefined
        ? { diagnostics: [], state, status: "pending" }
        : {
            diagnostics: [],
            record: state.record,
            state,
            status: "restored",
          };
    }
    case "invalid":
      return {
        diagnostics: [
          { code: "stored-consent-invalid", reason: result.reason },
        ],
        status: "invalid",
      };
    case "ambiguous-duplicate":
      return {
        diagnostics: [
          {
            candidateCount: result.candidateCount,
            code: "stored-consent-ambiguous-duplicate",
          },
        ],
        status: "invalid",
      };
  }
}
