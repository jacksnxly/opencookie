import type { PolicySnapshot } from "@opencookie-dev/core/domain";

import type { FileSystemPort } from "./contracts.js";
import type { PolicyLawfulBases } from "./lawful-basis.js";
import type { PolicyTerms } from "./disclosure.js";
import {
  emptyPolicyPublicationLog,
  publishPolicy,
  rollbackPolicyPublication,
  type PolicyPublication,
  type PolicyPublicationIssue,
  type PolicyPublicationLog,
} from "./publication-log.js";
import {
  parsePolicyPublicationLog,
  serializePolicyPublicationLog,
} from "./serialize-publication-log.js";

/** The stored publication history could not be read or failed its integrity check. @public */
export interface UnreadablePolicyStoreIssue {
  readonly kind: "unreadable-store";
}

/** The domain refused the requested publication. @public */
export interface RejectedPolicyPublicationIssue {
  readonly kind: "rejected-publication";
  readonly reason: PolicyPublicationIssue["kind"];
}

/** @public */
export type PolicyStoreIssue =
  RejectedPolicyPublicationIssue | UnreadablePolicyStoreIssue;

/** @public */
export interface FailedPolicyStoreOperation {
  readonly issue: PolicyStoreIssue;
  readonly ok: false;
}

/** @public */
export interface SuccessfulPolicyStoreRead {
  readonly log: PolicyPublicationLog;
  readonly ok: true;
}

interface StoredDocument {
  readonly log: PolicyPublicationLog;
  readonly raw: string | undefined;
}

/** @public */
export type PolicyStoreReadResult =
  FailedPolicyStoreOperation | SuccessfulPolicyStoreRead;

/** @public */
export interface SuccessfulPolicyStoreWrite {
  readonly log: PolicyPublicationLog;
  readonly ok: true;
  readonly publication: PolicyPublication;
}

/** @public */
export type PolicyStoreWriteResult =
  FailedPolicyStoreOperation | SuccessfulPolicyStoreWrite;

/** @public */
export interface PolicyPublishRequest {
  readonly lawfulBases?: PolicyLawfulBases;
  readonly path: string;
  readonly terms?: PolicyTerms;
  readonly publicationId: string;
  readonly snapshot: PolicySnapshot;
}

/** @public */
export interface PolicyRollbackStoreRequest {
  readonly path: string;
  readonly publicationId: string;
  readonly restoreFrom: string;
}

function unreadableStore(): FailedPolicyStoreOperation {
  return { issue: { kind: "unreadable-store" }, ok: false };
}

function rejected(issue: PolicyPublicationIssue): FailedPolicyStoreOperation {
  return {
    issue: { kind: "rejected-publication", reason: issue.kind },
    ok: false,
  };
}

/**
 * Runs an operation under a lock held beside the store, never on the store file.
 *
 * The lock port creates its path exclusively, so locking the store file itself
 * would both fail on a missing directory and refuse every publication after the
 * first. The containing directory is created before the lock is taken.
 */
async function withStoreLock<Result>(
  fileSystem: FileSystemPort,
  path: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent !== "") await fileSystem.mkdir(parent);
  return fileSystem.withLock(`${path}.lock`, operation);
}

/**
 * Reads the stored publication history.
 *
 * An absent store reads as an empty log. A store that fails its integrity check
 * is reported as unreadable rather than returned, so corrupted history can never
 * be mistaken for the published record.
 *
 * @public
 */
export async function readPolicyPublicationLog(
  fileSystem: FileSystemPort,
  path: string,
): Promise<PolicyStoreReadResult> {
  const stored = await readStoredDocument(fileSystem, path);
  if (stored === undefined) return unreadableStore();
  return { log: stored.log, ok: true };
}

async function readStoredDocument(
  fileSystem: FileSystemPort,
  path: string,
): Promise<StoredDocument | undefined> {
  if (!(await fileSystem.exists(path))) {
    return { log: emptyPolicyPublicationLog(), raw: undefined };
  }
  const raw = await fileSystem.readFile(path);
  const parsed = parsePolicyPublicationLog(raw);
  if (!parsed.ok) return undefined;
  return { log: parsed.log, raw };
}

/**
 * Persists the store, creating it only when absent.
 *
 * The filesystem port creates files exclusively, so an existing store is updated
 * through its compare-and-swap replacement instead, which refuses the write if
 * the document changed after it was read.
 */
async function persistStore(
  fileSystem: FileSystemPort,
  path: string,
  previous: string | undefined,
  document: string,
): Promise<void> {
  if (previous === undefined) {
    await fileSystem.writeFile(path, document);
    return;
  }
  await fileSystem.replaceFile(path, previous, document);
}

/**
 * Publishes a policy snapshot into the store under its lock.
 *
 * The store is only rewritten after the existing history has been read and
 * verified, so a corrupted store is never overwritten by a new publication.
 *
 * @public
 */
export async function publishPolicyToStore(
  fileSystem: FileSystemPort,
  request: PolicyPublishRequest,
): Promise<PolicyStoreWriteResult> {
  return withStoreLock(fileSystem, request.path, async () => {
    const stored = await readStoredDocument(fileSystem, request.path);
    if (stored === undefined) return unreadableStore();
    const published = publishPolicy(stored.log, {
      ...(request.lawfulBases === undefined
        ? {}
        : { lawfulBases: request.lawfulBases }),
      publicationId: request.publicationId,
      snapshot: request.snapshot,
      ...(request.terms === undefined ? {} : { terms: request.terms }),
    });
    if (!published.ok) return rejected(published.issue);
    await persistStore(
      fileSystem,
      request.path,
      stored.raw,
      serializePolicyPublicationLog(published.log),
    );
    return {
      log: published.log,
      ok: true,
      publication: published.publication,
    };
  });
}

/**
 * Restores an earlier publication by appending a new one, under the store lock.
 *
 * @public
 */
export async function rollbackPolicyInStore(
  fileSystem: FileSystemPort,
  request: PolicyRollbackStoreRequest,
): Promise<PolicyStoreWriteResult> {
  return withStoreLock(fileSystem, request.path, async () => {
    const stored = await readStoredDocument(fileSystem, request.path);
    if (stored === undefined) return unreadableStore();
    const rolledBack = rollbackPolicyPublication(stored.log, {
      publicationId: request.publicationId,
      restoreFrom: request.restoreFrom,
    });
    if (!rolledBack.ok) return rejected(rolledBack.issue);
    await persistStore(
      fileSystem,
      request.path,
      stored.raw,
      serializePolicyPublicationLog(rolledBack.log),
    );
    return {
      log: rolledBack.log,
      ok: true,
      publication: rolledBack.publication,
    };
  });
}
