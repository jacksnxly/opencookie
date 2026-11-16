import { gzipSync } from "node:zlib";

const coreEntryFileNames = Object.freeze([
  "application.js",
  "auto.js",
  "domain.js",
  "index.js",
  "infrastructure.js",
  "reconciliation.js",
]);
const receiptProjectionMarker = "idempotencyKey";
// The any-of rule compares a resource's match to "any"; carrying the field
// through a projection does not.
const anyOfAccessRulePattern = /purposeMatch\s*===\s*["'`]any["'`]/u;
const applicationReconciliationImportPattern =
  /import\s*\{[^}]*\}\s*from\s*["']@opencookie-dev\/core\/reconciliation["'];?/u;
const moduleDependencyPattern =
  /\b(?:import\s*(?:\(|["'{*])|export\s*(?:\*|\{)[^;]*?\s*from\s*["']|require\s*\(\s*["'])/u;

export class ConsumerGraphSizeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsumerGraphSizeError";
  }
}

/**
 * The four owner budgets. They keep a hard ceiling and report headroom against
 * the last release. Core axes stay on the one-percent ratchet.
 */
export const SIZE_BUDGET_AXES = Object.freeze([
  "vanilla auto IIFE",
  "vanilla auto IIFE raw",
  "vanilla programmatic route",
  "vanilla programmatic route raw",
]);

/** Published 0.4.0 measurements, the baseline each budget line reports against. */
export const RELEASED_SIZES = Object.freeze({
  "vanilla auto IIFE": 40_398,
  "vanilla auto IIFE raw": 132_569,
  "vanilla programmatic route": 45_145,
  "vanilla programmatic route raw": 154_401,
});

/**
 * The headroom rule, in one place so the unit constraint on recorded
 * ceilings and the live check against real artifacts cannot diverge.
 *
 * `overBudget` is a hard failure: the artifact reaches or exceeds its ceiling.
 * Under the exact canonical Node version, `excessSlack` is also a hard failure
 * on every axis except SIZE_BUDGET_AXES. A core ceiling at least one percent
 * above the artifact can absorb a regression silently, which is what the
 * ratchet exists to prevent. A legitimate core reduction therefore requires
 * the ceiling to tighten in the same change.
 *
 * @public
 */
export function evaluateCeilingHeadroom({ ceiling, measured }) {
  if (!Number.isSafeInteger(ceiling) || !Number.isSafeInteger(measured)) {
    throw new ConsumerGraphSizeError(
      "Headroom evaluation requires integer ceiling and measured byte counts.",
    );
  }
  const headroom = ceiling - measured;
  const onePercent = Math.floor(measured / 100);
  return Object.freeze({
    excessSlack: headroom >= onePercent,
    headroom,
    onePercent,
    overBudget: headroom <= 0,
    suggestedCeiling: measured + Math.max(onePercent - 1, 1),
  });
}

const exactByteLimit = /^(\d+)\s*B$/u;

export function measureConfiguredArtifactSizes({ artifactBytes, entries }) {
  if (!(artifactBytes instanceof Map) || !Array.isArray(entries)) {
    throw new ConsumerGraphSizeError(
      "Configured artifact measurement requires size entries and artifact bytes.",
    );
  }

  return entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.split(/[\\/]/u).includes("..")
    ) {
      throw new ConsumerGraphSizeError(
        "Configured artifact measurement requires a named repository-relative path.",
      );
    }
    const limit = exactByteLimit.exec(String(entry.limit).trim());
    if (limit === null) {
      throw new ConsumerGraphSizeError(
        `${entry.name} must state an exact decimal-byte limit.`,
      );
    }
    const bytes = artifactBytes.get(entry.path);
    if (!(bytes instanceof Uint8Array)) {
      throw new ConsumerGraphSizeError(
        `${entry.name} has no readable built artifact at ${entry.path}.`,
      );
    }

    let measuredBytes;
    if (entry.gzip === true && entry.brotli !== false) {
      measuredBytes = gzipSync(bytes, { level: 9 }).byteLength;
    } else if (entry.gzip !== true && entry.brotli === false) {
      measuredBytes = bytes.byteLength;
    } else {
      throw new ConsumerGraphSizeError(
        `${entry.name} must select exactly canonical gzip or raw-byte accounting.`,
      );
    }

    return {
      limitBytes: Number(limit[1]),
      measuredBytes,
      name: entry.name,
      path: entry.path,
    };
  });
}

