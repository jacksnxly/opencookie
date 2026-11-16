import type { PolicySnapshot } from "@opencookie-dev/core/domain";

import type { PolicyLawfulBases } from "./lawful-basis.js";
import type { PolicyTerms } from "./disclosure.js";

/** @public */
export interface PolicyPublication {
  /**
   * Operator-declared lawful bases, kept beside the policy rather than inside
   * it so that a legal claim can never alter the enforced decision surface.
   */
  readonly lawfulBases?: PolicyLawfulBases;
  readonly publicationId: string;
  readonly restoredFrom?: string;
  readonly snapshot: PolicySnapshot;
  readonly supersedes?: string;
  /** Plain-language terms, held beside the policy so wording never alters enforcement. */
  readonly terms?: PolicyTerms;
}

/** @public */
export interface PolicyPublicationLog {
  readonly publications: readonly PolicyPublication[];
}

/** @public */
export interface BlankPublicationIdIssue {
  readonly kind: "blank-publication-id";
}

/** @public */
export interface DuplicatePublicationIdIssue {
  readonly kind: "duplicate-publication-id";
  readonly publicationId: string;
}

/** @public */
export interface UnchangedCurrentPolicyIssue {
  readonly kind: "unchanged-current-policy";
  readonly publicationId: string;
}

/**
 * A changed policy under the version already live. A version names one policy,
 * and visitors' stored decisions carry over within it, so a change needs a new
 * version to be asked again. @public
 */
export interface ChangedPolicySameVersionIssue {
  readonly kind: "changed-policy-same-version";
  readonly policyVersion: string;
  readonly publicationId: string;
}

/** @public */
export interface UnknownPublicationIssue {
  readonly kind: "unknown-publication";
  readonly publicationId: string;
}

/** @public */
export interface InvalidPublicationIdIssue {
  readonly kind: "invalid-publication-id";
}

// A publication id is written into generated source, so it must stay a plain
// identifier: a line terminator or quote would turn the rest of it into code.
const PUBLICATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Whether a value may identify a publication.
 *
 * @public
 */
export function isPublicationId(value: string): boolean {
  return PUBLICATION_ID.test(value);
}

/** @public */
export type PolicyPublicationIssue =
  | InvalidPublicationIdIssue
  | BlankPublicationIdIssue
  | DuplicatePublicationIdIssue
  | UnchangedCurrentPolicyIssue
  | ChangedPolicySameVersionIssue
  | UnknownPublicationIssue;

/** @public */
export interface FailedPolicyPublication {
  readonly issue: PolicyPublicationIssue;
  readonly ok: false;
}

/** @public */
export interface SuccessfulPolicyPublication {
  readonly log: PolicyPublicationLog;
  readonly ok: true;
  readonly publication: PolicyPublication;
}

/** @public */
export type PolicyPublicationResult =
  FailedPolicyPublication | SuccessfulPolicyPublication;

/** @public */
export interface PolicyPublicationRequest {
  readonly lawfulBases?: PolicyLawfulBases;
  readonly publicationId: string;
  readonly snapshot: PolicySnapshot;
  readonly terms?: PolicyTerms;
}

/** @public */
export interface PolicyRollbackRequest {
  readonly publicationId: string;
  readonly restoreFrom: string;
}

function samePolicyIdentity(
  left: PolicySnapshot,
  right: PolicySnapshot,
): boolean {
  return (
    left.catalogueDigest === right.catalogueDigest &&
    left.catalogueRevision === right.catalogueRevision &&
    left.decisionSurfaceDigest === right.decisionSurfaceDigest &&
    left.policyVersion === right.policyVersion
  );
}

function appendPublication(
  log: PolicyPublicationLog,
  publication: PolicyPublication,
): SuccessfulPolicyPublication {
  return {
    log: { publications: [...log.publications, publication] },
    ok: true,
    publication,
  };
}

/**
 * Creates a log with no published policy.
 *
 * @public
 */
export function emptyPolicyPublicationLog(): PolicyPublicationLog {
  return { publications: [] };
}

