import {
  captureDataArray,
  captureDataProperty,
} from "../shared/capture-data-property.js";
import {
  deepFreeze,
  INVISIBLE_DISCLOSURE,
  normalizeIdentifier,
} from "./policy-primitives.js";
import { resolvePolicyGraph } from "../shared/policy-graph.js";

export {
  deepFreeze,
  INVISIBLE_DISCLOSURE,
  normalizeIdentifier,
} from "./policy-primitives.js";

/** @public */
export interface PolicyReferenceDefinition {
  readonly id: string;
}

/** A reference list that contains at least one declared catalogue identity. @public */
export type NonEmptyPolicyReferenceIds = readonly [string, ...string[]];

/** A purpose's label and disclosure in one further language. @public */
export interface PolicyPurposeTranslation {
  readonly disclosure: string;
  readonly label: string;
  /** A canonical language tag, such as `en`, `de-AT` or `zh-Hant-TW`. */
  readonly locale: string;
}

/** @public */
export interface PolicyPurposeDefinition {
  readonly dataCategoryIds: NonEmptyPolicyReferenceIds;
  readonly dependsOn?: readonly string[];
  readonly disclosure: string;
  readonly editorialNote?: string;
  readonly id: string;
  readonly label?: string;
  readonly operationIds: NonEmptyPolicyReferenceIds;
  readonly providerIds: NonEmptyPolicyReferenceIds;
  readonly recipientIds: NonEmptyPolicyReferenceIds;
  readonly retentionIds: NonEmptyPolicyReferenceIds;
  /**
   * The label and disclosure in each further language the site shows. Every
   * purpose carries the same languages.
   */
  readonly translations?: readonly PolicyPurposeTranslation[];
}

/** A category's label in one further language. @public */
export interface PolicyCategoryTranslation {
  readonly label: string;
  /** A canonical language tag, such as `en`, `de-AT` or `zh-Hant-TW`. */
  readonly locale: string;
}

/** @public */
export interface PolicyCategoryDefinition {
  readonly categoryIds?: readonly string[];
  readonly id: string;
  /** The heading shown for the category; without one, its id is shown. */
  readonly label?: string;
  readonly purposeIds?: readonly string[];
  /**
   * The label in each further language the site shows: the same languages
   * every purpose carries. It requires `label`.
   */
  readonly translations?: readonly PolicyCategoryTranslation[];
}

/** @public */
export interface PolicyDefinition {
  readonly categories?: readonly PolicyCategoryDefinition[];
  readonly dataCategories?: readonly PolicyReferenceDefinition[];
  readonly operations?: readonly PolicyReferenceDefinition[];
  readonly presentationRootCategoryIds?: readonly string[];
  readonly providers?: readonly PolicyReferenceDefinition[];
  readonly purposes: readonly PolicyPurposeDefinition[];
  readonly recipients?: readonly PolicyReferenceDefinition[];
  readonly retentions?: readonly PolicyReferenceDefinition[];
}

/** @public */
export interface BlankPurposeIdIssue {
  readonly code: "blank-purpose-id";
  readonly path: string;
}

/** @public */
export interface BlankPurposeDisclosureIssue {
  readonly code: "blank-purpose-disclosure";
  readonly path: string;
}

/** @public */
export interface BlankPurposeLabelIssue {
  readonly code: "blank-purpose-label";
  readonly path: string;
}

/** @public */
export interface BlankCategoryLabelIssue {
  readonly code: "blank-category-label";
  readonly path: string;
}

/** @public */
export interface InvalidPolicyDefinitionEntryIssue {
  readonly code: "invalid-policy-definition-entry";
  readonly path: string;
}

/** @public */
export interface MissingPurposeReferenceIssue {
  readonly code:
    | "missing-purpose-data-category-reference"
    | "missing-purpose-operation-reference"
    | "missing-purpose-provider-reference"
    | "missing-purpose-recipient-reference"
    | "missing-purpose-retention-reference";
  readonly path: string;
}

/** @public */
export interface InvalidPurposeReferenceIssue {
  readonly code:
    | "invalid-purpose-data-category-reference"
    | "invalid-purpose-operation-reference"
    | "invalid-purpose-provider-reference"
    | "invalid-purpose-recipient-reference"
    | "invalid-purpose-retention-reference";
  readonly path: string;
}

