import type { FindingKind } from "./findings.js";

/** One resource a recorded browsing session actually used. @public */
export interface SessionScanObservation {
  readonly browser: string;
  readonly kind: FindingKind;
  readonly name: string;
  readonly observedAt: string;
  readonly source: string;
  readonly trigger: "observed-in-session";
  readonly uncertainty: "observed";
}

interface HarCookie {
  readonly name?: unknown;
}

interface HarEntry {
  readonly _resourceType?: unknown;
  readonly pageref?: unknown;
  readonly request?: {
    readonly headers?: unknown;
    readonly url?: unknown;
  };
  readonly response?: {
    readonly content?: { readonly mimeType?: unknown };
    readonly cookies?: readonly HarCookie[];
  };
  readonly startedDateTime?: unknown;
}

interface HarLog {
  readonly browser?: { readonly name?: unknown; readonly version?: unknown };
  readonly entries?: readonly HarEntry[];
  readonly pages?: readonly {
    readonly id?: unknown;
    readonly title?: unknown;
  }[];
}

/**
 * What each engine calls a `navigator.sendBeacon` request.
 *
 * Chromium records `ping`; WebKit and Firefox record `beacon`. Reading only one
 * of them would file a beacon recorded in Safari as an ordinary network
 * destination.
 */
const BEACON_TYPES = new Set(["beacon", "ping"]);

/**
 * An RFC 6265 cookie name, which is an RFC 7230 token.
 *
 * WebKit's recorder splits a Set-Cookie header at the comma inside its Expires
 * date and files what follows as a cookie of its own, named for part of the
 * date. No server can name a cookie that way, so such a name is not a finding.
 */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

const SCRIPT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
]);

