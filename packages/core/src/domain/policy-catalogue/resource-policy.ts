import { compareStrings } from "../shared/compare-strings.js";
import {
  captureDataArray,
  captureDataProperty,
} from "../shared/capture-data-property.js";
import {
  addPolicyIssue,
  comparePolicyIdentifiers,
  deepFreeze,
  definePolicy,
  type DefinedPolicy,
  normalizeIdentifier,
  type PolicyDefinition,
} from "./define-policy.js";

/** @public */
export interface PolicyServiceDefinition {
  readonly id: string;
}

/** @public */
export interface OptionalPolicyResourceDefinition {
  readonly access: "optional";
  readonly id: string;
  readonly purposeIds: readonly string[];
  /**
   * Whether the resource needs every one of its purposes permitted, the
   * default, or any one of them, as a tag manager's container does.
   */
  readonly purposeMatch?: "all" | "any";
  readonly serviceId: string;
}

/** @public */
export interface DeclaredExceptionPolicyResourceDefinition {
  readonly access: "declared-exception";
  readonly exceptionReason: string;
  readonly id: string;
  /** The name listed in place of the id, such as "Session cookie". */
  readonly label?: string;
  readonly purposeIds?: readonly string[];
  readonly serviceId: string;
}

/** @public */
export type PolicyResourceDefinition =
  DeclaredExceptionPolicyResourceDefinition | OptionalPolicyResourceDefinition;

/** @public */
export interface ResourcePolicyDefinition {
  readonly policy: DefinedPolicy;
  readonly resources: readonly PolicyResourceDefinition[];
  readonly services: readonly PolicyServiceDefinition[];
}

/** @public */
export type ResourcePolicyIssue =
  | {
      readonly code: "blank-service-id" | "blank-resource-id";
      readonly path: string;
    }
  | {
      readonly code:
        | "blank-exception-label"
        | "invalid-purpose-match"
        | "missing-exception-reason";
      readonly path: string;
    }
  | {
      readonly code: "optional-resource-without-purpose";
      readonly path: string;
    }
  | {
      readonly code:
        | "duplicate-resource-id"
        | "duplicate-resource-purpose"
        | "duplicate-service-id"
        | "unknown-resource-purpose"
        | "unknown-resource-service";
      readonly normalizedId: string;
      readonly path: string;
    };

/** @public */
export interface DefinedPolicyService {
  readonly id: string;
}

/** @public */
export type DefinedPolicyResource =
  | {
      readonly access: "declared-exception";
      readonly exceptionReason: string;
      readonly id: string;
      /** Present only when the exception declares one. */
      readonly label?: string;
      readonly purposeIds: readonly string[];
      readonly serviceId: string;
    }
  | {
      readonly access: "optional";
      readonly id: string;
      readonly purposeIds: readonly string[];
      /** Present only for a resource of several purposes that matches any. */
      readonly purposeMatch?: "any";
      readonly serviceId: string;
    };

/** @public */
export interface DefinedResourcePolicy {
  readonly purposeIds: readonly string[];
  readonly resources: readonly DefinedPolicyResource[];
  readonly services: readonly DefinedPolicyService[];
}

/** @public */
export type ResourcePolicyDefinitionResult =
  | {
      readonly issues: readonly ResourcePolicyIssue[];
      readonly ok: false;
    }
  | {
      readonly ok: true;
      readonly resourcePolicy: DefinedResourcePolicy;
    };

const MAX_RESOURCE_POLICY_GRAPH_ENTRIES = 10_000;

interface ResourcePolicyCaptureBudget {
  remaining: number;
}

function invalidResourceDefinition(path: string): never {
  throw new TypeError(`Invalid resource policy definition at ${path}.`);
}

function resourceDefinitionObject(value: unknown, path: string): object {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return invalidResourceDefinition(path);
    }
    return value;
  } catch {
    return invalidResourceDefinition(path);
  }
}

