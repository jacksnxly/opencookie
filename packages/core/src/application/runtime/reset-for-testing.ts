/** @public */
export interface LocalStateClearer {
  readonly clear: () => Promise<void>;
  readonly id: string;
}

/** @public */
export interface ResetForTestingResult {
  readonly clearedIds: readonly string[];
  readonly outcome: "cleared";
}

/** @public */
export async function resetConsentForTesting(
  clearers: readonly LocalStateClearer[],
): Promise<ResetForTestingResult> {
  const clearedIds: string[] = [];
  for (const clearer of clearers) {
    await clearer.clear();
    clearedIds.push(clearer.id);
  }

  return Object.freeze({
    clearedIds: Object.freeze(clearedIds),
    outcome: "cleared",
  });
}
