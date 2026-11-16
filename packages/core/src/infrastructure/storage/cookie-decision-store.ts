import {
  decisionStoreClearPrecondition,
  decisionStorePreconditionFailure,
  type DecisionStore,
  type DecisionStoreConditionalClearResult,
  type DecisionStoreWriteResult,
} from "../../application/persistence/persist-grant.js";
import type {
  DecisionStoreReadResult,
  PersistedConsentState,
} from "../../application/runtime/initialize-consent.js";
import {
  decodeDecisionRecordEnvelope,
  encodeDecisionRecordEnvelope,
} from "./decision-record-codec.js";

/** @public */
export interface CookieJarLike {
  readonly read: () => string;
  readonly write: (serializedCookie: string) => void;
}

/** @public */
export interface RegistrableDomainResolver {
  readonly resolve: (canonicalHostname: string) => string | null;
}

/** @public */
export type CookieDomainScope =
  | { readonly kind: "host-only" }
  | {
      readonly domain: string;
      readonly kind: "shared";
      readonly registrableDomainResolver: RegistrableDomainResolver;
    };

/** @public */
export interface CookieDecisionStoreOptions {
  readonly hostname: string;
  readonly jar: CookieJarLike;
  readonly key: string;
  readonly maxAgeSeconds?: number;
  /** Site-wide cookie path. Non-root runtime values are rejected. */
  readonly path?: "/";
  readonly schemaVersion: number;
  readonly scope?: CookieDomainScope;
  readonly secure?: boolean;
}

/** @public */
export interface CookieDecisionStore extends DecisionStore {
  readonly clear: () => Promise<void>;
}

interface CookieStoreSnapshot {
  readonly encodedValue: string | undefined;
  readonly result: DecisionStoreReadResult;
}

function promiseFrom<Result>(operation: () => Result): Promise<Result> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(
      error instanceof Error
        ? error
        : new Error("Decision cookie operation failed."),
    );
  }
}

interface CookieScope {
  readonly domain: string | undefined;
  readonly maxAgeSeconds: number | undefined;
  readonly secure: boolean;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_DNS_HOST_CHARACTERS = "/:;,%=?#@[]\\";
const FORBIDDEN_IPV6_HOST_CHARACTERS = "/;,%=?#@\\";
const IPV4_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}$/;

interface CanonicalHost {
  readonly kind: "dns" | "ipv4" | "ipv6";
  readonly value: string;
}

interface RuntimeSharedScope {
  readonly domain: unknown;
  readonly registrableDomainResolver: unknown;
}

function invalidHost(label: "domain" | "hostname"): TypeError {
  return new TypeError(
    `Cookie ${label} must be a valid WHATWG host without delimiters or a trailing dot.`,
  );
}

function containsForbiddenHostCharacter(
  input: string,
  forbiddenCharacters: string,
): boolean {
  for (const character of input) {
    const codePoint = character.charCodeAt(0);
    if (
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      forbiddenCharacters.includes(character)
    ) {
      return true;
    }
  }
  return false;
}

function containsNonAsciiCharacter(input: string): boolean {
  for (const character of input) {
    if (character.charCodeAt(0) > 0x7f) return true;
  }
  return false;
}

function canonicalizeHost(
  value: unknown,
  label: "domain" | "hostname",
): CanonicalHost {
  if (typeof value !== "string") throw invalidHost(label);
  let input = value;
  if (label === "domain" && input.startsWith(".")) {
    input = input.slice(1);
  }
  if (!input || input.startsWith(".") || input.endsWith(".")) {
    throw invalidHost(label);
  }

  const bracketedIpv6 = input.startsWith("[") && input.endsWith("]");
  const forbiddenCharacters = bracketedIpv6
    ? FORBIDDEN_IPV6_HOST_CHARACTERS
    : FORBIDDEN_DNS_HOST_CHARACTERS;
  if (containsForbiddenHostCharacter(input, forbiddenCharacters)) {
    throw invalidHost(label);
  }

  let hostname: string;
  try {
    const parsed = new URL(`http://${input}/`);
    if (parsed.port || parsed.pathname !== "/") throw invalidHost(label);
    hostname = parsed.hostname;
  } catch {
    throw invalidHost(label);
  }

  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return { kind: "ipv6", value: hostname };
  }
  if (IPV4_ADDRESS.test(hostname)) {
    return { kind: "ipv4", value: hostname };
  }
  if (hostname.length > 253 || containsNonAsciiCharacter(hostname)) {
    throw invalidHost(label);
  }
  const labels = hostname.split(".");
  if (
    labels.some(
      (candidate) =>
        candidate.length === 0 ||
        candidate.length > 63 ||
        !DNS_LABEL.test(candidate),
    )
  ) {
    throw invalidHost(label);
  }
  return { kind: "dns", value: hostname };
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function isRegistrableDomainResolver(
  value: unknown,
): value is RegistrableDomainResolver {
  return (
    typeof value === "object" &&
    value !== null &&
    "resolve" in value &&
    typeof value.resolve === "function"
  );
}