const FRAME_DESTINATIONS = new Set(["embed", "frame", "iframe", "object"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function httpUrl(value: unknown): URL | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Names the browser that made the recording, or says it is unknown.
 *
 * A finding carries the browser it was seen in because discovery is browser
 * dependent, so an unnamed recording says so rather than borrowing a name.
 */
function browserOf(log: HarLog): string {
  const name = asString(log.browser?.name);
  if (name === undefined) return "unknown";
  const version = asString(log.browser?.version);
  return version === undefined ? name : `${name} ${version}`;
}

function equalsIgnoringCaseAndWhitespace(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Settles which browser a recording was made in.
 *
 * A HAR exported from a browser's own developer tools often names the inspector
 * rather than the browser, so the operator may say which one they used. They may
 * not contradict a recording that names one for itself: a finding carries the
 * browser it was seen in, and relabelling one would make that evidence a
 * statement about a browser it never ran in.
 */
function resolveBrowser(
  recorded: string,
  recordedName: string | undefined,
  declared: string | undefined,
): string {
  const named = declared?.trim();
  if (named === undefined || named === "") return recorded;
  if (recorded === "unknown") return named;
  if (
    equalsIgnoringCaseAndWhitespace(recorded, named) ||
    (recordedName !== undefined &&
      equalsIgnoringCaseAndWhitespace(recordedName, named))
  ) {
    return recorded;
  }
  throw new TypeError(
    `That recording says it was made in ${recorded}, not ${named}.`,
  );
}

function secFetchDest(entry: HarEntry): string | undefined {
  const headers = entry.request?.headers;
  if (!Array.isArray(headers)) return undefined;
  for (const header of headers) {
    if (typeof header !== "object" || header === null) continue;
    const name = asString((header as { name?: unknown }).name);
    const value = asString((header as { value?: unknown }).value);
    if (name?.toLowerCase() === "sec-fetch-dest") {
      return value?.toLowerCase();
    }
  }
  return undefined;
}

/**
 * The page an entry belongs to. Developer tools record the page's address as
 * its title; Playwright records the document's title there, so a page's own
 * address is then its first document, one page per navigation.
 */
function pageOf(
  log: HarLog,
  entry: HarEntry,
  firstDocuments: ReadonlyMap<unknown, string>,
  fallback: string,
): string {
  const page = (log.pages ?? []).find(
    (candidate) => candidate.id === entry.pageref,
  );
  return (
    httpUrl(page?.title)?.href ?? firstDocuments.get(entry.pageref) ?? fallback
  );
}

/**
 * Reads what a recorded browsing session actually loaded and set.
 *
 * Everything reported here happened: the request was made or the cookie came
 * back, so each observation is `observed` rather than inferred. What a
 * recording cannot show is equally definite: it holds no Web Storage writes,
 * because those never reach the network.
 *
 * Same-origin requests that are not scripts are left out. A site fetching its
 * own pages is not by itself a consent concern, and reporting every one would
 * bury the findings that are.
 *
 * A cookie entry whose name is not an RFC 6265 cookie name is left out and
 * handed to `onSkippedCookie`, so the caller can say what it did not import.
 * `includeSameOrigin` keeps same-origin requests too, for a first-party relay
 * that forwards a vendor's events through the site's own origin.
 *
 * @throws TypeError when the document is not an HTTP Archive recording.
 * @public
 */
export function scanHar(
  document: string,
  declaredBrowser?: string,
  onSkippedCookie?: (name: string) => void,
  options?: { readonly includeSameOrigin?: boolean },
): readonly SessionScanObservation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new TypeError("That file is not an HTTP Archive recording.");
  }
  const log = (parsed as { log?: HarLog } | null)?.log;
  if (log === undefined || !Array.isArray(log.entries)) {
    throw new TypeError(
      "That file is not an HTTP Archive recording: it has no log.entries.",
    );
  }
  // Array.isArray widens a readonly tuple to any[], so the checked value is
  // named once here rather than read back off the log.
  const entries: readonly HarEntry[] = log.entries;
  const browser = resolveBrowser(
    browserOf(log),
    asString(log.browser?.name),
    declaredBrowser,
  );
  const firstDocument =
    entries
      .map((entry) => httpUrl(entry.request?.url)?.href)
      .find((url) => url !== undefined) ?? "unknown";
  const observations: SessionScanObservation[] = [];
  const seen = new Set<string>();
  const skipped = new Set<string>();
  const record = (
    kind: FindingKind,
    name: string,
    entry: HarEntry,
    source: string,
  ): void => {
    const key = `${kind}\u001f${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    observations.push({
      browser,
      kind,
      name,
      observedAt: asString(entry.startedDateTime) ?? "unknown",
      source,
      trigger: "observed-in-session",
      uncertainty: "observed",
    });
  };

  const firstDocuments = new Map<unknown, string>();
  for (const entry of entries) {
    const url = httpUrl(entry.request?.url);
    if (
      entry._resourceType === "document" &&
      url !== undefined &&
      !firstDocuments.has(entry.pageref)
    ) {
      firstDocuments.set(entry.pageref, url.href);
    }
  }
  const currentPages = new Map<unknown, string>();
  for (const entry of entries) {
    const url = httpUrl(entry.request?.url);
    const destination = secFetchDest(entry);
    const isNavigation = destination === "document";
    const isFrame =
      destination !== undefined && FRAME_DESTINATIONS.has(destination);
    const source =
      isNavigation && url !== undefined
        ? url.href
        : entry._resourceType === "document" && !isFrame
          ? pageOf(log, entry, firstDocuments, firstDocument)
          : (currentPages.get(entry.pageref) ??
            pageOf(log, entry, firstDocuments, firstDocument));
    if (isNavigation && url !== undefined) {
      currentPages.set(entry.pageref, url.href);
    }
    for (const cookie of entry.response?.cookies ?? []) {
      const name = asString(cookie.name);
      if (name === undefined) continue;
      if (COOKIE_NAME.test(name)) {
        record("cookie", name, entry, source);
      } else if (!skipped.has(name)) {
        skipped.add(name);
        onSkippedCookie?.(name);
      }
    }
    if (url === undefined) continue;
    const mimeType = (asString(entry.response?.content?.mimeType) ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (BEACON_TYPES.has(entry._resourceType as string)) {
      record("beacon", url.href, entry, source);
      continue;
    }
    // A sub-document is a frame the page embedded. The page's own document is
    // the visit itself, not something it loaded, so it is not a finding.
    if (entry._resourceType === "document") {
      if (isFrame) {
        record("iframe", url.href, entry, source);
      } else if (!isNavigation && url.href !== source) {
        record("iframe", url.href, entry, source);
      }
      continue;
    }
    if (mimeType !== undefined && SCRIPT_TYPES.has(mimeType)) {
      record("script", url.href, entry, source);
      continue;
    }
    const page = httpUrl(source);
    if (
      options?.includeSameOrigin !== true &&
      page !== undefined &&
      page.origin === url.origin
    ) {
      continue;
    }
    record("network-destination", url.href, entry, source);
  }
  return observations;
}
