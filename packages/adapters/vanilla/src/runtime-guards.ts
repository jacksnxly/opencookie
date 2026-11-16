import type { EnforcementOperationResult } from "@opencookie-dev/core/infrastructure";

export function enforcementResult(
  ...irreversibleEffects: string[]
): EnforcementOperationResult {
  return Object.freeze({
    irreversibleEffects: Object.freeze(irreversibleEffects),
  });
}

export function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} cannot be blank.`);
  }
  return value.trim();
}

export function resolveDocument(
  configured: Document | undefined,
  errorMessage: string,
): Document {
  const resolved =
    configured ?? (typeof document === "undefined" ? undefined : document);
  if (resolved === undefined) {
    throw new Error(errorMessage);
  }
  return resolved;
}

export function documentResolver(
  configured: Document | undefined,
  errorMessage: string,
): () => Document {
  return () => resolveDocument(configured, errorMessage);
}