function resourceDefinitionValue(
  source: object,
  field: string,
  path: string,
  required = true,
): unknown {
  const descriptor = captureDataProperty(source, field);
  if (descriptor === undefined || (required && descriptor === null)) {
    return invalidResourceDefinition(path);
  }
  return descriptor?.value;
}

function resourceDefinitionArray<Entry>(
  value: unknown,
  path: string,
  budget: ResourcePolicyCaptureBudget,
  captureEntry: (entry: unknown, path: string) => Entry,
): Entry[] {
  const captured = captureDataArray(
    value,
    budget,
    (entry, index) => captureEntry(entry, `${path}[${String(index)}]`),
    (index) =>
      invalidResourceDefinition(
        index === undefined ? path : `${path}[${String(index)}]`,
      ),
  );
  if (captured === undefined) return invalidResourceDefinition(path);
  return captured;
}

function detachResourcePolicyEntries(
  root: object,
  budget: ResourcePolicyCaptureBudget,
): Pick<ResourcePolicyDefinition, "resources" | "services"> {
  const services = resourceDefinitionArray(
    resourceDefinitionValue(root, "services", "services"),
    "services",
    budget,
    (entry, path) => {
      const source = resourceDefinitionObject(entry, path);
      return { id: resourceDefinitionValue(source, "id", `${path}.id`) };
    },
  );
  const resources = resourceDefinitionArray(
    resourceDefinitionValue(root, "resources", "resources"),
    "resources",
    budget,
    (entry, path) => {
      const source = resourceDefinitionObject(entry, path);
      const access = resourceDefinitionValue(
        source,
        "access",
        `${path}.access`,
      );
      if (access !== "declared-exception" && access !== "optional") {
        return invalidResourceDefinition(`${path}.access`);
      }
      const purposeIdsValue = resourceDefinitionValue(
        source,
        "purposeIds",
        `${path}.purposeIds`,
        access === "optional",
      );
      const purposeIds =
        purposeIdsValue === undefined
          ? undefined
          : resourceDefinitionArray(
              purposeIdsValue,
              `${path}.purposeIds`,
              budget,
              (purposeId) => purposeId,
            );
      const purposeMatch = resourceDefinitionValue(
        source,
        "purposeMatch",
        `${path}.purposeMatch`,
        false,
      );
      const base = {
        access,
        id: resourceDefinitionValue(source, "id", `${path}.id`),
        ...(purposeIds === undefined ? {} : { purposeIds }),
        ...(purposeMatch === undefined ? {} : { purposeMatch }),
        serviceId: resourceDefinitionValue(
          source,
          "serviceId",
          `${path}.serviceId`,
        ),
      };
      if (access !== "declared-exception") return base;
      const label = resourceDefinitionValue(
        source,
        "label",
        `${path}.label`,
        false,
      );
      return {
        ...base,
        exceptionReason: resourceDefinitionValue(
          source,
          "exceptionReason",
          `${path}.exceptionReason`,
        ),
        ...(label === undefined ? {} : { label }),
      };
    },
  );

  // Captured values are validated as the definition is normalized.
  return { resources, services } as unknown as Pick<
    ResourcePolicyDefinition,
    "resources" | "services"
  >;
}

function detachResourcePolicyDefinition(
  candidate: unknown,
): ResourcePolicyDefinition {
  const root = resourceDefinitionObject(candidate, "$");
  const budget: ResourcePolicyCaptureBudget = {
    remaining: MAX_RESOURCE_POLICY_GRAPH_ENTRIES,
  };
  const policyResult = definePolicy(
    resourceDefinitionValue(root, "policy", "policy") as PolicyDefinition,
  );
  if (!policyResult.ok) return invalidResourceDefinition("policy");

  return {
    policy: policyResult.policy,
    ...detachResourcePolicyEntries(root, budget),
  };
}

function stableIdentifiers(values: Iterable<string>): readonly string[] {
  return [...values].sort(compareStrings);
}

function normalizedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && !!value && normalizeIdentifier(value) === value
  );
}

function normalizedIdentifierArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => normalizedIdentifier(entry))
  );
}

function defineResourcePolicyEntries(
  purposeIds: readonly string[],
  resourceDefinitions: readonly PolicyResourceDefinition[],
  serviceDefinitions: readonly PolicyServiceDefinition[],
): ResourcePolicyDefinitionResult {
  const issues: ResourcePolicyIssue[] = [];
  const serviceIds = new Set<string>();

  const services = serviceDefinitions.map((service, index) => {
    const id = normalizeIdentifier(service.id);
    if (!id) {
      addPolicyIssue(
        issues,
        "blank-service-id",
        `services[${String(index)}].id`,
      );
    } else if (serviceIds.has(id)) {
      addPolicyIssue(
        issues,
        "duplicate-service-id",
        `services[${String(index)}].id`,
        id,
      );
    } else {
      serviceIds.add(id);
    }
    return { id };
  });

  const knownPurposeIds = new Set(purposeIds);
  const resourceIds = new Set<string>();
  const resources = resourceDefinitions.map((resource, index) => {
    const basePath = `resources[${String(index)}]`;
    const id = normalizeIdentifier(resource.id);
    const serviceId = normalizeIdentifier(resource.serviceId);
    const purposeIds = (resource.purposeIds ?? []).map(normalizeIdentifier);

    if (!id) {
      addPolicyIssue(issues, "blank-resource-id", `${basePath}.id`);
    } else if (resourceIds.has(id)) {
      addPolicyIssue(issues, "duplicate-resource-id", `${basePath}.id`, id);
    } else {
      resourceIds.add(id);
    }

    if (!serviceIds.has(serviceId)) {
      addPolicyIssue(
        issues,
        "unknown-resource-service",
        `${basePath}.serviceId`,
        serviceId,
      );
    }

    const seenPurposeIds = new Set<string>();
    purposeIds.forEach((purposeId, purposeIndex) => {
      if (!knownPurposeIds.has(purposeId)) {
        addPolicyIssue(
          issues,
          "unknown-resource-purpose",
          `${basePath}.purposeIds[${String(purposeIndex)}]`,
          purposeId,
        );
      }
      if (seenPurposeIds.has(purposeId)) {
        addPolicyIssue(
          issues,
          "duplicate-resource-purpose",
          `${basePath}.purposeIds[${String(purposeIndex)}]`,
          purposeId,
        );
      }
      seenPurposeIds.add(purposeId);
    });

    if (resource.access === "optional" && purposeIds.length === 0) {
      addPolicyIssue(
        issues,
        "optional-resource-without-purpose",
        `${basePath}.purposeIds`,
      );
    }
    if (
      resource.access === "declared-exception" &&
      (typeof resource.exceptionReason !== "string" ||
        resource.exceptionReason.trim().length === 0)
    ) {
      addPolicyIssue(
        issues,
        "missing-exception-reason",
        `${basePath}.exceptionReason`,
      );
    }
    // Only an optional resource chooses how its purposes match.
    const purposeMatch = (resource as { readonly purposeMatch?: unknown })
      .purposeMatch;
    if (
      purposeMatch !== undefined &&
      (resource.access !== "optional" ||
        (purposeMatch !== "all" && purposeMatch !== "any"))
    ) {
      addPolicyIssue(
        issues,
        "invalid-purpose-match",
        `${basePath}.purposeMatch`,
      );
    }
    const label =
      resource.access === "declared-exception" ? resource.label : undefined;
    if (
      label !== undefined &&
      (typeof label !== "string" || label.trim().length === 0)
    ) {
      addPolicyIssue(issues, "blank-exception-label", `${basePath}.label`);
    }

    const matchedPurposeIds = stableIdentifiers(new Set(purposeIds));
    const normalizedBase = {
      access: resource.access,
      id,
      purposeIds: matchedPurposeIds,
      // With one purpose, any and all are the same, so only several keep it.
      ...(purposeMatch === "any" && matchedPurposeIds.length > 1
        ? { purposeMatch: "any" as const }
        : {}),
      serviceId,
    };
    return resource.access === "declared-exception"
      ? {
          ...normalizedBase,
          exceptionReason:
            typeof resource.exceptionReason === "string"
              ? resource.exceptionReason.trim()
              : "",
          // Emitted only when declared.
          ...(typeof label === "string" ? { label: label.trim() } : {}),
        }
      : normalizedBase;
  });

  if (issues.length > 0) {
    return deepFreeze({ issues, ok: false });
  }

  const resourcePolicy: DefinedResourcePolicy = {
    purposeIds: stableIdentifiers(purposeIds),
    resources: resources.sort(
      comparePolicyIdentifiers,
    ) as DefinedPolicyResource[],
    services: services.sort(comparePolicyIdentifiers),
  };

  return deepFreeze({ ok: true, resourcePolicy });
}