export function assertLiveSizeRatchet({
  artifactResults,
  graphResults,
  pinnedNodeVersion,
  runningNodeVersion,
}) {
  if (
    !Array.isArray(artifactResults) ||
    !Array.isArray(graphResults) ||
    typeof pinnedNodeVersion !== "string" ||
    typeof runningNodeVersion !== "string"
  ) {
    throw new ConsumerGraphSizeError(
      "Live size ratchet requires artifact and graph results plus exact Node versions.",
    );
  }

  const excessSlackCompared = pinnedNodeVersion === runningNodeVersion;
  const axes = [
    ...artifactResults.map((result) => ({
      ceiling: result?.limitBytes,
      measured: result?.measuredBytes,
      name: result?.name,
    })),
    ...graphResults.map((result) => ({
      ceiling: result?.limitBytes,
      measured: result?.gzipBytes,
      name: result?.name,
    })),
  ];
  const violations = [];

  for (const axis of axes) {
    if (typeof axis.name !== "string") {
      throw new ConsumerGraphSizeError(
        "Live size ratchet received an unnamed size axis.",
      );
    }
    const headroom = evaluateCeilingHeadroom(axis);
    if (headroom.overBudget) {
      violations.push(
        `${axis.name}: measured ${String(axis.measured)} bytes is at or above its ${String(axis.ceiling)} byte cap.`,
      );
    } else if (
      excessSlackCompared &&
      headroom.excessSlack &&
      !SIZE_BUDGET_AXES.includes(axis.name)
    ) {
      violations.push(
        `${axis.name}: ceiling ${String(axis.ceiling)} leaves ${String(headroom.headroom)} bytes above measured ${String(axis.measured)}, at or over the ${String(headroom.onePercent)} byte one percent regression. Tighten it to ${String(headroom.suggestedCeiling)}.`,
      );
    }
  }

  if (violations.length > 0) {
    throw new ConsumerGraphSizeError(
      `Live size ratchet failed:\n${violations.join("\n")}`,
    );
  }
  return { axesChecked: axes.length, excessSlackCompared };
}

export const coreConsumerGraphs = Object.freeze([
  Object.freeze({
    limitBytes: 32_388,
    name: "core root plus infrastructure",
    specifiers: Object.freeze([
      "@opencookie-dev/core",
      "@opencookie-dev/core/infrastructure",
    ]),
  }),
  Object.freeze({
    limitBytes: 42_565,
    name: "core root plus domain plus infrastructure",
    specifiers: Object.freeze([
      "@opencookie-dev/core",
      "@opencookie-dev/core/domain",
      "@opencookie-dev/core/infrastructure",
    ]),
  }),
  Object.freeze({
    limitBytes: 32_835,
    name: "core domain plus application plus infrastructure",
    specifiers: Object.freeze([
      "@opencookie-dev/core/domain",
      "@opencookie-dev/core/application",
      "@opencookie-dev/core/infrastructure",
    ]),
  }),
]);

const documentedGraphLabels = Object.freeze(
  new Map([
    ["core root plus infrastructure", "root plus infrastructure"],
    [
      "core root plus domain plus infrastructure",
      "root plus domain plus infrastructure",
    ],
    [
      "core domain plus application plus infrastructure",
      "domain plus application plus infrastructure",
    ],
  ]),
);

function formatByteCount(value) {
  return String(value).replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
}

