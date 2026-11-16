/** Kinds of consent-relevant resource an observation can describe. @public */
export const FINDING_KINDS = [
  "beacon",
  "cookie",
  "iframe",
  "network-destination",
  "script",
  "storage",
] as const;

/** @public */
export type FindingKind = (typeof FINDING_KINDS)[number];

/** How much the observer vouches for a finding. @public */
export const FINDING_UNCERTAINTIES = [
  "inferred",
  "observed",
  "uncertain",
] as const;

/** @public */
export type FindingUncertainty = (typeof FINDING_UNCERTAINTIES)[number];

/** Where, when, and how a finding was seen. @public */
export interface FindingObservation {
  readonly browser: string;
  readonly observedAt: string;
  readonly source: string;
  readonly trigger: string;
}

/**
 * What happens to a resource when a visitor withdraws consent.
 *
 * `reblocked` is what the runtime itself does: it stops the resource and
 * removes what it injected. `deleted` says what the resource stored is also
 * erased whenever it is blocked: declared with `data-oc-stores` on its blocked
 * script or frame, or erased by the operator's own resource controller. Script
 * cannot reach HttpOnly or third-party cookies. `expires` says nothing is
 * erased and the stored data runs out on its own.
 *
 * @public
 */
export const FINDING_CLEANUPS = ["deleted", "expires", "reblocked"] as const;

/** @public */
export type FindingCleanup = (typeof FINDING_CLEANUPS)[number];

/** An operator's decision about what a finding means. @public */
export interface FindingDecision {
  readonly categoryIds: readonly string[];
  readonly cleanup: FindingCleanup;
  readonly decidedAt: string;
  readonly disclosure: string;
  /**
   * An address pattern the decision also covers, for a resource whose path
   * varies between visits. `*` stands for any text within one path segment.
   */
  readonly matchPattern?: string;
  readonly necessary: boolean;
  readonly purposeId: string;
  readonly retention: string;
  readonly service: string;
  readonly vendor: string;
}

/**
 * A consent-relevant resource an observer reported.
 *
 * `classification` is always `unclassified` on import. Findings never become
 * authoritative Policy Catalogue truth without an operator decision, which is
 * recorded separately in `decision`.
 *
 * @public
 */
export interface Finding {
  readonly classification: "classified" | "unclassified";
  readonly decision?: FindingDecision;
  readonly kind: FindingKind;
  readonly name: string;
  readonly observations: readonly FindingObservation[];
  readonly uncertainty: FindingUncertainty;
}

/** @public */
export interface ClassifyFindingRequest {
  readonly categoryIds: readonly string[];
  readonly cleanup: FindingCleanup;
  readonly decidedAt: string;
  readonly disclosure: string;
  readonly kind: FindingKind;
  readonly matchPattern?: string;
  readonly name: string;
  readonly necessary: boolean;
  readonly purposeId: string;
  readonly retention: string;
  readonly service: string;
  readonly vendor: string;
}

/** @public */
export interface UnknownFindingIssue {
  readonly kind: "unknown-finding";
  readonly name: string;
}

/** @public */
export interface BlankPurposeIssue {
  readonly kind: "blank-purpose";
}

/** A decision left out something a visitor or a policy needs. @public */
export interface IncompleteDecisionIssue {
  readonly kind:
    | "blank-disclosure"
    | "blank-retention"
    | "blank-service"
    | "blank-vendor"
    | "no-categories";
}

/** The decision named a cleanup behavior the runtime does not have. @public */
export interface UnsupportedCleanupIssue {
  readonly kind: "unsupported-cleanup";
  readonly value: string;
}

/**
 * A decision's address pattern was unusable, or did not cover the finding it
 * decides.
 *
 * @public
 */
export interface InvalidFindingPatternIssue {
  readonly kind: "invalid-pattern";
  readonly pattern: string;
  readonly reason: string;
}

/** @public */
export type ClassifyFindingIssue =
  | BlankPurposeIssue
  | IncompleteDecisionIssue
  | InvalidFindingPatternIssue
  | UnknownFindingIssue
  | UnsupportedCleanupIssue;

