import {
  decisionStoreClearPrecondition,
  decisionStorePreconditionFailure,
  type DecisionStore,
  type DecisionStoreConditionalClearResult,
  type DecisionStoreWriteResult,
} from "../../application/persistence/persist-grant.js";
import type {
  DecisionStoreReadResult,
  PersistedConsentState,
} from "../../application/runtime/initialize-consent.js";
import {
  decodeDecisionRecordEnvelope,
  encodeDecisionRecordEnvelope,
} from "./decision-record-codec.js";

/** @public */
export interface StorageLike {
  readonly getItem: (key: string) => string | null;
  readonly removeItem: (key: string) => void;
  readonly setItem: (key: string, value: string) => void;
}

/** @public */
export interface LocalStorageDecisionStoreOptions {
  readonly key: string;
  readonly schemaVersion: number;
  readonly storage: StorageLike;
}

/** @public */
export interface LocalStorageDecisionStore extends DecisionStore {
  readonly clear: () => Promise<void>;
}

interface LocalStorageSnapshot {
  readonly raw: string | null | undefined;
  readonly result: DecisionStoreReadResult;
}

function promiseFrom<Result>(operation: () => Result): Promise<Result> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(
      error instanceof Error
        ? error
        : new Error("Decision storage operation failed."),
    );
  }
}

/** @public */
export function createLocalStorageDecisionStore(
  options: LocalStorageDecisionStoreOptions,
): LocalStorageDecisionStore {
  function inspect(): LocalStorageSnapshot {
    try {
      const raw = options.storage.getItem(options.key);
      return {
        raw,
        result:
          raw === null
            ? { status: "missing" }
            : decodeDecisionRecordEnvelope(raw, options.schemaVersion),
      };
    } catch {
      return {
        raw: undefined,
        result: { reason: "read-failed", status: "invalid" },
      };
    }
  }

  function read(): Promise<DecisionStoreReadResult> {
    return Promise.resolve(inspect().result);
  }

  function remove(): void {
    options.storage.removeItem(options.key);
  }

  return Object.freeze({
    clear(): Promise<void> {
      return promiseFrom(() => {
        remove();
        if (options.storage.getItem(options.key) !== null) {
          throw new Error("Decision storage clear was not confirmed.");
        }
      });
    },
    clearIfCurrent(
      expected: PersistedConsentState,
    ): Promise<DecisionStoreConditionalClearResult> {
      return promiseFrom<DecisionStoreConditionalClearResult>(() => {
        const snapshot = inspect();
        const failure = decisionStoreClearPrecondition(
          snapshot.result,
          expected,
        );
        if (failure) return failure;
        if (options.storage.getItem(options.key) !== snapshot.raw) {
          return "readback-mismatch";
        }
        remove();
        return options.storage.getItem(options.key) === null
          ? "cleared"
          : "readback-mismatch";
      });
    },
    compareAndSet(
      expected: PersistedConsentState | null,
      candidate: PersistedConsentState,
    ): Promise<DecisionStoreWriteResult> {
      return promiseFrom<DecisionStoreWriteResult>(() => {
        const snapshot = inspect();
        const current = snapshot.result;
        const failure = decisionStorePreconditionFailure(current, expected);
        if (failure) return { status: failure };

        const serialized = encodeDecisionRecordEnvelope(
          candidate,
          options.schemaVersion,
        );
        options.storage.setItem(options.key, serialized);

        try {
          if (options.storage.getItem(options.key) === serialized) {
            return { status: "written" };
          }
        } catch {
          return { status: "readback-mismatch" };
        }
        return { status: "readback-mismatch" };
      });
    },
    read,
  });
}