function validateSharedRequest(
  hostname: CanonicalHost,
  domain: unknown,
): CanonicalHost {
  if (hostname.kind !== "dns") {
    throw new TypeError("Cookie sharing is not supported for IP addresses.");
  }
  if (isLocalhost(hostname.value)) {
    throw new TypeError(
      "Cookie sharing is not supported for localhost or its descendants.",
    );
  }

  const requestedDomain = canonicalizeHost(domain, "domain");
  if (requestedDomain.kind !== "dns") {
    throw new TypeError("Cookie sharing is not supported for IP addresses.");
  }
  if (isLocalhost(requestedDomain.value)) {
    throw new TypeError(
      "Cookie sharing is not supported for localhost or its descendants.",
    );
  }
  if (!domainMatches(hostname.value, requestedDomain.value)) {
    throw new TypeError(
      "Cookie domain must be a parent domain of the hostname.",
    );
  }

  return requestedDomain;
}

function validateRegistrableBoundary(
  hostname: CanonicalHost,
  requestedDomain: CanonicalHost,
  resolvedValue: unknown,
): string {
  if (typeof resolvedValue !== "string" || !resolvedValue) {
    throw new TypeError(
      "Cookie registrable-domain resolver did not resolve the hostname.",
    );
  }

  const registrableDomain = canonicalizeHost(resolvedValue, "domain");
  if (
    registrableDomain.kind !== "dns" ||
    isLocalhost(registrableDomain.value) ||
    !domainMatches(hostname.value, registrableDomain.value)
  ) {
    throw new TypeError(
      "Cookie registrable-domain resolver returned an invalid boundary.",
    );
  }
  if (!domainMatches(requestedDomain.value, registrableDomain.value)) {
    throw new TypeError(
      "Cookie domain must not be above the registrable domain boundary.",
    );
  }

  return requestedDomain.value;
}

function resolveSharedDomain(
  hostname: CanonicalHost,
  scope: RuntimeSharedScope,
): string {
  const requestedDomain = validateSharedRequest(hostname, scope.domain);

  const resolver = scope.registrableDomainResolver;
  if (!isRegistrableDomainResolver(resolver)) {
    throw new TypeError(
      "Cookie shared scope requires a registrable-domain resolver.",
    );
  }

  let resolvedValue: string | null;
  try {
    resolvedValue = resolver.resolve(hostname.value);
  } catch {
    throw new TypeError(
      "Cookie registrable-domain resolver could not resolve the hostname.",
    );
  }
  return validateRegistrableBoundary(hostname, requestedDomain, resolvedValue);
}

function validateOptions(options: CookieDecisionStoreOptions): CookieScope {
  if (!COOKIE_NAME.test(options.key)) {
    throw new TypeError("Cookie key must be a valid HTTP cookie name.");
  }
  if (
    !Number.isSafeInteger(options.schemaVersion) ||
    options.schemaVersion < 1
  ) {
    throw new TypeError("Cookie schema version must be a positive integer.");
  }
  const hostname = canonicalizeHost(options.hostname, "hostname");

  const runtimePath: unknown = options.path;
  if (runtimePath !== undefined && runtimePath !== "/") {
    throw new TypeError("Cookie path must be exactly / for site-wide consent.");
  }
  if (
    options.maxAgeSeconds !== undefined &&
    (!Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 1)
  ) {
    throw new TypeError("Cookie max age must be a positive integer.");
  }

  const configuredScope: unknown = options.scope ?? { kind: "host-only" };
  if (
    typeof configuredScope !== "object" ||
    configuredScope === null ||
    !("kind" in configuredScope)
  ) {
    throw new TypeError("Cookie scope kind must be host-only or shared.");
  }
  if (configuredScope.kind === "host-only") {
    return {
      domain: undefined,
      maxAgeSeconds: options.maxAgeSeconds,
      secure: options.secure ?? false,
    };
  }
  if (configuredScope.kind !== "shared") {
    throw new TypeError("Cookie scope kind must be host-only or shared.");
  }

  return {
    domain: resolveSharedDomain(hostname, {
      domain: "domain" in configuredScope ? configuredScope.domain : undefined,
      registrableDomainResolver:
        "registrableDomainResolver" in configuredScope
          ? configuredScope.registrableDomainResolver
          : undefined,
    }),
    maxAgeSeconds: options.maxAgeSeconds,
    secure: options.secure ?? false,
  };
}

function candidates(cookieHeader: string, key: string): string[] {
  const values: string[] = [];
  for (const segment of cookieHeader.split(";")) {
    const candidate = segment.trim();
    const separator = candidate.indexOf("=");
    if (separator < 0 || candidate.slice(0, separator) !== key) continue;
    values.push(candidate.slice(separator + 1));
  }
  return values;
}

