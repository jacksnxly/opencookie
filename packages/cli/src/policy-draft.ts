import type { Finding, FindingKind, FindingsInventory } from "./findings.js";

/** Fields a drafted purpose still needs before a policy can be defined. @public */
export const REQUIRED_PURPOSE_FIELDS = [
  "disclosure",
  "label",
  "dataCategoryIds",
  "operationIds",
  "providerIds",
  "recipientIds",
  "retentionIds",
] as const;

/** A finding referenced by a drafted purpose. @public */
export interface DraftFindingReference {
  readonly kind: FindingKind;
  readonly name: string;
}

/** A purpose implied by the findings an operator classified. @public */
export interface DraftPurpose {
  readonly dataCategoryIds: readonly string[];
  readonly disclosures: readonly string[];
  readonly findings: readonly DraftFindingReference[];
  readonly id: string;
  readonly missing: readonly string[];
  readonly necessary: boolean;
  readonly providerIds: readonly string[];
  readonly recipientIds: readonly string[];
  readonly retentionIds: readonly string[];
}

/**
 * A scaffold derived from classified findings.
 *
 * A draft is not a policy. It names the purposes the operator's decisions imply
 * and states what each still needs, so it can never be mistaken for something
 * ready to publish.
 *
 * @public
 */
export interface PolicyDraft {
  readonly excludedUnclassified: readonly DraftFindingReference[];
  readonly publishable: false;
  readonly purposes: readonly DraftPurpose[];
}

/** @public */
export interface NoClassifiedFindingsIssue {
  readonly kind: "no-classified-findings";
}

/** @public */
export type PolicyDraftResult =
  | { readonly draft: PolicyDraft; readonly ok: true }
  | { readonly issue: NoClassifiedFindingsIssue; readonly ok: false };

interface Group {
  dataCategoryIds: Set<string>;
  disclosures: Set<string>;
  necessary: boolean;
  providerIds: Set<string>;
  recipientIds: Set<string>;
  readonly refs: Finding[];
  retentionIds: Set<string>;
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/**
 * Decides whether the decisions already supply a required purpose field.
 *
 * A decision records a disclosure but not a plural `disclosure` field, so the
 * two names are mapped rather than compared directly. `label` and
 * `operationIds` have no source in a decision and always stay missing.
 */
function supplied(
  collected: Readonly<Record<string, readonly string[]>>,
  field: (typeof REQUIRED_PURPOSE_FIELDS)[number],
): boolean {
  const key = field === "disclosure" ? "disclosures" : field;
  return (collected[key]?.length ?? 0) > 0;
}

function reference(finding: Finding): DraftFindingReference {
  return { kind: finding.kind, name: finding.name };
}

function byKindThenName(
  left: DraftFindingReference,
  right: DraftFindingReference,
): number {
  return (
    left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
  );
}

/**
 * Derives a policy scaffold from the findings an operator has classified.
 *
 * Findings carry a purpose and a necessary flag, never a disclosure or a
 * retention period, so the draft lists those as missing rather than inventing
 * them. `publishable` is always false: a draft becomes a policy only when an
 * operator supplies the rest and defines it.
 *
 * @public
 */
export function draftPolicyFromFindings(
  inventory: FindingsInventory,
): PolicyDraftResult {
  const classified = inventory.findings.filter(
    (finding) => finding.decision !== undefined,
  );
  if (classified.length === 0) {
    return { issue: { kind: "no-classified-findings" }, ok: false };
  }

  const grouped = new Map<string, Group>();
  for (const finding of classified) {
    const decision = finding.decision;
    if (decision === undefined) continue;
    const group = grouped.get(decision.purposeId) ?? {
      dataCategoryIds: new Set<string>(),
      disclosures: new Set<string>(),
      necessary: false,
      providerIds: new Set<string>(),
      recipientIds: new Set<string>(),
      refs: [],
      retentionIds: new Set<string>(),
    };
    group.refs.push(finding);
    group.necessary = group.necessary || decision.necessary;
    group.providerIds.add(decision.vendor);
    group.recipientIds.add(decision.service);
    group.retentionIds.add(decision.retention);
    group.disclosures.add(decision.disclosure);
    for (const id of decision.categoryIds) group.dataCategoryIds.add(id);
    grouped.set(decision.purposeId, group);
  }

  const purposes = [...grouped.entries()]
    .map(([id, group]) => {
      const collected = {
        dataCategoryIds: sorted(group.dataCategoryIds),
        disclosures: sorted(group.disclosures),
        providerIds: sorted(group.providerIds),
        recipientIds: sorted(group.recipientIds),
        retentionIds: sorted(group.retentionIds),
      };
      return {
        ...collected,
        findings: group.refs.map(reference).sort(byKindThenName),
        id,
        missing: REQUIRED_PURPOSE_FIELDS.filter(
          (field) => !supplied(collected, field),
        ),
        necessary: group.necessary,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const excludedUnclassified = inventory.findings
    .filter((finding) => finding.decision === undefined)
    .map(reference)
    .sort(byKindThenName);

  return {
    draft: { excludedUnclassified, publishable: false, purposes },
    ok: true,
  };
}