/**
 * Validates the Policy Catalogue's service and runtime-resource declarations.
 * The resulting published contract is the only resource policy accepted by
 * application projections.
 *
 * @public
 */
export function defineResourcePolicy(
  definition: ResourcePolicyDefinition,
): ResourcePolicyDefinitionResult {
  const detachedDefinition = detachResourcePolicyDefinition(definition);
  return defineResourcePolicyEntries(
    detachedDefinition.policy.purposes.map(({ id }) => id),
    detachedDefinition.resources,
    detachedDefinition.services,
  );
}

export function snapshotDefinedResourcePolicy(
  candidate: unknown,
): DefinedResourcePolicy | undefined {
  const root = resourceDefinitionObject(candidate, "$");
  const budget: ResourcePolicyCaptureBudget = {
    remaining: MAX_RESOURCE_POLICY_GRAPH_ENTRIES,
  };
  const capturedPurposeIds = resourceDefinitionArray(
    resourceDefinitionValue(root, "purposeIds", "purposeIds"),
    "purposeIds",
    budget,
    (purposeId) => purposeId,
  );
  if (
    capturedPurposeIds.some((purposeId) => !normalizedIdentifier(purposeId))
  ) {
    return undefined;
  }
  const entries = detachResourcePolicyEntries(root, budget);
  const services: DefinedPolicyService[] = [];
  for (const service of entries.services) {
    if (!normalizedIdentifier(service.id)) {
      return undefined;
    }
    services.push({ id: service.id });
  }
  const resources: DefinedPolicyResource[] = [];
  for (const resource of entries.resources) {
    if (
      !normalizedIdentifier(resource.id) ||
      !normalizedIdentifier(resource.serviceId) ||
      !normalizedIdentifierArray(resource.purposeIds) ||
      new Set(resource.purposeIds).size !== resource.purposeIds.length
    ) {
      return undefined;
    }
    const base = {
      id: resource.id,
      purposeIds: [...resource.purposeIds],
      serviceId: resource.serviceId,
    };
    if (resource.access === "declared-exception") {
      if (
        typeof resource.exceptionReason !== "string" ||
        resource.exceptionReason.trim().length === 0
      ) {
        return undefined;
      }
      if (
        resource.label !== undefined &&
        (typeof resource.label !== "string" ||
          resource.label.trim().length === 0)
      ) {
        return undefined;
      }
      resources.push({
        ...base,
        access: "declared-exception",
        exceptionReason: resource.exceptionReason,
        ...(resource.label === undefined ? {} : { label: resource.label }),
      });
    } else {
      const { purposeMatch } = resource;
      if (
        purposeMatch !== undefined &&
        (purposeMatch !== "any" || base.purposeIds.length < 2)
      ) {
        return undefined;
      }
      resources.push({
        ...base,
        access: "optional",
        ...(purposeMatch === undefined ? {} : { purposeMatch }),
      });
    }
  }
  return deepFreeze({
    purposeIds: [...capturedPurposeIds] as string[],
    resources,
    services,
  });
}
