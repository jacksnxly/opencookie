import type { SessionScanObservation } from "./har-scan.js";

const STORES = ["local", "session"] as const;

function names(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string" && entry !== "")
    ? (value as string[])
    : undefined;
}

function httpPage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the keys an operator found in a page's Web Storage.
 *
 * Neither a markup scan nor a recording can see Web Storage: those writes never
 * reach the network. The operator reads it in their own browser and hands the
 * result over, so what comes back is `observed`.
 *
 * The browser is supplied by the caller rather than guessed, because a finding
 * carries the browser it was seen in and a snapshot cannot name one for itself.
 *
 * @throws TypeError when the document is not a snapshot, or no browser is
 * named.
 * @public
 */
export function scanStorageSnapshot(
  document: string,
  browser: string,
): readonly SessionScanObservation[] {
  if (browser.trim() === "") {
    throw new TypeError(
      "Name the browser the snapshot was taken in; a finding records where it was seen.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw new TypeError("That file is not a Web Storage snapshot.");
  }
  const record = parsed as Record<string, unknown> | null;
  // A list is an object too, and a list of anything is not a snapshot: saying
  // it names no page would send the operator looking for the wrong mistake.
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("That file is not a Web Storage snapshot.");
  }
  const page = httpPage(record["page"]);
  if (page === undefined) {
    throw new TypeError(
      "That Web Storage snapshot names no page, or one that is not a web address.",
    );
  }
  const observedAt =
    typeof record["recordedAt"] === "string" ? record["recordedAt"] : "unknown";
  const observations: SessionScanObservation[] = [];
  for (const store of STORES) {
    const keys = names(record[store]);
    if (keys === undefined) {
      throw new TypeError(
        `That Web Storage snapshot lists ${store} entries that are not key names.`,
      );
    }
    for (const key of keys) {
      observations.push({
        browser: browser.trim(),
        kind: "storage",
        name: `${store}:${key}`,
        observedAt,
        source: page,
        trigger: "observed-in-session",
        uncertainty: "observed",
      });
    }
  }
  if (observations.length === 0) {
    throw new TypeError(
      "That Web Storage snapshot holds no local or session keys.",
    );
  }
  return observations;
}