export function describeBudgetGrowth({ limitBytes, measuredBytes, name }) {
  if (
    !Object.hasOwn(RELEASED_SIZES, name) ||
    !Number.isSafeInteger(measuredBytes) ||
    !Number.isSafeInteger(limitBytes)
  ) {
    throw new ConsumerGraphSizeError(
      "Budget growth requires a released axis and integer byte counts.",
    );
  }
  const delta = measuredBytes - RELEASED_SIZES[name];
  const signedDelta =
    delta >= 0 ? `+${formatByteCount(delta)}` : formatByteCount(delta);
  const left = limitBytes - measuredBytes;
  return `${name}: ${formatByteCount(measuredBytes)} of ${formatByteCount(limitBytes)} bytes (${formatByteCount(left)} left), ${signedDelta} since the last release`;
}

export function assertDocumentedCoreConsumerGraphSizes({
  documentation,
  pinnedNodeMajor,
  results,
  runningNodeMajor,
}) {
  if (typeof documentation !== "string" || !Array.isArray(results)) {
    throw new ConsumerGraphSizeError(
      "Documented combined graph sizes require README content and measured results.",
    );
  }

  // The documented figures are gzip byte counts, and gzip output is
  // Node-major sensitive. Off the pinned major they describe a different
  // toolchain, so comparing them reports a defect that does not exist and
  // invites a repair that breaks the pinned gate.
  if (
    Number.isSafeInteger(pinnedNodeMajor) &&
    Number.isSafeInteger(runningNodeMajor) &&
    pinnedNodeMajor !== runningNodeMajor
  ) {
    return {
      compared: false,
      reason: `Documented combined graph sizes are pinned to Node ${String(pinnedNodeMajor)} and were not compared under Node ${String(runningNodeMajor)}.`,
    };
  }

  const resultByName = new Map(
    results.map((result) => [result?.name, result?.gzipBytes]),
  );
  const measurements = [];
  for (const [name, label] of documentedGraphLabels) {
    const gzipBytes = resultByName.get(name);
    if (!Number.isSafeInteger(gzipBytes) || gzipBytes < 0) {
      throw new ConsumerGraphSizeError(
        `Documented combined graph sizes are missing a valid measurement for ${name}.`,
      );
    }
    measurements.push(`${formatByteCount(gzipBytes)} bytes for ${label}`);
  }

  const expected = `The current graphs are ${measurements[0]}, ${measurements[1]}, and ${measurements[2]}.`;
  if (!documentation.includes(expected)) {
    throw new ConsumerGraphSizeError(
      `Documented combined graph sizes are stale; expected ${expected}`,
    );
  }
  return { compared: true };
}

export function assertCanonicalCoreBuildArtifacts(artifacts) {
  if (
    artifacts === null ||
    typeof artifacts !== "object" ||
    Array.isArray(artifacts)
  ) {
    throw new ConsumerGraphSizeError(
      "Consumer graph measurement requires canonical self-contained core build artifacts.",
    );
  }

  for (const fileName of coreEntryFileNames) {
    const code = artifacts[fileName];
    const canonicalCode =
      fileName === "application.js" && typeof code === "string"
        ? code.replace(applicationReconciliationImportPattern, "")
        : code;
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      (fileName === "application.js" && canonicalCode === code) ||
      moduleDependencyPattern.test(canonicalCode)
    ) {
      throw new ConsumerGraphSizeError(
        `Consumer graph measurement requires canonical core build products; ${fileName} is missing or violates the exact application-to-reconciliation link. Run the core package build first.`,
      );
    }
  }

  if (artifacts["auto.js"].includes(receiptProjectionMarker)) {
    throw new ConsumerGraphSizeError(
      "The dedicated auto.js entry must stay receipt-free; it contains consent-receipt projection code.",
    );
  }
  if (anyOfAccessRulePattern.test(artifacts["auto.js"])) {
    throw new ConsumerGraphSizeError(
      "The dedicated auto.js entry must stay free of the any-of access rule; its resources each serve one purpose.",
    );
  }
}

export function createConsumerGraphSource(graph) {
  const imports = graph.specifiers.map(
    (specifier, index) =>
      `import * as entry${String(index)} from ${JSON.stringify(specifier)};`,
  );
  const entries = graph.specifiers.map((_, index) => `entry${String(index)}`);
  return `${imports.join("\n")}\n\nglobalThis.__openCookieConsumerGraph = Object.freeze([${entries.join(", ")}]);\n`;
}

