/** @public */
export type OpenCookieLayer = "domain" | "application" | "infrastructure";

/** @public */
export interface DomainContract {
  readonly layer: "domain";
}