/** @public */
export interface DuplicatePurposeReferenceIssue {
  readonly code:
    | "duplicate-purpose-data-category-reference"
    | "duplicate-purpose-operation-reference"
    | "duplicate-purpose-provider-reference"
    | "duplicate-purpose-recipient-reference"
    | "duplicate-purpose-retention-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface DuplicatePurposeIdIssue {
  readonly code: "duplicate-purpose-id";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface BlankPolicyEntityIdIssue {
  readonly code:
    | "blank-category-id"
    | "blank-data-category-id"
    | "blank-operation-id"
    | "blank-provider-id"
    | "blank-recipient-id"
    | "blank-retention-id";
  readonly path: string;
}

/** @public */
export interface DuplicatePolicyEntityIdIssue {
  readonly code:
    | "duplicate-category-id"
    | "duplicate-data-category-id"
    | "duplicate-operation-id"
    | "duplicate-provider-id"
    | "duplicate-recipient-id"
    | "duplicate-retention-id";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface InvalidTranslationLocaleIssue {
  readonly code: "invalid-translation-locale";
  readonly path: string;
}

/** @public */
export interface DuplicateTranslationLocaleIssue {
  readonly code: "duplicate-translation-locale";
  readonly normalizedId: string;
  readonly path: string;
}

/** A translated entry that lacks a language another one has. @public */
export interface IncompleteTranslationsIssue {
  readonly code: "incomplete-translations";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownCategoryReferenceIssue {
  readonly code: "unknown-category-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownPresentationRootCategoryReferenceIssue {
  readonly code: "unknown-presentation-root-category-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownCategoryPurposeReferenceIssue {
  readonly code: "unknown-category-purpose-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface CategoryCycleIssue {
  readonly code: "category-cycle";
  readonly cycle: readonly string[];
  readonly path: string;
}

/** @public */
export interface UnknownPurposeDependencyIssue {
  readonly code: "unknown-purpose-dependency";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface DuplicatePurposeDependencyIssue {
  readonly code: "duplicate-purpose-dependency";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface PurposeDependencyCycleIssue {
  readonly code: "purpose-dependency-cycle";
  readonly cycle: readonly string[];
  readonly path: string;
}

/**
 * @deprecated `definePolicy` no longer emits this issue. It remains exported for
 * source compatibility.
 * @public
 */
export interface UnreachablePurposeIssue {
  readonly code: "unreachable-purpose";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownProviderReferenceIssue {
  readonly code: "unknown-provider-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownOperationReferenceIssue {
  readonly code: "unknown-operation-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownRetentionReferenceIssue {
  readonly code: "unknown-retention-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownRecipientReferenceIssue {
  readonly code: "unknown-recipient-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export interface UnknownDataCategoryReferenceIssue {
  readonly code: "unknown-data-category-reference";
  readonly normalizedId: string;
  readonly path: string;
}

/** @public */
export type PolicyDefinitionIssue =
  | BlankCategoryLabelIssue
  | BlankPurposeIdIssue
  | BlankPurposeDisclosureIssue
  | BlankPurposeLabelIssue
  | BlankPolicyEntityIdIssue
  | CategoryCycleIssue
  | DuplicatePurposeDependencyIssue
  | DuplicatePurposeIdIssue
  | DuplicatePurposeReferenceIssue
  | DuplicatePolicyEntityIdIssue
  | DuplicateTranslationLocaleIssue
  | IncompleteTranslationsIssue
  | InvalidPurposeReferenceIssue
  | InvalidPolicyDefinitionEntryIssue
  | InvalidTranslationLocaleIssue
  | MissingPurposeReferenceIssue
  | PurposeDependencyCycleIssue
  | UnknownCategoryPurposeReferenceIssue
  | UnknownCategoryReferenceIssue
  | UnknownDataCategoryReferenceIssue
  | UnknownOperationReferenceIssue
  | UnknownPresentationRootCategoryReferenceIssue
  | UnknownProviderReferenceIssue
  | UnknownPurposeDependencyIssue
  | UnknownRecipientReferenceIssue
  | UnknownRetentionReferenceIssue
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- Retained in the public issue union for source compatibility.
  | UnreachablePurposeIssue;

/** @public */
export interface DefinedPolicyPurpose {
  readonly dataCategoryIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly disclosure: string;
  readonly editorialNote: string;
  readonly id: string;
  readonly label: string;
  readonly operationIds: readonly string[];
  readonly providerIds: readonly string[];
  readonly recipientIds: readonly string[];
  readonly retentionIds: readonly string[];
  /** Present only when the purpose declares at least one translation. */
  readonly translations?: readonly PolicyPurposeTranslation[];
}

/** @public */
export interface DefinedPolicyCategory {
  readonly categoryIds: readonly string[];
  readonly id: string;
  /** Present only when the category declares one. */
  readonly label?: string;
  readonly purposeIds: readonly string[];
  /** Present only when the category declares at least one translation. */
  readonly translations?: readonly PolicyCategoryTranslation[];
}

/** @public */
export interface DefinedPolicyReference {
  readonly id: string;
}

declare const definedPolicyBrand: unique symbol;

/** @public */
export interface DefinedPolicy {
  readonly [definedPolicyBrand]: true;
  readonly categories: readonly DefinedPolicyCategory[];
  readonly dataCategories: readonly DefinedPolicyReference[];
  readonly operations: readonly DefinedPolicyReference[];
  readonly presentationRootCategoryIds: readonly string[];
  readonly providers: readonly DefinedPolicyReference[];
  readonly purposes: readonly DefinedPolicyPurpose[];
  readonly recipients: readonly DefinedPolicyReference[];
  readonly retentions: readonly DefinedPolicyReference[];
}

/** @public */
export type PolicyDefinitionResult =
  | {
      readonly issues: readonly PolicyDefinitionIssue[];
      readonly ok: false;
    }
  | {
      readonly ok: true;
      readonly policy: DefinedPolicy;
    };

/** Adds a consistently shaped issue without exposing it from a package entrypoint. @internal */
export function addPolicyIssue<
  Issue extends { readonly code: string; readonly path: string },
>(
  issues: Issue[],
  code: Issue["code"],
  path: string,
  normalizedId?: string,
): void {
  issues.push(
    (normalizedId === undefined
      ? { code, path }
      : { code, normalizedId, path }) as Issue,
  );
}

const VALIDATE_POLICY_REFERENCE_DUPLICATES = 0;

function normalizeIdentifiers(
  values: readonly string[] | undefined,
  path: string,
  issues: PolicyDefinitionIssue[],
  reference?:
    PurposeReferenceName | typeof VALIDATE_POLICY_REFERENCE_DUPLICATES,
): string[] {
  if (values === undefined) return [];
  const invalidCode = reference
    ? (`invalid-purpose-${reference}-reference` as const)
    : "invalid-policy-definition-entry";
  if (!Array.isArray(values)) {
    addPolicyIssue(issues, invalidCode, path);
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const entryPath = `${path}[${String(index)}]`;
    const identifier = Object.hasOwn(values, index)
      ? normalizeIdentifier(values[index])
      : "";
    if (
      !identifier ||
      (reference === VALIDATE_POLICY_REFERENCE_DUPLICATES &&
        seen.has(identifier))
    ) {
      addPolicyIssue(issues, invalidCode, entryPath);
    } else if (reference && seen.has(identifier)) {
      addPolicyIssue(
        issues,
        `duplicate-purpose-${reference}-reference`,
        entryPath,
        identifier,
      );
    } else {
      seen.add(identifier);
    }
    normalized.push(identifier);
  }
  return normalized;
}

export function comparePolicyIdentifiers(
  left: Readonly<{ id: string }>,
  right: Readonly<{ id: string }>,
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

interface IndexedCategory extends DefinedPolicyCategory {
  readonly index: number;
}

interface IndexedPurpose extends DefinedPolicyPurpose {
  readonly index: number;
}

function withoutIndex<T extends Readonly<{ index: number }>>(
  value: T,
): Omit<T, "index"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { index: _, ...definition } = value;
  return definition;
}

function findCycles(
  nodes: readonly (IndexedCategory | IndexedPurpose)[],
  field: "categoryIds" | "dependsOn",
): (CategoryCycleIssue | PurposeDependencyCycleIssue)[] {
  const issues: (CategoryCycleIssue | PurposeDependencyCycleIssue)[] = [];
  const stack: string[] = [];
  const categoryCycle = field === "categoryIds";
  resolvePolicyGraph(
    nodes,
    nodes.map(({ id }) => id),
    (node, visit) => {
      stack.push(node.id);

      (node as IndexedCategory & IndexedPurpose)[field].forEach(
        (linkedId, linkedIndex) => {
          if (visit(linkedId) === false) {
            const cycleStart = stack.indexOf(linkedId);
            issues.push({
              code: categoryCycle
                ? "category-cycle"
                : "purpose-dependency-cycle",
              cycle: [...stack.slice(cycleStart), linkedId],
              path: `${categoryCycle ? "categories" : "purposes"}[${String(node.index)}].${field}[${String(linkedIndex)}]`,
            });
          }
        },
      );

      stack.pop();
      return true;
    },
  );

  return issues;
}

function normalizeReferences(
  definitions: readonly PolicyReferenceDefinition[] | undefined,
): DefinedPolicyReference[] {
  return (definitions ?? []).map((definition) => ({
    id: normalizeIdentifier(definition.id),
  }));
}

function validatePolicyEntityIdentifiers(
  definitions: readonly Readonly<{ id: string }>[],
  collection: string,
  entity: "category" | PurposeReferenceName,
  issues: PolicyDefinitionIssue[],
): void {
  const seenIdentifiers = new Set<string>();

  definitions.forEach(({ id }, index) => {
    const path = `${collection}[${String(index)}].id`;
    if (!id) {
      addPolicyIssue(issues, `blank-${entity}-id`, path);
    } else if (seenIdentifiers.has(id)) {
      addPolicyIssue(issues, `duplicate-${entity}-id`, path, id);
    } else {
      seenIdentifiers.add(id);
    }
  });
}

const PURPOSE_REFERENCE_FIELDS = [
  ["providerIds", "provider", "providers"],
  ["operationIds", "operation", "operations"],
  ["retentionIds", "retention", "retentions"],
  ["recipientIds", "recipient", "recipients"],
  ["dataCategoryIds", "data-category", "dataCategories"],
] as const;

/** PURPOSE_REFERENCE_FIELDS indices in alphabetical field order. */
const ALPHABETICAL_REFERENCE_FIELDS = [4, 1, 0, 3, 2] as const;

type PurposeReference = (typeof PURPOSE_REFERENCE_FIELDS)[number];
type PurposeReferenceName = PurposeReference[1];
type PurposeReferenceField = PurposeReference[0];
type PurposeReferenceCollection = PurposeReference[2];

function normalizePurposeReferences(
  purpose: PolicyPurposeDefinition,
  purposePath: string,
  issues: PolicyDefinitionIssue[],
): Record<PurposeReferenceField, string[]> {
  const normalized = {} as Record<PurposeReferenceField, string[]>;
  for (const fieldIndex of ALPHABETICAL_REFERENCE_FIELDS) {
    const [field, reference] = PURPOSE_REFERENCE_FIELDS[fieldIndex];
    normalized[field] = normalizeIdentifiers(
      purpose[field],
      `${purposePath}.${field}`,
      issues,
      reference,
    );
  }
  return normalized;
}

const POLICY_DEFINITION_COLLECTIONS = [
  "purposes",
  "categories",
  "providers",
  "operations",
  "retentions",
  "recipients",
  "dataCategories",
] as const;

const POLICY_ENTRY_FIELDS = {
  categories: ["categoryIds", "id", "label", "purposeIds", "translations"],
  dataCategories: ["id"],
  operations: ["id"],
  providers: ["id"],
  purposes: [
    "dataCategoryIds",
    "dependsOn",
    "disclosure",
    "editorialNote",
    "id",
    "label",
    "operationIds",
    "providerIds",
    "recipientIds",
    "retentionIds",
    "translations",
  ],
  recipients: ["id"],
  retentions: ["id"],
} as const;

const TRANSLATION_FIELDS = ["disclosure", "label", "locale"] as const;

const MAX_POLICY_GRAPH_ENTRIES = 10_000;

interface PolicyGraphCaptureBudget {
  remaining: number;
}

function ownPolicyValue(
  source: object,
  field: string,
  path: string,
  issues: PolicyDefinitionIssue[],
  rejectInherited = true,
): PropertyDescriptor | null | undefined {
  const captured = captureDataProperty(source, field, rejectInherited);
  if (captured === undefined) {
    addPolicyIssue(issues, "invalid-policy-definition-entry", path);
  }
  return captured;
}

function detachPolicyArray(
  value: unknown,
  path: string,
  issues: PolicyDefinitionIssue[],
  budget: PolicyGraphCaptureBudget,
  fields?: readonly string[],
): unknown {
  return captureDataArray(
    value,
    budget,
    (entry, index) => {
      if (fields === undefined || entry === null || typeof entry !== "object") {
        return entry;
      }
      const captured: Record<string, unknown> = {};
      const entryPath = `${path}[${String(index)}]`;
      for (const field of fields) {
        const fieldPath = `${entryPath}.${field}`;
        const fieldCapture = ownPolicyValue(entry, field, fieldPath, issues);
        captured[field] =
          fieldCapture === undefined
            ? undefined
            : field === "dependsOn" ||
                field.endsWith("Ids") ||
                field === "translations"
              ? detachPolicyArray(
                  fieldCapture?.value,
                  fieldPath,
                  issues,
                  budget,
                  field === "translations" ? TRANSLATION_FIELDS : undefined,
                )
              : fieldCapture?.value;
      }
      return captured;
    },
    (index) => {
      addPolicyIssue(
        issues,
        "invalid-policy-definition-entry",
        index === undefined ? path : `${path}[${String(index)}]`,
      );
    },
    true,
    true,
  );
}

function detachPolicyDefinition(
  input: unknown,
):
  | { readonly definition: PolicyDefinition; readonly issues: readonly [] }
  | { readonly issues: readonly PolicyDefinitionIssue[] } {
  if (input === null || typeof input !== "object") {
    return {
      issues: [{ code: "invalid-policy-definition-entry", path: "$" }],
    };
  }
  const issues: PolicyDefinitionIssue[] = [];
  const budget: PolicyGraphCaptureBudget = {
    remaining: MAX_POLICY_GRAPH_ENTRIES,
  };
  const definition: Record<string, unknown> = {};
  for (const field of POLICY_DEFINITION_COLLECTIONS) {
    const captured = ownPolicyValue(input, field, field, issues);
    definition[field] =
      captured === undefined
        ? undefined
        : detachPolicyArray(
            captured?.value,
            field,
            issues,
            budget,
            POLICY_ENTRY_FIELDS[field],
          );
  }
  const roots = ownPolicyValue(
    input,
    "presentationRootCategoryIds",
    "presentationRootCategoryIds",
    issues,
  );
  definition["presentationRootCategoryIds"] =
    roots === undefined
      ? undefined
      : detachPolicyArray(
          roots?.value,
          "presentationRootCategoryIds",
          issues,
          budget,
        );

  return issues.length
    ? { issues }
    : { definition: definition as unknown as PolicyDefinition, issues: [] };
}

function validateDefinitionCollections(
  definition: PolicyDefinition,
): InvalidPolicyDefinitionEntryIssue[] {
  const candidate: unknown = definition;
  if (candidate === null || typeof candidate !== "object") {
    return [{ code: "invalid-policy-definition-entry", path: "$" }];
  }
  const issues: InvalidPolicyDefinitionEntryIssue[] = [];
  for (const field of POLICY_DEFINITION_COLLECTIONS) {
    const collection = definition[field];
    if (!Array.isArray(collection)) {
      if (field === "purposes" || collection !== undefined) {
        addPolicyIssue(issues, "invalid-policy-definition-entry", field);
      }
      continue;
    }
    for (let index = 0; index < collection.length; index++) {
      if (!Object.hasOwn(collection, index)) {
        addPolicyIssue(
          issues,
          "invalid-policy-definition-entry",
          `${field}[${String(index)}]`,
        );
        continue;
      }
      const entry: unknown = collection[index];
      if (entry === null || typeof entry !== "object") {
        addPolicyIssue(
          issues,
          "invalid-policy-definition-entry",
          `${field}[${String(index)}]`,
        );
      }
    }
  }
  return issues;
}

function validatePurposeReferences(
  purpose: IndexedPurpose,
  references: readonly ReadonlySet<string>[],
  issues: PolicyDefinitionIssue[],
): void {
  const purposePath = `purposes[${String(purpose.index)}]`;
  if (INVISIBLE_DISCLOSURE.test(purpose.disclosure)) {
    addPolicyIssue(
      issues,
      "blank-purpose-disclosure",
      `${purposePath}.disclosure`,
    );
  }
  if (INVISIBLE_DISCLOSURE.test(purpose.label)) {
    addPolicyIssue(issues, "blank-purpose-label", `${purposePath}.label`);
  }

  PURPOSE_REFERENCE_FIELDS.forEach(([field, reference], fieldIndex) => {
    const identifiers = purpose[field];
    const knownIdentifiers = references[fieldIndex] as ReadonlySet<string>;
    if (!identifiers.length) {
      addPolicyIssue(
        issues,
        `missing-purpose-${reference}-reference`,
        `${purposePath}.${field}`,
      );
    }
    identifiers.forEach((identifier, referenceIndex) => {
      if (!knownIdentifiers.has(identifier)) {
        addPolicyIssue(
          issues,
          `unknown-${reference}-reference`,
          `${purposePath}.${field}[${String(referenceIndex)}]`,
          identifier,
        );
      }
    });
  });
}

/**
 * A canonical language tag: a lowercase language, then an optional titlecase
 * script and an uppercase or numeric region. It is compared as written and
 * never normalized, so every engine derives the same digests from it.
 */
const CANONICAL_LOCALE =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/u;

type TranslatedText = "disclosure" | "label";

type Translation<Field extends TranslatedText> = Record<Field, string> & {
  locale: string;
};

function normalizeTranslations<Field extends TranslatedText>(
  value: unknown,
  path: string,
  fields: readonly Field[],
  blankCode: (
    field: Field,
  ) =>
    "blank-category-label" | "blank-purpose-disclosure" | "blank-purpose-label",
  issues: PolicyDefinitionIssue[],
): Translation<Field>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addPolicyIssue(issues, "invalid-policy-definition-entry", path);
    return undefined;
  }
  const seen = new Set<string>();
  const translations: Translation<Field>[] = [];
  for (let index = 0; index < value.length; index++) {
    const entryPath = `${path}[${String(index)}]`;
    const entry: unknown = Object.hasOwn(value, index)
      ? value[index]
      : undefined;
    if (entry === null || typeof entry !== "object") {
      addPolicyIssue(issues, "invalid-policy-definition-entry", entryPath);
      continue;
    }
    const { locale } = entry as Record<string, unknown>;
    if (typeof locale !== "string" || !CANONICAL_LOCALE.test(locale)) {
      addPolicyIssue(
        issues,
        "invalid-translation-locale",
        `${entryPath}.locale`,
      );
    } else if (seen.has(locale)) {
      addPolicyIssue(
        issues,
        "duplicate-translation-locale",
        `${entryPath}.locale`,
        locale,
      );
    } else {
      seen.add(locale);
    }
    // The text fields first, in the order given, then the locale.
    const translation = {} as Translation<Field>;
    for (const field of fields) {
      const text = (entry as Record<string, unknown>)[field];
      if (typeof text !== "string") {
        addPolicyIssue(
          issues,
          "invalid-policy-definition-entry",
          `${entryPath}.${field}`,
        );
      } else if (INVISIBLE_DISCLOSURE.test(text.trim())) {
        addPolicyIssue(issues, blankCode(field), `${entryPath}.${field}`);
      }
      (translation as Record<string, string>)[field] =
        typeof text === "string" ? text.trim() : "";
    }
    translation.locale = typeof locale === "string" ? locale : "";
    translations.push(translation);
  }
  return translations.length
    ? translations.sort((left, right) =>
        left.locale < right.locale ? -1 : left.locale > right.locale ? 1 : 0,
      )
    : undefined;
}

/** A category's label is its own; unlike a purpose's, it never defaults. */
function normalizeCategoryLabel(
  label: unknown,
  categoryPath: string,
  issues: PolicyDefinitionIssue[],
): string | undefined {
  if (label === undefined) return undefined;
  if (typeof label !== "string") {
    addPolicyIssue(
      issues,
      "invalid-policy-definition-entry",
      `${categoryPath}.label`,
    );
    return undefined;
  }
  const trimmed = label.trim();
  if (INVISIBLE_DISCLOSURE.test(trimmed)) {
    addPolicyIssue(issues, "blank-category-label", `${categoryPath}.label`);
  }
  return trimmed;
}

/** Refuses a translated entry that lacks a language another one has. */
function validateTranslationCompleteness(
  entries: readonly {
    readonly path: string;
    readonly translations?: readonly { readonly locale: string }[];
  }[],
  issues: PolicyDefinitionIssue[],
): void {
  const locales = new Set(
    entries.flatMap(({ translations = [] }) =>
      translations.map(({ locale }) => locale),
    ),
  );
  for (const { path, translations = [] } of entries) {
    const present = new Set(translations.map(({ locale }) => locale));
    for (const locale of [...locales].sort()) {
      if (!present.has(locale)) {
        addPolicyIssue(issues, "incomplete-translations", path, locale);
      }
    }
  }
}

/** @public */
export function definePolicy(
  definition: PolicyDefinition,
): PolicyDefinitionResult {
  const detached = detachPolicyDefinition(definition);
  if (!("definition" in detached)) {
    return deepFreeze({ issues: detached.issues, ok: false });
  }
  const detachedDefinition = detached.definition;
  const issues: PolicyDefinitionIssue[] =
    validateDefinitionCollections(detachedDefinition);
  if (issues.length) return deepFreeze({ issues, ok: false });
  const seenPurposeIds = new Set<string>();
  const purposes: IndexedPurpose[] = detachedDefinition.purposes.map(
    (purpose, index) => {
      const normalizedId = normalizeIdentifier(purpose.id);
      const purposePath = `purposes[${String(index)}]`;
      const path = `${purposePath}.id`;

      if (!normalizedId) {
        addPolicyIssue(issues, "blank-purpose-id", path);
      } else if (seenPurposeIds.has(normalizedId)) {
        addPolicyIssue(issues, "duplicate-purpose-id", path, normalizedId);
      } else {
        seenPurposeIds.add(normalizedId);
      }
      if (
        purpose.editorialNote !== undefined &&
        typeof purpose.editorialNote !== "string"
      ) {
        addPolicyIssue(
          issues,
          "invalid-policy-definition-entry",
          `${purposePath}.editorialNote`,
        );
      }

      const translations = normalizeTranslations(
        purpose.translations,
        `${purposePath}.translations`,
        ["disclosure", "label"],
        (field) => `blank-purpose-${field}`,
        issues,
      );
      return {
        ...normalizePurposeReferences(purpose, purposePath, issues),
        dependsOn: normalizeIdentifiers(
          purpose.dependsOn,
          `${purposePath}.dependsOn`,
          issues,
        ),
        disclosure:
          typeof purpose.disclosure === "string"
            ? purpose.disclosure.trim()
            : "",
        editorialNote:
          typeof purpose.editorialNote === "string"
            ? purpose.editorialNote
            : "",
        id: normalizedId,
        index,
        label:
          purpose.label === undefined
            ? normalizedId
            : typeof purpose.label === "string"
              ? purpose.label.trim()
              : "",
        // Emitted only when declared, so a policy without translations keeps
        // its exact digests.
        ...(translations === undefined ? {} : { translations }),
      };
    },
  );

  const categories: IndexedCategory[] = (
    detachedDefinition.categories ?? []
  ).map((category, index) => {
    const categoryPath = `categories[${String(index)}]`;
    const label = normalizeCategoryLabel(category.label, categoryPath, issues);
    let translations: PolicyCategoryTranslation[] | undefined;
    if (category.translations !== undefined && label === undefined) {
      addPolicyIssue(
        issues,
        "invalid-policy-definition-entry",
        `${categoryPath}.translations`,
      );
    } else {
      translations = normalizeTranslations(
        category.translations,
        `${categoryPath}.translations`,
        ["label"],
        () => "blank-category-label",
        issues,
      );
    }
    return {
      categoryIds: normalizeIdentifiers(
        category.categoryIds,
        `${categoryPath}.categoryIds`,
        issues,
        VALIDATE_POLICY_REFERENCE_DUPLICATES,
      ),
      id: normalizeIdentifier(category.id),
      index,
      purposeIds: normalizeIdentifiers(
        category.purposeIds,
        `${categoryPath}.purposeIds`,
        issues,
        VALIDATE_POLICY_REFERENCE_DUPLICATES,
      ),
      // Emitted only when declared, so existing policies keep their digests.
      ...(label === undefined ? {} : { label }),
      ...(translations === undefined ? {} : { translations }),
    };
  });
  const entityCollections = Object.fromEntries(
    PURPOSE_REFERENCE_FIELDS.map(([, , collection]) => [
      collection,
      normalizeReferences(detachedDefinition[collection]),
    ]),
  ) as Record<PurposeReferenceCollection, DefinedPolicyReference[]>;
  const presentationRootCategoryIds = normalizeIdentifiers(
    detachedDefinition.presentationRootCategoryIds,
    "presentationRootCategoryIds",
    issues,
    VALIDATE_POLICY_REFERENCE_DUPLICATES,
  );

  validatePolicyEntityIdentifiers(categories, "categories", "category", issues);
  for (const fieldIndex of ALPHABETICAL_REFERENCE_FIELDS) {
    const [, entity, collection] = PURPOSE_REFERENCE_FIELDS[fieldIndex];
    validatePolicyEntityIdentifiers(
      entityCollections[collection],
      collection,
      entity,
      issues,
    );
  }

  if (issues.length) return deepFreeze({ issues, ok: false });

  const references = PURPOSE_REFERENCE_FIELDS.map(
    ([, , collection]) =>
      new Set(
        entityCollections[collection]
          .sort(comparePolicyIdentifiers)
          .map(({ id }) => id),
      ),
  );
  for (const purpose of purposes) {
    validatePurposeReferences(purpose, references, issues);
  }

  const purposeIds = new Set(purposes.map(({ id }) => id));
  for (const purpose of purposes) {
    const seenDependencies = new Set<string>();
    purpose.dependsOn.forEach((dependencyId, dependencyIndex) => {
      const path = `purposes[${String(purpose.index)}].dependsOn[${String(dependencyIndex)}]`;
      if (!purposeIds.has(dependencyId)) {
        addPolicyIssue(
          issues,
          "unknown-purpose-dependency",
          path,
          dependencyId,
        );
      } else if (seenDependencies.has(dependencyId)) {
        addPolicyIssue(
          issues,
          "duplicate-purpose-dependency",
          path,
          dependencyId,
        );
      } else {
        seenDependencies.add(dependencyId);
      }
    });
  }
  issues.push(...findCycles(purposes, "dependsOn"));

  const categoryIds = new Set(categories.map(({ id }) => id));

  for (const category of categories) {
    category.categoryIds.forEach((childId, childIndex) => {
      if (!categoryIds.has(childId)) {
        addPolicyIssue(
          issues,
          "unknown-category-reference",
          `categories[${String(category.index)}].categoryIds[${String(childIndex)}]`,
          childId,
        );
      }
    });
    category.purposeIds.forEach((purposeId, purposeIndex) => {
      if (!purposeIds.has(purposeId)) {
        addPolicyIssue(
          issues,
          "unknown-category-purpose-reference",
          `categories[${String(category.index)}].purposeIds[${String(purposeIndex)}]`,
          purposeId,
        );
      }
    });
  }
  issues.push(...findCycles(categories, "categoryIds"));

  presentationRootCategoryIds.forEach((rootCategoryId, rootIndex) => {
    if (!categoryIds.has(rootCategoryId)) {
      addPolicyIssue(
        issues,
        "unknown-presentation-root-category-reference",
        `presentationRootCategoryIds[${String(rootIndex)}]`,
        rootCategoryId,
      );
    }
  });
  validateTranslationCompleteness(
    [
      ...purposes.map(({ index, translations }) => ({
        path: `purposes[${String(index)}].translations`,
        ...(translations === undefined ? {} : { translations }),
      })),
      // A category without a label shows its id in every language.
      ...categories
        .filter(({ label }) => label !== undefined)
        .map(({ index, translations }) => ({
          path: `categories[${String(index)}].translations`,
          ...(translations === undefined ? {} : { translations }),
        })),
    ],
    issues,
  );

  if (issues.length) return deepFreeze({ issues, ok: false });

  for (const purpose of purposes) {
    for (const [field] of PURPOSE_REFERENCE_FIELDS) {
      (purpose[field] as string[]).sort();
    }
    (purpose.dependsOn as string[]).sort();
  }
  // Categories and their purposes keep the operator's order, which is the
  // order a visitor reads them in; identity hashes them sorted instead.

  return deepFreeze({
    ok: true,
    policy: {
      categories: categories.map(withoutIndex).sort(comparePolicyIdentifiers),
      dataCategories: entityCollections.dataCategories,
      operations: entityCollections.operations,
      presentationRootCategoryIds,
      providers: entityCollections.providers,
      purposes: purposes.map(withoutIndex).sort(comparePolicyIdentifiers),
      recipients: entityCollections.recipients,
      retentions: entityCollections.retentions,
    } as unknown as DefinedPolicy,
  });
}
