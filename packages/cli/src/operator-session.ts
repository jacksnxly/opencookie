import { randomBytes } from "node:crypto";

/** One signed-in operator. @public */
export interface OperatorSession {
  /**
   * Proves a write came from this surface's own form. A session cookie travels
   * on every request the browser makes, including one another site provoked,
   * so the cookie alone cannot show that the operator meant to act.
   */
  readonly formToken: string;
}

/** A created session, with the identifier the cookie carries. @public */
export interface CreatedOperatorSession extends OperatorSession {
  readonly id: string;
}

/** Where signed-in sessions live. @public */
export interface OperatorSessionStore {
  create(): CreatedOperatorSession;
  destroy(id: string): void;
  read(id: string): OperatorSession | undefined;
}

/** @public */
export interface MemorySessionStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function secret(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Keeps sessions in memory for one running server.
 *
 * Restarting the server signs every operator out, which is the honest
 * behaviour for a single self-hosted process: nothing claims to remember a
 * session that no longer exists.
 *
 * @public
 */
export function createMemorySessionStore(
  options: MemorySessionStoreOptions = {},
): OperatorSessionStore {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? TWELVE_HOURS_MS;
  const sessions = new Map<string, { expiresAt: number; formToken: string }>();
  return {
    create() {
      const id = secret();
      const formToken = secret();
      sessions.set(id, { expiresAt: now() + ttlMs, formToken });
      return { formToken, id };
    },
    destroy(id) {
      sessions.delete(id);
    },
    read(id) {
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      if (now() >= session.expiresAt) {
        sessions.delete(id);
        return undefined;
      }
      return { formToken: session.formToken };
    },
  };
}