/**
 * Returns the publication that is live, or `undefined` when nothing is published.
 *
 * @public
 */
export function currentPolicyPublication(
  log: PolicyPublicationLog,
): PolicyPublication | undefined {
  return log.publications.at(-1);
}

/**
 * Appends a policy snapshot as the live publication.
 *
 * The log is append-only: earlier publications are never rewritten or removed.
 * Publishing a snapshot whose identity already matches the live publication
 * fails rather than reporting a change that did not occur.
 *
 * @public
 */
export function publishPolicy(
  log: PolicyPublicationLog,
  request: PolicyPublicationRequest,
): PolicyPublicationResult {
  const publicationId = request.publicationId.trim();
  if (publicationId.length === 0) {
    return { issue: { kind: "blank-publication-id" }, ok: false };
  }
  if (!isPublicationId(publicationId)) {
    return { issue: { kind: "invalid-publication-id" }, ok: false };
  }
  if (
    log.publications.some(
      (publication) => publication.publicationId === publicationId,
    )
  ) {
    return {
      issue: { kind: "duplicate-publication-id", publicationId },
      ok: false,
    };
  }
  const current = currentPolicyPublication(log);
  const sameIdentity =
    current !== undefined &&
    samePolicyIdentity(current.snapshot, request.snapshot);
  // Under one identity, two policies can differ only in the order categories
  // and their purposes are shown in. A reordering is a real change to what a
  // visitor reads but not to what they decided, so it publishes under the
  // live version.
  if (
    sameIdentity &&
    JSON.stringify(current.snapshot.policy) ===
      JSON.stringify(request.snapshot.policy)
  ) {
    return {
      issue: {
        kind: "unchanged-current-policy",
        publicationId: current.publicationId,
      },
      ok: false,
    };
  }
  if (
    current !== undefined &&
    !sameIdentity &&
    current.snapshot.policyVersion === request.snapshot.policyVersion
  ) {
    return {
      issue: {
        kind: "changed-policy-same-version",
        policyVersion: current.snapshot.policyVersion,
        publicationId: current.publicationId,
      },
      ok: false,
    };
  }
  return appendPublication(log, {
    ...(request.lawfulBases === undefined
      ? {}
      : { lawfulBases: request.lawfulBases }),
    publicationId,
    snapshot: request.snapshot,
    ...(current === undefined ? {} : { supersedes: current.publicationId }),
    ...(request.terms === undefined ? {} : { terms: request.terms }),
  });
}

/**
 * Restores an earlier publication by appending a new one that carries its
 * snapshot, and the terms and lawful bases published beside it.
 *
 * Rollback never rewrites history: the superseded publications remain readable
 * and the restoring publication records which one it restored.
 *
 * @public
 */
export function rollbackPolicyPublication(
  log: PolicyPublicationLog,
  request: PolicyRollbackRequest,
): PolicyPublicationResult {
  const publicationId = request.publicationId.trim();
  if (publicationId.length === 0) {
    return { issue: { kind: "blank-publication-id" }, ok: false };
  }
  if (!isPublicationId(publicationId)) {
    return { issue: { kind: "invalid-publication-id" }, ok: false };
  }
  if (
    log.publications.some(
      (publication) => publication.publicationId === publicationId,
    )
  ) {
    return {
      issue: { kind: "duplicate-publication-id", publicationId },
      ok: false,
    };
  }
  const restored = log.publications.find(
    (publication) => publication.publicationId === request.restoreFrom,
  );
  if (restored === undefined) {
    return {
      issue: {
        kind: "unknown-publication",
        publicationId: request.restoreFrom,
      },
      ok: false,
    };
  }
  const current = currentPolicyPublication(log);
  return appendPublication(log, {
    ...(restored.lawfulBases === undefined
      ? {}
      : { lawfulBases: restored.lawfulBases }),
    publicationId,
    restoredFrom: restored.publicationId,
    snapshot: restored.snapshot,
    ...(current === undefined ? {} : { supersedes: current.publicationId }),
    ...(restored.terms === undefined ? {} : { terms: restored.terms }),
  });
}
