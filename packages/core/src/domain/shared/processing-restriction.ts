/** @public */
export interface ProcessingRestrictionSet {
  readonly purposeIds: readonly string[];
  readonly resourceIds: readonly string[];
  readonly serviceIds: readonly string[];
  readonly source: "gpc";
}