function attributes(scope: CookieScope, maxAgeSeconds?: number): string {
  const parts = ["Path=/", "SameSite=Lax"];
  if (scope.domain !== undefined) parts.push(`Domain=${scope.domain}`);
  if (maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${String(maxAgeSeconds)}`);
  }
  if (scope.secure) parts.push("Secure");
  return parts.join("; ");
}

interface CookieStoreRuntimeOptions {
  readonly jar: CookieJarLike;
  readonly key: string;
  readonly schemaVersion: number;
}

function createValidatedCookieDecisionStore(
  options: CookieStoreRuntimeOptions,
  scope: CookieScope,
): CookieDecisionStore {
  function inspect(): CookieStoreSnapshot {
    let matches: string[];
    try {
      matches = candidates(options.jar.read(), options.key);
    } catch {
      return {
        encodedValue: undefined,
        result: { reason: "read-failed", status: "invalid" },
      };
    }
    if (matches.length === 0) {
      return { encodedValue: undefined, result: { status: "missing" } };
    }
    if (matches.length > 1) {
      return {
        encodedValue: undefined,
        result: {
          candidateCount: matches.length,
          status: "ambiguous-duplicate",
        },
      };
    }

    try {
      return {
        encodedValue: matches[0],
        result: decodeDecisionRecordEnvelope(
          decodeURIComponent(matches[0] ?? ""),
          options.schemaVersion,
        ),
      };
    } catch {
      return {
        encodedValue: matches[0],
        result: { reason: "malformed-json", status: "invalid" },
      };
    }
  }

  function read(): Promise<DecisionStoreReadResult> {
    return Promise.resolve(inspect().result);
  }

  function writeValue(value: string | undefined): void {
    options.jar.write(
      value === undefined
        ? `${options.key}=; ${attributes(scope, 0)}`
        : `${options.key}=${value}; ${attributes(scope, scope.maxAgeSeconds)}`,
    );
  }

  return Object.freeze({
    clear(): Promise<void> {
      return promiseFrom(() => {
        writeValue(undefined);
        if (candidates(options.jar.read(), options.key).length !== 0) {
          throw new Error("Decision cookie clear was not confirmed.");
        }
      });
    },
    clearIfCurrent(
      expected: PersistedConsentState,
    ): Promise<DecisionStoreConditionalClearResult> {
      return promiseFrom<DecisionStoreConditionalClearResult>(() => {
        const snapshot = inspect();
        const failure = decisionStoreClearPrecondition(
          snapshot.result,
          expected,
        );
        if (failure) return failure;
        const current = candidates(options.jar.read(), options.key);
        if (current.length !== 1 || current[0] !== snapshot.encodedValue) {
          return "readback-mismatch";
        }
        writeValue(undefined);
        return candidates(options.jar.read(), options.key).length === 0
          ? "cleared"
          : "readback-mismatch";
      });
    },
    compareAndSet(
      expected: PersistedConsentState | null,
      candidate: PersistedConsentState,
    ): Promise<DecisionStoreWriteResult> {
      return promiseFrom<DecisionStoreWriteResult>(() => {
        const snapshot = inspect();
        const current = snapshot.result;
        const failure = decisionStorePreconditionFailure(current, expected);
        if (failure) return { status: failure };

        const value = encodeURIComponent(
          encodeDecisionRecordEnvelope(candidate, options.schemaVersion),
        );
        writeValue(value);

        let writtenValues: string[];
        try {
          writtenValues = candidates(options.jar.read(), options.key);
        } catch {
          return { status: "readback-mismatch" };
        }
        if (writtenValues.length === 1 && writtenValues[0] === value) {
          return { status: "written" };
        }
        return { status: "readback-mismatch" };
      });
    },
    read,
  });
}

/** @public */
export function createCookieDecisionStore(
  options: CookieDecisionStoreOptions,
): CookieDecisionStore {
  return createValidatedCookieDecisionStore(options, validateOptions(options));
}

type CapturedCookieDecisionStoreOptions = CookieStoreRuntimeOptions & {
  readonly hostname: string;
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
} & (
    | {
        readonly domain?: undefined;
        readonly registrableDomain?: undefined;
      }
    | {
        readonly domain: string;
        readonly registrableDomain: string;
      }
  );

/** Creates the cookie store from already captured auto-product literals. @internal */
export function createCapturedCookieDecisionStore(
  options: CapturedCookieDecisionStoreOptions,
): CookieDecisionStore {
  if (!COOKIE_NAME.test(options.key)) {
    throw new TypeError("Cookie key must be a valid HTTP cookie name.");
  }
  const hostname = canonicalizeHost(options.hostname, "hostname");
  const domain =
    options.domain === undefined
      ? undefined
      : validateRegistrableBoundary(
          hostname,
          validateSharedRequest(hostname, options.domain),
          options.registrableDomain,
        );
  return createValidatedCookieDecisionStore(options, {
    domain,
    maxAgeSeconds: options.maxAgeSeconds,
    secure: options.secure,
  });
}
