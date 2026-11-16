import { disclose, type DisclosedReference } from "./disclosure.js";
import {
  projectPolicySections,
  type PolicyCategoryTranslation,
  type PolicyPurposeTranslation,
} from "@opencookie-dev/core/domain";

import type { PolicyPublication } from "./publication-log.js";

/** One disclosed purpose as it appears in a public cookie declaration. @public */
export interface DeclarationPurpose {
  /** Data categories in plain language, empty when none were declared. */
  readonly dataCategories: readonly DisclosedReference[];
  readonly operations: readonly DisclosedReference[];
  readonly providers: readonly DisclosedReference[];
  readonly recipients: readonly DisclosedReference[];
  readonly retentions: readonly DisclosedReference[];
  readonly dataCategoryIds: readonly string[];
  /**
   * The basis the operator asserts for this purpose, when they declared one.
   *
   * OpenCookie publishes what the operator stated and never derives or defaults
   * it. Its absence means nothing was declared, not that consent applies.
   */
  readonly lawfulBasis?: string;
  readonly disclosure: string;
  readonly id: string;
  readonly label: string;
  readonly operationIds: readonly string[];
  readonly providerIds: readonly string[];
  readonly recipientIds: readonly string[];
  readonly retentionIds: readonly string[];
  /** The label and disclosure in each further language, when declared. */
  readonly translations?: readonly PolicyPurposeTranslation[];
}

/** One presentation group of disclosed purposes. @public */
export interface DeclarationSection {
  readonly categoryId: string | null;
  /** The category's heading, when the policy gives it one. */
  readonly categoryLabel?: string;
  /** The heading in each further language, when declared. */
  readonly categoryTranslations?: readonly PolicyCategoryTranslation[];
  readonly purposes: readonly DeclarationPurpose[];
}

/**
 * A public cookie declaration bound to the exact publication it describes.
 *
 * @public
 */
export interface PolicyDeclaration {
  readonly catalogueDigest: string;
  readonly catalogueRevision: string;
  readonly decisionSurfaceDigest: string;
  readonly policyVersion: string;
  readonly publicationId: string;
  readonly sections: readonly DeclarationSection[];
}

/**
 * Projects a publication into the declaration an operator publishes.
 *
 * The declaration carries the publication identifier and both policy digests, so
 * a reader can tell exactly which published policy it describes rather than
 * trusting that it is current.
 *
 * @public
 */
export function buildPolicyDeclaration(
  publication: PolicyPublication,
): PolicyDeclaration {
  const { snapshot } = publication;
  const purposesById = new Map(
    snapshot.policy.purposes.map((purpose) => [purpose.id, purpose]),
  );
  const categoriesById = new Map(
    snapshot.policy.categories.map((category) => [category.id, category]),
  );
  const sections = projectPolicySections(snapshot.policy).map((section) => {
    const category =
      section.categoryId === null
        ? undefined
        : categoriesById.get(section.categoryId);
    return {
      categoryId: section.categoryId,
      ...(category?.label === undefined
        ? {}
        : { categoryLabel: category.label }),
      ...(category?.translations === undefined
        ? {}
        : { categoryTranslations: category.translations }),
      purposes: section.purposeIds.flatMap((purposeId) => {
        const purpose = purposesById.get(purposeId);
        if (purpose === undefined) return [];
        return [
          {
            dataCategories: disclose(
              purpose.dataCategoryIds,
              publication.terms,
            ),
            dataCategoryIds: purpose.dataCategoryIds,
            disclosure: purpose.disclosure,
            operations: disclose(purpose.operationIds, publication.terms),
            providers: disclose(purpose.providerIds, publication.terms),
            recipients: disclose(purpose.recipientIds, publication.terms),
            retentions: disclose(purpose.retentionIds, publication.terms),
            id: purpose.id,
            ...(publication.lawfulBases?.[purpose.id] === undefined
              ? {}
              : { lawfulBasis: publication.lawfulBases[purpose.id] }),
            label: purpose.label,
            operationIds: purpose.operationIds,
            providerIds: purpose.providerIds,
            recipientIds: purpose.recipientIds,
            retentionIds: purpose.retentionIds,
            ...(purpose.translations === undefined
              ? {}
              : { translations: purpose.translations }),
          },
        ];
      }),
    };
  });
  return {
    catalogueDigest: snapshot.catalogueDigest,
    catalogueRevision: snapshot.catalogueRevision,
    decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
    policyVersion: snapshot.policyVersion,
    publicationId: publication.publicationId,
    sections,
  };
}
