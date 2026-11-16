const BINDING_PATTERN = /@covers\s+(PP-\d{2})/gu;
const SELF_TEST_FILE = "verify-pain-point-coverage.test.mjs";
const TABLE_ROW = /^\|\s*(PP-\d{2})\s*\|\s*[^|]*\|\s*([A-Z0-9-]+)\s*\|/u;

/**
 * Pain points that no test is bound to yet.
 *
 * Most entries cleared once the traceability table's own test identifiers were
 * resolved against `tests/e2e`, where the driven-browser checks already live.
 *
 * This is a ratchet, not a permission slip. Every entry is work the contract's
 * bar clause still requires: each pain point must end up covered by a test that
 * fails against the described defect, or be recorded out of scope with a reason.
 * The gate refuses an entry that is already bound, so the list can only shrink.
 */
export const UNBOUND_PAIN_POINT_LEDGER = Object.freeze(
  new Map([
    [
      "PP-26",
      "TCF is out of scope for 1.0; its absence is enforced by a test.",
    ],
  ]),
);

/**
 * True for a file that can carry a pain point binding.
 *
 * Gate verifiers under `scripts/` are tests too: several pain points are
 * enforced by a gate rather than by a package unit test, and a binding has to be
 * able to point at the check that actually proves them.
 */
export function isTestSourceFile(fileName) {
  // This gate's own fixtures quote sample identifiers to exercise the parser.
  // Counting them would let the gate satisfy itself, so they are never a source.
  if (fileName === SELF_TEST_FILE) return false;
  return /\.(test|spec)\.([cm]?[jt]sx?)$/u.test(fileName);
}

/**
 * Reads the test identifier each pain point is traced to.
 *
 * The traceability table is the authored mapping from a pain point to the check
 * that proves it, so a test carrying that identifier is a binding without
 * needing a second marker beside it.
 */
export function parseTraceability(markdown) {
  const traced = new Map();
  for (const line of markdown.split(/\r?\n/u)) {
    const match = TABLE_ROW.exec(line);
    if (match !== null) traced.set(match[1], match[2]);
  }
  return traced;
}

/** Reads every pain point declared in the traceability table. */
export function parseDeclaredPainPoints(markdown) {
  const declared = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const match = TABLE_ROW.exec(line);
    if (match !== null) declared.push(match[1]);
  }
  return declared;
}

/**
 * Reads pain points a test explicitly claims to cover.
 *
 * A bare identifier is not a binding. Several verifiers quote identifiers as
 * fixtures, and a mention is not evidence, so only an explicit `@covers PP-xx`
 * marker counts.
 */
export function parseBoundPainPoints(sources, traceability = new Map()) {
  const bound = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(BINDING_PATTERN)) bound.add(match[1]);
    for (const [painPoint, testId] of traceability) {
      if (source.includes(testId)) bound.add(painPoint);
    }
  }
  return bound;
}

/**
 * Fails when a declared pain point is neither bound to a test nor recorded as
 * still unbound, when a recorded entry is already bound, or when the ledger
 * names a pain point the document does not declare.
 */
export function assertPainPointCoverage({ declared, bound, unboundLedger }) {
  const declaredSet = new Set(declared);
  const problems = [];

  for (const painPoint of declared) {
    if (bound.has(painPoint)) continue;
    if (unboundLedger.has(painPoint)) continue;
    problems.push(
      `${painPoint} is declared but no test references it and it is not recorded as unbound.`,
    );
  }

  for (const painPoint of unboundLedger.keys()) {
    if (!declaredSet.has(painPoint)) {
      problems.push(
        `${painPoint} is recorded as unbound but the traceability table does not declare it.`,
      );
      continue;
    }
    if (bound.has(painPoint)) {
      problems.push(
        `${painPoint} is bound to a test, so remove it from the unbound ledger.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`Pain point coverage failed:\n  ${problems.join("\n  ")}`);
  }
  return { bound: bound.size, declared: declared.length };
}
