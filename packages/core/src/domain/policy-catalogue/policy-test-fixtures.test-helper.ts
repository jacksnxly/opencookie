import {
  type PolicyDefinition,
  type PolicyPurposeDefinition,
} from "./define-policy.js";

export type TestPolicyPurposeDefinition = Readonly<
  Pick<PolicyPurposeDefinition, "id"> &
    Partial<Omit<PolicyPurposeDefinition, "id">>
>;

export type TestPolicyDefinition = Readonly<
  Omit<PolicyDefinition, "purposes"> & {
    readonly purposes: readonly TestPolicyPurposeDefinition[];
  }
>;

function fallbackReferenceId(
  definitions: readonly Readonly<{ id: string }>[] | undefined,
  fallback: string,
): string {
  return (
    definitions
      ?.map(({ id }) => id)
      .sort((left, right) => left.localeCompare(right))[0] ?? fallback
  );
}

export function completeTestPolicyDefinition(
  definition: TestPolicyDefinition,
): PolicyDefinition {
  const dataCategoryId = fallbackReferenceId(
    definition.dataCategories,
    "test-usage-data",
  );
  const operationId = fallbackReferenceId(
    definition.operations,
    "test-processing-operation",
  );
  const providerId = fallbackReferenceId(
    definition.providers,
    "test-service-provider",
  );
  const recipientId = fallbackReferenceId(
    definition.recipients,
    "test-site-operator",
  );
  const retentionId = fallbackReferenceId(
    definition.retentions,
    "test-retention-period",
  );

  return {
    dataCategories: definition.dataCategories ?? [{ id: dataCategoryId }],
    operations: definition.operations ?? [{ id: operationId }],
    providers: definition.providers ?? [{ id: providerId }],
    recipients: definition.recipients ?? [{ id: recipientId }],
    retentions: definition.retentions ?? [{ id: retentionId }],
    ...definition,
    purposes: definition.purposes.map((purpose) => ({
      dataCategoryIds: [dataCategoryId],
      disclosure: `Test-only disclosure for ${purpose.id}.`,
      operationIds: [operationId],
      providerIds: [providerId],
      recipientIds: [recipientId],
      retentionIds: [retentionId],
      ...purpose,
    })),
  };
}
