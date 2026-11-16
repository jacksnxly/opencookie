import {
  createPolicySnapshot,
  definePolicy,
  type PolicyDefinition,
} from "@opencookie-dev/core/domain";
import { declarePolicyTerms, type PolicyTerms } from "./disclosure.js";
import {
  definePolicyLawfulBases,
  type PolicyLawfulBases,
} from "./lawful-basis.js";
import {
  isPublicationId,
  type DuplicatePublicationIdIssue,
  type PolicyPublication,
  type PolicyPublicationLog,
  type UnknownPublicationIssue,
} from "./publication-log.js";

const PUBLICATION_DOCUMENT_VERSION = 1;

/** @public */
export interface MalformedPublicationDocumentIssue {
  readonly kind: "malformed-publication-document";
}

/** @public */
export interface PublicationDigestMismatchIssue {
  readonly kind: "publication-digest-mismatch";
  readonly publicationId: string;
}

/** @public */
export type PolicyPublicationParseIssue =
  | DuplicatePublicationIdIssue
  | MalformedPublicationDocumentIssue
  | PublicationDigestMismatchIssue
  | UnknownPublicationIssue;

/** @public */
export interface FailedPolicyPublicationParse {
  readonly issue: PolicyPublicationParseIssue;
  readonly ok: false;
}

/** @public */
export interface SuccessfulPolicyPublicationParse {
  readonly log: PolicyPublicationLog;
  readonly ok: true;
}

/** @public */
export type PolicyPublicationParseResult =
  FailedPolicyPublicationParse | SuccessfulPolicyPublicationParse;

function malformed(): FailedPolicyPublicationParse {
  return { issue: { kind: "malformed-publication-document" }, ok: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * Renders a publication log as a portable document.
 *
 * @public
 */
export function serializePolicyPublicationLog(
  log: PolicyPublicationLog,
): string {
  return JSON.stringify({
    publications: log.publications,
    version: PUBLICATION_DOCUMENT_VERSION,
  });
}

/**
 * Reads a publication log, re-deriving every policy identity from its stored policy.
 *
 * A publication whose recomputed digests disagree with the stored digests is
 * rejected rather than returned, so a corrupted or edited document can never
 * present itself as the published history.
 *
 * @public
 */
export function parsePolicyPublicationLog(
  document: string,
): PolicyPublicationParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return malformed();
  }
  const root = asRecord(parsed);
  if (root === undefined) return malformed();
  if (root["version"] !== PUBLICATION_DOCUMENT_VERSION) return malformed();
  const rawPublications = root["publications"];
  if (!Array.isArray(rawPublications)) return malformed();

  const publications: PolicyPublication[] = [];
  const seen = new Set<string>();
  for (const rawPublication of rawPublications) {
    const entry = asRecord(rawPublication);
    if (entry === undefined) return malformed();
    const publicationId = asNonBlankString(entry["publicationId"]);
    if (publicationId === undefined || !isPublicationId(publicationId)) {
      return malformed();
    }
    const rawSnapshot = asRecord(entry["snapshot"]);
    if (rawSnapshot === undefined) return malformed();
    const catalogueDigest = asNonBlankString(rawSnapshot["catalogueDigest"]);
    const catalogueRevision = asNonBlankString(
      rawSnapshot["catalogueRevision"],
    );
    const decisionSurfaceDigest = asNonBlankString(
      rawSnapshot["decisionSurfaceDigest"],
    );
    const policyVersion = asNonBlankString(rawSnapshot["policyVersion"]);
    const rawPolicy = asRecord(rawSnapshot["policy"]);
    if (
      catalogueDigest === undefined ||
      catalogueRevision === undefined ||
      decisionSurfaceDigest === undefined ||
      policyVersion === undefined ||
      rawPolicy === undefined
    ) {
      return malformed();
    }
    const definition = definePolicy(rawPolicy as unknown as PolicyDefinition);
    if (!definition.ok) return malformed();
    const snapshot = createPolicySnapshot({
      catalogueRevision,
      policy: definition.policy,
      policyVersion,
    });
    if (
      snapshot.catalogueDigest !== catalogueDigest ||
      snapshot.decisionSurfaceDigest !== decisionSurfaceDigest
    ) {
      return {
        issue: { kind: "publication-digest-mismatch", publicationId },
        ok: false,
      };
    }
    if (seen.has(publicationId)) {
      return {
        issue: { kind: "duplicate-publication-id", publicationId },
        ok: false,
      };
    }
    seen.add(publicationId);
    const restoredFrom = entry["restoredFrom"];
    const supersedes = entry["supersedes"];
    if (
      (restoredFrom !== undefined && typeof restoredFrom !== "string") ||
      (supersedes !== undefined && typeof supersedes !== "string")
    ) {
      return malformed();
    }
    const rawBases = entry["lawfulBases"];
    let lawfulBases: PolicyLawfulBases | undefined;
    if (rawBases !== undefined) {
      const record = asRecord(rawBases);
      if (record === undefined) return malformed();
      if (Object.values(record).some((basis) => typeof basis !== "string")) {
        return malformed();
      }
      // Re-validated on read, so a stored basis naming a purpose the policy no
      // longer defines is refused rather than served as a live legal claim.
      const validated = definePolicyLawfulBases(
        snapshot,
        record as PolicyLawfulBases,
      );
      if (!validated.ok) return malformed();
      lawfulBases = validated.lawfulBases;
    }
    const rawTerms = entry["terms"];
    let terms: PolicyTerms | undefined;
    if (rawTerms !== undefined) {
      const record = asRecord(rawTerms);
      if (record === undefined) return malformed();
      // Re-validated on read for the same reason digests are: a stored glossary
      // that no longer matches the policy must not be served as a disclosure.
      const validated = declarePolicyTerms(snapshot, record as PolicyTerms);
      if (!validated.ok) return malformed();
      terms = validated.terms;
    }
    publications.push({
      ...(lawfulBases === undefined ? {} : { lawfulBases }),
      ...(terms === undefined ? {} : { terms }),
      publicationId,
      snapshot,
      ...(restoredFrom === undefined ? {} : { restoredFrom }),
      ...(supersedes === undefined ? {} : { supersedes }),
    });
  }

  const known = new Set<string>();
  for (const publication of publications) {
    for (const reference of [
      publication.restoredFrom,
      publication.supersedes,
    ]) {
      if (reference !== undefined && !known.has(reference)) {
        return {
          issue: { kind: "unknown-publication", publicationId: reference },
          ok: false,
        };
      }
    }
    known.add(publication.publicationId);
  }

  return { log: { publications }, ok: true };
}
