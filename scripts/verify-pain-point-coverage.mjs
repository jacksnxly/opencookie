import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  assertPainPointCoverage,
  isTestSourceFile,
  parseBoundPainPoints,
  parseDeclaredPainPoints,
  parseTraceability,
  UNBOUND_PAIN_POINT_LEDGER,
} from "./verify-pain-point-coverage-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PAIN_POINTS = join(ROOT, "docs/research/PAIN-POINTS.md");
const TEST_ROOTS = ["packages", "apps", "tests", "scripts"];
const SKIP = new Set(["node_modules", "dist", "coverage", ".git"]);

async function collectTestSources(directory, collected) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTestSources(path, collected);
    } else if (isTestSourceFile(entry.name)) {
      collected.push(await readFile(path, "utf8"));
    }
  }
  return collected;
}

const painPointDocument = await readFile(PAIN_POINTS, "utf8");
const declared = parseDeclaredPainPoints(painPointDocument);
const traceability = parseTraceability(painPointDocument);
if (declared.length === 0) {
  throw new Error(
    "No pain points were declared; the traceability table is missing.",
  );
}

const sources = [];
for (const root of TEST_ROOTS) {
  await collectTestSources(join(ROOT, root), sources);
}

const result = assertPainPointCoverage({
  bound: parseBoundPainPoints(sources, traceability),
  declared,
  unboundLedger: UNBOUND_PAIN_POINT_LEDGER,
});

process.stdout.write(
  `Pain point coverage: ${String(result.bound)} of ${String(result.declared)} bound to a test, ${String(UNBOUND_PAIN_POINT_LEDGER.size)} recorded as still unbound.\n`,
);