const FINDING_PATTERN = /^(https?:\/\/[^/*?#]+)(\/[^?#]*)$/u;

// A pattern's literal origin and its path segments, or why it is unusable. A
// wildcard never spans a "/" and never stands in for the origin, and at least
// one segment stays literal, so a pattern cannot quietly cover a whole site.
function parseFindingPattern(
  pattern: string,
): { readonly origin: string; readonly segments: readonly RegExp[] } | string {
  const match = FINDING_PATTERN.exec(pattern);
  if (match === null) {
    return "it must be an http or https address with a literal origin";
  }
  const [, origin = "", path = ""] = match;
  const segments = path.split("/").slice(1);
  if (segments.every((segment) => /^\**$/u.test(segment))) {
    return "at least one path segment must be literal";
  }
  return {
    origin: new URL(origin).origin,
    segments: segments.map(
      (segment) =>
        new RegExp(
          `^${segment
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
            .join("[^/]*")}$`,
          "u",
        ),
    ),
  };
}

/**
 * What makes two sightings the same resource.
 *
 * A tag is routinely cache-busted, so the query string of an address changes
 * between visits while the resource does not. Addresses are compared by origin
 * and path, and everything else, such as a cookie name, is compared exactly.
 * The full address is still what the finding records.
 */
/** A URL's identity without its kind, or undefined for a name that is not one. */
function urlIdentity(name: string): string | undefined {
  try {
    const url = new URL(name);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function resourceIdentity(kind: FindingKind, name: string): string {
  try {
    const url = new URL(name);
    return `${kind}\u001f${url.origin}${url.pathname}`;
  } catch {
    return `${kind}\u001f${name}`;
  }
}

/**
 * Finds the decided finding that covers a resource, the way `findings check`
 * and `doctor` both judge it: by its exact identity, by the same address under
 * another kind, since a tracker can omit or disguise its MIME type, or through
 * a decision's declared pattern for a path that varies between visits. Where
 * decisions disagree, the optional one counts.
 */
export function decisionLookup(
  findings: readonly Finding[],
): (kind: FindingKind, name: string) => Finding | undefined {
  const decided = new Map(
    findings
      .filter((finding) => finding.decision !== undefined)
      .map((finding) => [
        resourceIdentity(finding.kind, finding.name),
        finding,
      ]),
  );
  const decidedByUrl = new Map<string, Finding>();
  for (const finding of decided.values()) {
    const identity = urlIdentity(finding.name);
    if (identity === undefined) continue;
    const known = decidedByUrl.get(identity);
    if (known === undefined || known.decision?.necessary === true) {
      decidedByUrl.set(identity, finding);
    }
  }
  const patterned = [...decided.values()].filter(
    (finding) => finding.decision?.matchPattern !== undefined,
  );
  return (kind, name) => {
    const byUrl = urlIdentity(name);
    const found =
      decided.get(resourceIdentity(kind, name)) ??
      (byUrl === undefined ? undefined : decidedByUrl.get(byUrl));
    if (found !== undefined) return found;
    const matching = patterned.filter((finding) =>
      findingPatternMatches(finding.decision?.matchPattern ?? "", name),
    );
    return (
      matching.find((finding) => finding.decision?.necessary !== true) ??
      matching[0]
    );
  };
}

/**
 * Whether an observed address falls under a decision's pattern: the same
 * origin, and each path segment matched in turn.
 */
export function findingPatternMatches(
  pattern: string,
  address: string,
): boolean {
  const parsed = parseFindingPattern(pattern);
  if (typeof parsed === "string") return false;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const segments = url.pathname.split("/").slice(1);
  return (
    url.origin === parsed.origin &&
    segments.length === parsed.segments.length &&
    segments.every((segment, index) => parsed.segments[index]?.test(segment))
  );
}

/** @public */
export type ClassifyFindingResult =
  | { readonly inventory: FindingsInventory; readonly ok: true }
  | { readonly issue: ClassifyFindingIssue; readonly ok: false };

/** @public */
export interface FindingsInventory {
  readonly findings: readonly Finding[];
}

/** @public */
export interface MalformedObservationIssue {
  readonly field: string;
  readonly kind: "malformed-observation";
}

/** @public */
export interface UnsupportedFindingKindIssue {
  readonly kind: "unsupported-finding-kind";
  readonly value: string;
}

/** @public */
export interface UnsupportedUncertaintyIssue {
  readonly kind: "unsupported-uncertainty";
  readonly value: string;
}

/** @public */
export type FindingsImportIssue =
  | MalformedObservationIssue
  | UnsupportedFindingKindIssue
  | UnsupportedUncertaintyIssue;

/** @public */
export type FindingsImportResult =
  | { readonly inventory: FindingsInventory; readonly ok: true }
  | { readonly issue: FindingsImportIssue; readonly ok: false };

/** @public */
export function emptyFindingsInventory(): FindingsInventory {
  return { findings: [] };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

interface ParsedObservation {
  readonly kind: FindingKind;
  readonly name: string;
  readonly observation: FindingObservation;
  readonly uncertainty: FindingUncertainty;
}

/**
 * An address without its query string and fragment, which can carry a token,
 * an e-mail address or a visitor id. A resource is decided by its origin and
 * path, so nothing a decision needs is lost. Anything else, such as a cookie
 * name, is kept as it is.
 */
function withoutQuery(name: string): string {
  try {
    const url = new URL(name);
    return url.protocol === "http:" || url.protocol === "https:"
      ? `${url.origin}${url.pathname}`
      : name;
  } catch {
    return name;
  }
}

function parseObservation(
  raw: unknown,
): ParsedObservation | FindingsImportIssue {
  const record = asRecord(raw);
  if (record === undefined) {
    return { field: "observation", kind: "malformed-observation" };
  }
  for (const field of ["browser", "name", "observedAt", "source", "trigger"]) {
    if (nonBlank(record[field]) === undefined) {
      return { field, kind: "malformed-observation" };
    }
  }
  const kind = record["kind"];
  if (
    typeof kind !== "string" ||
    !FINDING_KINDS.includes(kind as FindingKind)
  ) {
    return {
      kind: "unsupported-finding-kind",
      value: typeof kind === "string" ? kind : "",
    };
  }
  const uncertainty = record["uncertainty"];
  if (
    typeof uncertainty !== "string" ||
    !FINDING_UNCERTAINTIES.includes(uncertainty as FindingUncertainty)
  ) {
    return {
      kind: "unsupported-uncertainty",
      value: typeof uncertainty === "string" ? uncertainty : "",
    };
  }
  return {
    kind: kind as FindingKind,
    name: withoutQuery(record["name"] as string),
    observation: {
      browser: record["browser"] as string,
      observedAt: record["observedAt"] as string,
      source: withoutQuery(record["source"] as string),
      trigger: record["trigger"] as string,
    },
    uncertainty: uncertainty as FindingUncertainty,
  };
}

/**
 * Imports observed resources into the findings inventory.
 *
 * The import is all-or-nothing: one malformed observation refuses the whole
 * batch and leaves the inventory untouched, so a partially applied import can
 * never be mistaken for a complete one. A repeat sighting of the same kind and
 * name records another observation rather than replacing the earlier evidence.
 *
 * @public
 */
export function importObservedFindings(
  inventory: FindingsInventory,
  observations: readonly unknown[],
): FindingsImportResult {
  const parsed: ParsedObservation[] = [];
  for (const raw of observations) {
    const candidate = parseObservation(raw);
    if ("observation" in candidate) {
      parsed.push(candidate);
    } else {
      return { issue: candidate, ok: false };
    }
  }

  const findings = inventory.findings.map((finding) => ({
    ...finding,
    observations: [...finding.observations],
  }));
  for (const entry of parsed) {
    // An inventory written before addresses were trimmed holds full ones, so a
    // resource is found by its identity, not its stored spelling.
    const identity = resourceIdentity(entry.kind, entry.name);
    const existing = findings.find(
      (finding) => resourceIdentity(finding.kind, finding.name) === identity,
    );
    if (existing === undefined) {
      findings.push({
        classification: "unclassified",
        kind: entry.kind,
        name: entry.name,
        observations: [entry.observation],
        uncertainty: entry.uncertainty,
      });
    } else {
      existing.observations.push(entry.observation);
    }
  }
  return { inventory: { findings }, ok: true };
}

/**
 * Records an operator's decision about an observed finding.
 *
 * Classification is an operator act, never an import side effect. Revising a
 * decision replaces only the decision: the observed evidence that produced the
 * finding is preserved so the history of what was actually seen stays intact.
 *
 * @public
 */
export function classifyFinding(
  inventory: FindingsInventory,
  request: ClassifyFindingRequest,
): ClassifyFindingResult {
  const purposeId = request.purposeId.trim();
  if (purposeId.length === 0) {
    return { issue: { kind: "blank-purpose" }, ok: false };
  }
  const required = [
    ["blank-vendor", request.vendor],
    ["blank-service", request.service],
    // A necessary resource is set without asking, so being told what it does is
    // the only thing a visitor still gets.
    ["blank-disclosure", request.disclosure],
    ["blank-retention", request.retention],
  ] as const;
  for (const [kind, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return { issue: { kind }, ok: false };
    }
  }
  const categoryIds = request.categoryIds.map((id) => id.trim());
  if (categoryIds.length === 0 || categoryIds.some((id) => id.length === 0)) {
    return { issue: { kind: "no-categories" }, ok: false };
  }
  if (!FINDING_CLEANUPS.includes(request.cleanup)) {
    return {
      issue: { kind: "unsupported-cleanup", value: request.cleanup },
      ok: false,
    };
  }
  // An operator may paste the address with its query string; the finding is
  // stored under its origin and path.
  const identity = resourceIdentity(request.kind, request.name);
  const target = inventory.findings.find(
    (finding) => resourceIdentity(finding.kind, finding.name) === identity,
  );
  if (target === undefined) {
    return {
      issue: { kind: "unknown-finding", name: request.name },
      ok: false,
    };
  }
  const { matchPattern } = request;
  if (matchPattern !== undefined) {
    const parsed = parseFindingPattern(matchPattern);
    const reason =
      typeof parsed === "string"
        ? parsed
        : findingPatternMatches(matchPattern, request.name)
          ? undefined
          : "it does not cover the finding it decides";
    if (reason !== undefined) {
      return {
        issue: { kind: "invalid-pattern", pattern: matchPattern, reason },
        ok: false,
      };
    }
  }
  const findings = inventory.findings.map((finding) =>
    finding === target
      ? {
          ...finding,
          classification: "classified" as const,
          decision: {
            categoryIds,
            cleanup: request.cleanup,
            decidedAt: request.decidedAt,
            disclosure: request.disclosure.trim(),
            ...(matchPattern === undefined ? {} : { matchPattern }),
            necessary: request.necessary,
            purposeId,
            retention: request.retention.trim(),
            service: request.service.trim(),
            vendor: request.vendor.trim(),
          },
        }
      : finding,
  );
  return { inventory: { findings }, ok: true };
}
