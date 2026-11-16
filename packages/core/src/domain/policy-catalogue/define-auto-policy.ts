import { compareStrings } from "../shared/compare-strings.js";
import type { DefinedPolicy } from "./define-policy.js";
import {
  deepFreeze,
  INVISIBLE_DISCLOSURE,
  normalizeIdentifier,
  snapshotDefinedPolicy,
} from "./policy-primitives.js";
import type { PolicySnapshot } from "./policy-identity.js";
import type {
  DefinedPolicyResource,
  DefinedPolicyService,
  DefinedResourcePolicy,
} from "./resource-policy.js";

/**
 * Package-private invariant boundary for the canonical single-purpose auto
 * policy. It constructs exactly the graph `definePolicy` canonicalizes for
 * the classic single-purpose definition, including key insertion order, so
 * the derived catalogue and decision-surface digests are byte-identical to
 * the generic constructors. Differential tests lock that equivalence.
 */
export interface AutoPolicyDefinitionInput {
  readonly catalogueRevision: string;
  readonly consentDurationMs: number;
  readonly disclosure: string;
  readonly policyVersion: string;
  readonly purposeId: string;
  readonly purposeLabel: string;
}

export interface DefinedAutoPolicy {
  readonly expandCategorySelection: (
    categoryIds: readonly string[],
  ) => readonly string[];
  readonly policySections: readonly {
    readonly categoryId: string;
    readonly purposeIds: readonly string[];
  }[];
  readonly policy: DefinedPolicy;
  readonly purposeId: string;
  readonly retentionId: string;
  readonly snapshot: PolicySnapshot;
}

const USAGE_EVENT_ID = "usage-event";
const AGGREGATE_MEASUREMENT_ID = "aggregate-measurement";
const SITE_OPERATOR_ID = "site-operator";

function invalidAutoPolicy(): never {
  throw new TypeError("Invalid auto policy definition.");
}

function nonBlankIdentity(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    invalidAutoPolicy();
  }
  return value;
}

export function defineAutoPolicy(
  input: AutoPolicyDefinitionInput,
): DefinedAutoPolicy {
  if (
    !Number.isSafeInteger(input.consentDurationMs) ||
    input.consentDurationMs < 1
  ) {
    throw new TypeError("Consent duration must be a positive safe integer.");
  }
  const purposeId = normalizeIdentifier(input.purposeId) || invalidAutoPolicy();
  const disclosure =
    typeof input.disclosure === "string" ? input.disclosure.trim() : "";
  if (INVISIBLE_DISCLOSURE.test(disclosure)) invalidAutoPolicy();
  const label =
    typeof input.purposeLabel === "string" ? input.purposeLabel.trim() : "";
  if (INVISIBLE_DISCLOSURE.test(label)) invalidAutoPolicy();
  const catalogueRevision = nonBlankIdentity(input.catalogueRevision);
  const policyVersion = nonBlankIdentity(input.policyVersion);
  const retentionId = `duration-${String(input.consentDurationMs)}-ms`;
  const categoryId = "optional";
  const categoryIds: string[] = [];
  const purposeIds = [purposeId];

  // Key insertion order mirrors the canonical objects `definePolicy` builds:
  // the five reference lists first, then dependsOn, disclosure,
  // editorialNote, id, and label. The catalogue digest is derived from this
  // exact JSON shape, so the order is load-bearing.
  const policy = deepFreeze({
    categories: [{ categoryIds, id: categoryId, purposeIds }],
    dataCategories: [{ id: USAGE_EVENT_ID }],
    operations: [{ id: AGGREGATE_MEASUREMENT_ID }],
    presentationRootCategoryIds: [categoryId],
    providers: [{ id: SITE_OPERATOR_ID }],
    purposes: [
      {
        dataCategoryIds: [USAGE_EVENT_ID],
        operationIds: [AGGREGATE_MEASUREMENT_ID],
        providerIds: [SITE_OPERATOR_ID],
        recipientIds: [SITE_OPERATOR_ID],
        retentionIds: [retentionId],
        dependsOn: [],
        disclosure,
        editorialNote: "",
        id: purposeId,
        label,
      },
    ],
    recipients: [{ id: SITE_OPERATOR_ID }],
    retentions: [{ id: retentionId }],
  }) as unknown as DefinedPolicy;

  return deepFreeze({
    expandCategorySelection: (selectedCategoryIds: readonly string[]) =>
      selectedCategoryIds.some(
        (selectedCategoryId) =>
          normalizeIdentifier(selectedCategoryId) === categoryId,
      )
        ? purposeIds
        : categoryIds,
    policy,
    policySections: [{ categoryId, purposeIds }],
    purposeId,
    retentionId,
    snapshot: snapshotDefinedPolicy({
      catalogueRevision,
      policy,
      policyVersion,
    }),
  });
}

export interface AutoResourceDefinitionInput {
  readonly id: string;
  readonly serviceId: string;
}

/**
 * Package-private resource-policy boundary for the auto product. Every
 * resource binds to the single captured purpose; identifiers normalize, blank
 * and duplicate identities reject, and the result matches the canonical
 * `defineResourcePolicy` output for the equivalent declaration.
 */
export function defineAutoResourcePolicy(
  defined: DefinedAutoPolicy,
  resources: readonly AutoResourceDefinitionInput[],
): DefinedResourcePolicy {
  const resourceIds = new Set<string>();
  const serviceIds = new Set<string>();
  const definedResources: DefinedPolicyResource[] = [];
  const definedServices: DefinedPolicyService[] = [];
  for (const resource of resources) {
    const id = normalizeIdentifier(resource.id);
    const serviceId = normalizeIdentifier(resource.serviceId);
    if (!id || resourceIds.has(id) || !serviceId || serviceIds.has(serviceId)) {
      invalidAutoPolicy();
    }
    resourceIds.add(id);
    serviceIds.add(serviceId);
    definedResources.push({
      access: "optional",
      id,
      purposeIds: [defined.purposeId],
      serviceId,
    });
    definedServices.push({ id: serviceId });
  }

  return deepFreeze({
    purposeIds: [defined.purposeId],
    resources: definedResources.sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    services: definedServices.sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  });
}
