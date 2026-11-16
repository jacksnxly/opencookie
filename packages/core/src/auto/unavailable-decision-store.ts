import type { DecisionStore } from "../application/persistence/persist-grant.js";

/**
 * Package-private persistence for hosts without any usable storage. Reads
 * report a missing durable record, writes report `readback-mismatch` because
 * no write can ever be confirmed by a subsequent read, and clears confirm
 * trivially because nothing can be durably stored. The runtime therefore
 * parks grants in the unconfirmed persistence phase and degrades terminal
 * denials instead of claiming durability it cannot prove.
 */
export function createUnavailableDecisionStore(): DecisionStore {
  return Object.freeze({
    clear: () => Promise.resolve(),
    clearIfCurrent: () => Promise.resolve("cleared" as const),
    compareAndSet: () =>
      Promise.resolve({ status: "readback-mismatch" as const }),
    read: () => Promise.resolve({ status: "missing" as const }),
  });
}