function selfContainedJavaScript(graph, artifact) {
  const javaScriptFiles = artifact.fileNames.filter((fileName) =>
    fileName.endsWith(".js"),
  );
  if (javaScriptFiles.length !== 1) {
    throw new ConsumerGraphSizeError(
      `${graph.name} must be self-contained in exactly one JavaScript file; found ${String(javaScriptFiles.length)}.`,
    );
  }
  if (
    /(?:^|[;\n])\s*import(?!\.meta\b)/u.test(artifact.code) ||
    /\brequire\(\s*["']/u.test(artifact.code)
  ) {
    throw new ConsumerGraphSizeError(
      `${graph.name} must be self-contained without unresolved imports.`,
    );
  }
}

function measurableArtifact(graph, artifact) {
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    typeof artifact.code !== "string" ||
    !Array.isArray(artifact.fileNames) ||
    artifact.fileNames.some((fileName) => typeof fileName !== "string")
  ) {
    throw new ConsumerGraphSizeError(
      `${graph.name} did not produce a measurable bundle artifact.`,
    );
  }
  selfContainedJavaScript(graph, artifact);
  return artifact.code;
}

/**
 * The programmatic route: a committed page that bootstraps OpenCookie as a site
 * would, bundled with vanilla and core for the browser. Its budget is 50,000
 * gzip bytes and 175,000 raw bytes.
 */
export const programmaticRouteGraphs = Object.freeze([
  Object.freeze({
    entry: "scripts/size-fixtures/programmatic-route.mjs",
    limitBytes: 50_000,
    name: "vanilla programmatic route",
    rawLimitBytes: 175_000,
  }),
]);

export async function verifyProgrammaticRouteGraphs({ bundle }) {
  if (typeof bundle !== "function") {
    throw new ConsumerGraphSizeError(
      "Programmatic route measurement requires a bundle function.",
    );
  }

  const results = [];
  for (const graph of programmaticRouteGraphs) {
    const code = measurableArtifact(graph, await bundle({ graph }));
    const gzipBytes = gzipSync(code, { level: 9 }).byteLength;
    const rawBytes = Buffer.byteLength(code);
    for (const [bytes, cap, axis] of [
      [gzipBytes, graph.limitBytes, "gzip"],
      [rawBytes, graph.rawLimitBytes, "raw"],
    ]) {
      if (bytes > cap) {
        throw new ConsumerGraphSizeError(
          `${graph.name} is ${String(bytes)} bytes ${axis} and exceeds its ${String(cap)} byte ${axis} cap.`,
        );
      }
    }
    results.push(
      Object.freeze({
        gzipBytes,
        limitBytes: graph.limitBytes,
        name: graph.name,
        rawBytes,
        rawLimitBytes: graph.rawLimitBytes,
      }),
    );
  }
  return Object.freeze(results);
}

export async function verifyCoreConsumerGraphs({ bundle }) {
  if (typeof bundle !== "function") {
    throw new ConsumerGraphSizeError(
      "Core consumer graph verification requires a bundle function.",
    );
  }

  const results = [];
  for (const graph of coreConsumerGraphs) {
    const code = measurableArtifact(
      graph,
      await bundle({
        graph,
        source: createConsumerGraphSource(graph),
      }),
    );
    const rawBytes = Buffer.byteLength(code);
    const gzipBytes = gzipSync(code, { level: 9 }).byteLength;
    if (gzipBytes > graph.limitBytes) {
      throw new ConsumerGraphSizeError(
        `${graph.name} is ${String(gzipBytes)} bytes gzip and exceeds its ${String(graph.limitBytes)} byte gzip cap.`,
      );
    }
    results.push(
      Object.freeze({
        gzipBytes,
        limitBytes: graph.limitBytes,
        name: graph.name,
        rawBytes,
      }),
    );
  }

  return Object.freeze(results);
}
