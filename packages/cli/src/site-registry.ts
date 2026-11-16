/** A site the operator manages, and the hostnames it is served from. @public */
export interface Site {
  readonly domains: readonly string[];
  readonly name: string;
}

/** Every site an operator manages from one project. @public */
export interface SiteRegistry {
  readonly sites: readonly Site[];
}

/** A request to add a site to the registry. @public */
export interface SiteRegistration {
  readonly domains: readonly string[];
  readonly name: string;
}

/** The site name is not a lowercase slug of at most 63 characters. @public */
export interface InvalidSiteNameIssue {
  readonly kind: "invalid-site-name";
  readonly name: string;
}

/** A domain is not a bare hostname. @public */
export interface InvalidDomainIssue {
  readonly domain: string;
  readonly kind: "invalid-domain";
}

/** A site was registered without any domain. @public */
export interface NoDomainsIssue {
  readonly kind: "no-domains";
}

/** A site with this name is already registered. @public */
export interface DuplicateSiteIssue {
  readonly kind: "duplicate-site";
  readonly name: string;
}

/**
 * A domain already belongs to another site.
 *
 * Each hostname belongs to exactly one site, so there is never a doubt about
 * which policy and which consent records apply to a visitor on it.
 *
 * @public
 */
export interface DomainClaimedIssue {
  readonly domain: string;
  readonly kind: "domain-claimed";
  readonly owner: string;
}

/** @public */
export type SiteRegistrationIssue =
  | DomainClaimedIssue
  | DuplicateSiteIssue
  | InvalidDomainIssue
  | InvalidSiteNameIssue
  | NoDomainsIssue;

/** @public */
export type SiteRegistrationResult =
  | { readonly issue: SiteRegistrationIssue; readonly ok: false }
  | { readonly ok: true; readonly registry: SiteRegistry };

const SITE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_HOSTNAME_LENGTH = 253;

/** @public */
export function emptySiteRegistry(): SiteRegistry {
  return { sites: [] };
}

function isSiteName(name: string): boolean {
  return SITE_NAME.test(name);
}

/**
 * Normalizes a hostname, or returns undefined when it is not one.
 *
 * Only a bare ASCII hostname is accepted: a URL, a port, a path or a wildcard
 * is refused rather than trimmed, so what is stored is exactly what was meant.
 * Internationalized names must be given in their `xn--` form.
 */
function normalizeHostname(domain: string): string | undefined {
  const host = domain.toLowerCase().replace(/\.$/u, "");
  // An empty name needs no check of its own: it has one empty label, and no
  // empty label is a valid one.
  if (host.length > MAX_HOSTNAME_LENGTH) return undefined;
  return host.split(".").every((label) => HOST_LABEL.test(label))
    ? host
    : undefined;
}

/**
 * Adds a site to the registry, or reports why it cannot be added.
 *
 * The registry is never changed in place; a refused registration leaves it as
 * it was.
 *
 * @public
 */
export function registerSite(
  registry: SiteRegistry,
  registration: SiteRegistration,
): SiteRegistrationResult {
  const { name } = registration;
  if (!isSiteName(name)) {
    return { issue: { kind: "invalid-site-name", name }, ok: false };
  }
  if (registry.sites.some((site) => site.name === name)) {
    return { issue: { kind: "duplicate-site", name }, ok: false };
  }
  if (registration.domains.length === 0) {
    return { issue: { kind: "no-domains" }, ok: false };
  }
  const domains: string[] = [];
  for (const domain of registration.domains) {
    const host = normalizeHostname(domain);
    if (host === undefined) {
      return { issue: { domain, kind: "invalid-domain" }, ok: false };
    }
    const owner = siteForDomain(registry, host);
    if (owner !== undefined) {
      return {
        issue: { domain: host, kind: "domain-claimed", owner: owner.name },
        ok: false,
      };
    }
    if (!domains.includes(host)) domains.push(host);
  }
  return {
    ok: true,
    registry: { sites: [...registry.sites, { domains, name }] },
  };
}

/**
 * Finds the site a hostname belongs to.
 *
 * Matching is exact: `shop.example.test` does not belong to a site registered
 * for `example.test`.
 *
 * @public
 */
export function siteForDomain(
  registry: SiteRegistry,
  domain: string,
): Site | undefined {
  const host = normalizeHostname(domain);
  if (host === undefined) return undefined;
  return registry.sites.find((site) => site.domains.includes(host));
}

/**
 * The directory, inside the OpenCookie data directory, that holds a site's
 * policy, findings and evidence.
 *
 * @throws TypeError when the name is not a valid site name, so operator input
 * can never become a path outside the sites directory.
 * @public
 */
export function siteDirectory(name: string): string {
  if (!isSiteName(name)) {
    throw new TypeError(`"${name}" is not a valid site name.`);
  }
  return `sites/${name}`;
}
