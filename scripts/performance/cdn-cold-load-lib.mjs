import { isDeepStrictEqual } from "node:util";

const deepFreeze = (value) => {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") deepFreeze(child);
  }
  return Object.freeze(value);
};

export const CDN_CANDIDATE_SCRIPT_URL =
  "http://app.plain-cdn.opencookie.test:4400/__opencookie/auto.iife.js";
export const CDN_CALIBRATION_SCRIPT_URL =
  "http://performance.opencookie.test/calibration.js";

/**
 * V8's explicit compile hint. As the first line of a classic script it makes
 * Chrome compile the file eagerly on a background thread while it streams,
 * instead of lazily on the main thread at first call.
 */
export const CDN_COMPILE_HINT = "//# allFunctionsCalledOnLoad";

/** Rejects a candidate artifact that does not open with the compile hint. */
export function assertCompileHint(bytes) {
  const head = bytes.subarray(0, CDN_COMPILE_HINT.length + 1).toString("utf8");
  if (head !== `${CDN_COMPILE_HINT}\n`) {
    throw new Error(
      "The candidate IIFE must open with the V8 eager-compile hint so Chrome compiles it off the main thread.",
    );
  }
}

export const CDN_PERFORMANCE_PROFILE = deepFreeze({
  cpuSlowdownMultiplier: 4,
  longTaskQuietWindowMs: 5_000,
  measurementTimeoutMs: 30_000,
  network: {
    downloadThroughputBytesPerSecond: 200_000,
    latencyMs: 150,
    uploadThroughputBytesPerSecond: 93_750,
  },
  runsPerScenario: 3,
  viewport: { height: 844, width: 390 },
});

export const CDN_PERFORMANCE_THRESHOLDS = deepFreeze({
  longTaskDurationMs: 50,
  meanTotalBlockingTimeMs: 20,
});

export const CDN_PERFORMANCE_RUN_PLAN = deepFreeze([
  { pair: 1, scenario: "enabled" },
  { pair: 1, scenario: "blocked" },
  { pair: 2, scenario: "blocked" },
  { pair: 2, scenario: "enabled" },
  { pair: 3, scenario: "enabled" },
  { pair: 3, scenario: "blocked" },
]);

const TOP_LEVEL_KEYS = [
  "artifact",
  "browser",
  "candidateSha",
  "completedAt",
  "instrumentation",
  "profile",
  "runs",
  "schemaVersion",
  "startedAt",
  "status",
  "summary",
  "thresholds",
];
const ARTIFACT_KEYS = ["bytes", "integrity", "path"];
const BROWSER_KEYS = ["name", "version"];
const INSTRUMENTATION_KEYS = [
  "calibration",
  "longAnimationFrameObserverSupported",
  "longTaskObserverSupported",
];
const CALIBRATION_KEYS = [
  "longAnimationFrameObserved",
  "longTaskObserved",
  "sourceURL",
];
const RUN_KEYS = [
  "bundleCacheHitCount",
  "bundleRequestCount",
  "bundleResponseCount",
  "bundleResponseIntegrity",
  "bundleServiceWorkerResponseCount",
  "completedAt",
  "barVisible",
  "firstContentfulPaintMs",
  "longAnimationFrames",
  "longTasks",
  "measurementEndMs",
  "namespacePresent",
  "observerSupport",
  "pair",
  "scenario",
  "sequence",
  "startedAt",
  "totalBlockingTimeMs",
];
const OBSERVER_SUPPORT_KEYS = ["longAnimationFrame", "longTask"];
const LONG_TASK_KEYS = ["duration", "startTime"];
const LONG_ANIMATION_FRAME_KEYS = [
  "blockingDuration",
  "duration",
  "renderStart",
  "scripts",
  "startTime",
  "styleAndLayoutStart",
];
const SCRIPT_TIMING_KEYS = [
  "duration",
  "executionStart",
  "forcedStyleAndLayoutDuration",
  "invoker",
  "invokerType",
  "pauseDuration",
  "sourceCharPosition",
  "sourceFunctionName",
  "sourceURL",
  "startTime",
  "windowAttribution",
];
const SUMMARY_KEYS = [
  "blockedMeanTotalBlockingTimeMs",
  "enabledMeanTotalBlockingTimeMs",
  "enabledOpenCookieAttributedLongTaskCount",
  "enabledWholePageLongTaskCount",
];
const SHA384_PATTERN = /^sha384-[A-Za-z0-9+/]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WINDOW_ATTRIBUTIONS = new Set([
  "ancestor",
  "descendant",
  "other",
  "same-page",
  "self",
]);

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const sortedExpected = [...expected].sort();
  if (!isDeepStrictEqual(actual, sortedExpected)) {
    throw new Error(`${label} must contain only the canonical fields.`);
  }
}

function finite(value, label, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(
      `${label} must be a finite number at least ${String(minimum)}.`,
    );
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be an ISO timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return milliseconds;
}

function roundMetric(value) {
  return Number(value.toFixed(3));
}

export function calculateTotalBlockingTime(
  longTasks,
  { firstContentfulPaintMs, measurementEndMs },
) {
  if (!Array.isArray(longTasks)) {
    throw new TypeError("Long tasks must be an array.");
  }
  const firstContentfulPaint = finite(
    firstContentfulPaintMs,
    "First Contentful Paint",
  );
  const measurementEnd = finite(measurementEndMs, "Measurement end");
  if (measurementEnd <= firstContentfulPaint) {
    throw new Error("Measurement end must follow First Contentful Paint.");
  }
  let total = 0;
  for (const [index, task] of longTasks.entries()) {
    exactKeys(task, LONG_TASK_KEYS, `Long task ${String(index + 1)}`);
    const startTime = finite(
      task.startTime,
      `Long task ${String(index + 1)} startTime`,
    );
    const duration = finite(
      task.duration,
      `Long task ${String(index + 1)} duration`,
    );
    const clippedStart = Math.max(startTime, firstContentfulPaint);
    const clippedEnd = Math.min(startTime + duration, measurementEnd);
    const clippedDuration = Math.max(0, clippedEnd - clippedStart);
    total += Math.max(
      0,
      clippedDuration - CDN_PERFORMANCE_THRESHOLDS.longTaskDurationMs,
    );
  }
  return roundMetric(total);
}

function mean(runs) {
  return roundMetric(
    runs.reduce((sum, run) => sum + run.totalBlockingTimeMs, 0) / runs.length,
  );
}

function validateLongTaskQuietWindow(longTasks, measurementEndMs, label) {
  const quietWindowStartMs =
    measurementEndMs - CDN_PERFORMANCE_PROFILE.longTaskQuietWindowMs;
  if (
    quietWindowStartMs < 0 ||
    longTasks.some(
      ({ duration, startTime }) => startTime + duration > quietWindowStartMs,
    )
  ) {
    throw new Error(
      `${label} must prove a five-second long-task-free window after the last observed task.`,
    );
  }
}

function validateScriptTiming(script, label, measurementEndMs) {
  exactKeys(script, SCRIPT_TIMING_KEYS, label);
  const startTime = finite(script.startTime, `${label} startTime`);
  const duration = finite(script.duration, `${label} duration`);
  const executionStart = finite(
    script.executionStart,
    `${label} executionStart`,
  );
  finite(
    script.forcedStyleAndLayoutDuration,
    `${label} forcedStyleAndLayoutDuration`,
  );
  finite(script.pauseDuration, `${label} pauseDuration`);
  if (
    startTime >= measurementEndMs ||
    executionStart < startTime ||
    executionStart > startTime + duration
  ) {
    throw new Error(`${label} timing interval is invalid.`);
  }
  if (
    typeof script.invoker !== "string" ||
    typeof script.invokerType !== "string" ||
    script.invokerType.length === 0 ||
    typeof script.sourceURL !== "string" ||
    typeof script.sourceFunctionName !== "string" ||
    !Number.isSafeInteger(script.sourceCharPosition) ||
    script.sourceCharPosition < -1 ||
    !WINDOW_ATTRIBUTIONS.has(script.windowAttribution)
  ) {
    throw new Error(`${label} source attribution is invalid.`);
  }
  return script;
}

function validateLongAnimationFrames(frames, label, measurementEndMs) {
  if (!Array.isArray(frames)) {
    throw new TypeError(`${label} must be an array.`);
  }
  return frames.map((frame, frameIndex) => {
    const frameLabel = `${label} ${String(frameIndex + 1)}`;
    exactKeys(frame, LONG_ANIMATION_FRAME_KEYS, frameLabel);
    const startTime = finite(frame.startTime, `${frameLabel} startTime`);
    finite(
      frame.duration,
      `${frameLabel} duration`,
      CDN_PERFORMANCE_THRESHOLDS.longTaskDurationMs,
    );
    finite(frame.blockingDuration, `${frameLabel} blockingDuration`);
    finite(frame.renderStart, `${frameLabel} renderStart`);
    finite(frame.styleAndLayoutStart, `${frameLabel} styleAndLayoutStart`);
    if (startTime >= measurementEndMs) {
      throw new Error(`${frameLabel} starts outside the measured window.`);
    }
    if (!Array.isArray(frame.scripts)) {
      throw new TypeError(`${frameLabel} scripts must be an array.`);
    }
    for (const [scriptIndex, script] of frame.scripts.entries()) {
      validateScriptTiming(
        script,
        `${frameLabel} script ${String(scriptIndex + 1)}`,
        measurementEndMs,
      );
    }
    return frame;
  });
}

function candidateScripts(frames) {
  return frames.flatMap(({ scripts }) =>
    scripts.filter(
      ({ sourceURL, windowAttribution }) =>
        sourceURL === CDN_CANDIDATE_SCRIPT_URL && windowAttribution === "self",
    ),
  );
}

function validateRun(run, expected, artifactIntegrity, window) {
  const label = `Performance run ${String(expected.sequence)}`;
  exactKeys(run, RUN_KEYS, label);
  if (
    run.sequence !== expected.sequence ||
    run.pair !== expected.pair ||
    run.scenario !== expected.scenario
  ) {
    throw new Error(`${label} does not match the canonical paired run plan.`);
  }
  const startedAt = timestamp(run.startedAt, `${label} startedAt`);
  const completedAt = timestamp(run.completedAt, `${label} completedAt`);
  if (
    completedAt < startedAt ||
    startedAt < window.startedAt ||
    completedAt > window.completedAt
  ) {
    throw new Error(`${label} timestamps must stay inside the proof window.`);
  }
  exactKeys(run.observerSupport, OBSERVER_SUPPORT_KEYS, `${label} observers`);
  if (
    run.observerSupport.longTask !== true ||
    run.observerSupport.longAnimationFrame !== true
  ) {
    throw new Error(`${label} requires both attribution observers.`);
  }
  for (const [value, countLabel] of [
    [run.bundleRequestCount, "bundle request count"],
    [run.bundleResponseCount, "bundle response count"],
    [run.bundleCacheHitCount, "bundle cache hit count"],
    [
      run.bundleServiceWorkerResponseCount,
      "bundle service worker response count",
    ],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `${label} ${countLabel} must be a non-negative integer.`,
      );
    }
  }
  if (run.bundleCacheHitCount !== 0) {
    throw new Error(`${label} must not use a cached candidate bundle.`);
  }
  if (run.bundleServiceWorkerResponseCount !== 0) {
    throw new Error(`${label} must not use a service worker bundle response.`);
  }
  if (typeof run.namespacePresent !== "boolean") {
    throw new TypeError(`${label} namespace proof must be boolean.`);
  }
  if (typeof run.barVisible !== "boolean") {
    throw new TypeError(`${label} bar proof must be boolean.`);
  }
  const firstContentfulPaintMs = finite(
    run.firstContentfulPaintMs,
    `${label} First Contentful Paint`,
  );
  const measurementEndMs = finite(
    run.measurementEndMs,
    `${label} measurement end`,
  );
  if (measurementEndMs <= firstContentfulPaintMs) {
    throw new Error(`${label} measurement must extend beyond first paint.`);
  }
  if (!Array.isArray(run.longTasks)) {
    throw new TypeError(`${label} long tasks must be an array.`);
  }
  for (const [taskIndex, task] of run.longTasks.entries()) {
    exactKeys(
      task,
      LONG_TASK_KEYS,
      `${label} long task ${String(taskIndex + 1)}`,
    );
    finite(task.startTime, `${label} long task startTime`);
    finite(
      task.duration,
      `${label} raw long-task duration`,
      CDN_PERFORMANCE_THRESHOLDS.longTaskDurationMs,
    );
    if (task.startTime >= measurementEndMs) {
      throw new Error(`${label} long task starts outside the measured window.`);
    }
  }
  const frames = validateLongAnimationFrames(
    run.longAnimationFrames,
    `${label} long animation frame`,
    measurementEndMs,
  );
  const scripts = candidateScripts(frames);
  const enabled = expected.scenario === "enabled";
  if (enabled) {
    if (run.bundleRequestCount !== 1 || run.bundleResponseCount !== 1) {
      throw new Error(`${label} must load exactly one OpenCookie bundle.`);
    }
    if (run.bundleResponseIntegrity !== artifactIntegrity) {
      throw new Error(
        `${label} response integrity must match the candidate IIFE.`,
      );
    }
    if (run.namespacePresent !== true) {
      throw new Error(`${label} must prove the OpenCookie namespace executed.`);
    }
    if (run.barVisible !== true) {
      throw new Error(`${label} must prove the consent bar rendered.`);
    }
    if (run.longTasks.length > 0) {
      throw new Error(
        `${label} contains an enabled long task lasting 50 ms or longer.`,
      );
    }
    if (
      scripts.some(
        ({ duration }) =>
          duration >= CDN_PERFORMANCE_THRESHOLDS.longTaskDurationMs,
      )
    ) {
      throw new Error(`${label} candidate script lasts 50 ms or longer.`);
    }
  } else {
    if (run.bundleRequestCount !== 1 || run.bundleResponseCount !== 0) {
      throw new Error(
        `${label} must prove exactly one blocked bundle request.`,
      );
    }
    if (run.bundleResponseIntegrity !== null) {
      throw new Error(`${label} blocked response integrity must be null.`);
    }
    if (run.namespacePresent !== false) {
      throw new Error(`${label} blocked namespace must remain absent.`);
    }
    if (run.barVisible !== false) {
      throw new Error(`${label} blocked run must not render the consent bar.`);
    }
    if (scripts.length > 0) {
      throw new Error(
        `${label} blocked run contains candidate script evidence.`,
      );
    }
  }
  const totalBlockingTimeMs = calculateTotalBlockingTime(run.longTasks, run);
  finite(run.totalBlockingTimeMs, `${label} TBT`);
  if (run.totalBlockingTimeMs !== totalBlockingTimeMs) {
    throw new Error(
      `${label} TBT must equal the value recomputed from raw tasks.`,
    );
  }
  validateLongTaskQuietWindow(run.longTasks, measurementEndMs, label);
  return run;
}

function validateInstrumentation(instrumentation) {
  exactKeys(
    instrumentation,
    INSTRUMENTATION_KEYS,
    "Performance instrumentation",
  );
  exactKeys(
    instrumentation.calibration,
    CALIBRATION_KEYS,
    "Performance calibration",
  );
  if (
    instrumentation.longTaskObserverSupported !== true ||
    instrumentation.longAnimationFrameObserverSupported !== true ||
    instrumentation.calibration.longTaskObserved !== true ||
    instrumentation.calibration.longAnimationFrameObserved !== true ||
    instrumentation.calibration.sourceURL !== CDN_CALIBRATION_SCRIPT_URL
  ) {
    throw new Error(
      "Performance calibration must prove both observers and exact script attribution.",
    );
  }
}

export function validateCdnPerformanceArtifact(value) {
  exactKeys(value, TOP_LEVEL_KEYS, "CDN performance artifact");
  if (value.schemaVersion !== 4 || value.status !== "PASS") {
    throw new Error("CDN performance artifact must be a schema v4 PASS proof.");
  }
  if (!SHA_PATTERN.test(value.candidateSha ?? "")) {
    throw new Error(
      "CDN performance artifact must bind one full candidate SHA.",
    );
  }
  const startedAt = timestamp(value.startedAt, "Performance proof startedAt");
  const completedAt = timestamp(
    value.completedAt,
    "Performance proof completedAt",
  );
  if (completedAt < startedAt) {
    throw new Error("Performance proof completion must follow its start.");
  }
  exactKeys(value.artifact, ARTIFACT_KEYS, "Performance IIFE artifact");
  if (value.artifact.path !== "packages/adapters/vanilla/dist/auto.iife.js") {
    throw new Error("Performance proof must measure the canonical auto IIFE.");
  }
  if (!Number.isSafeInteger(value.artifact.bytes) || value.artifact.bytes < 1) {
    throw new TypeError(
      "Performance IIFE bytes must be a positive safe integer.",
    );
  }
  if (!SHA384_PATTERN.test(value.artifact.integrity ?? "")) {
    throw new Error("Performance IIFE integrity must be one SHA-384 token.");
  }
  exactKeys(value.browser, BROWSER_KEYS, "Performance browser");
  if (
    value.browser.name !== "chromium" ||
    typeof value.browser.version !== "string" ||
    value.browser.version.length === 0
  ) {
    throw new Error("Performance proof must identify its Chromium version.");
  }
  validateInstrumentation(value.instrumentation);
  if (!isDeepStrictEqual(value.profile, CDN_PERFORMANCE_PROFILE)) {
    throw new Error(
      "Performance proof profile does not match the pinned profile.",
    );
  }
  if (!isDeepStrictEqual(value.thresholds, CDN_PERFORMANCE_THRESHOLDS)) {
    throw new Error(
      "Performance proof thresholds do not match the immutable safeguards.",
    );
  }
  if (!Array.isArray(value.runs) || value.runs.length !== 6) {
    throw new Error(
      "Performance proof must contain exactly six runs in three pairs.",
    );
  }
  const runs = value.runs.map((run, index) =>
    validateRun(
      run,
      { ...CDN_PERFORMANCE_RUN_PLAN[index], sequence: index + 1 },
      value.artifact.integrity,
      { completedAt, startedAt },
    ),
  );
  const enabled = runs.filter(({ scenario }) => scenario === "enabled");
  const blocked = runs.filter(({ scenario }) => scenario === "blocked");
  if (enabled.length !== 3 || blocked.length !== 3) {
    throw new Error(
      "Performance proof must contain three enabled and blocked runs.",
    );
  }
  const computedSummary = {
    blockedMeanTotalBlockingTimeMs: mean(blocked),
    enabledMeanTotalBlockingTimeMs: mean(enabled),
    enabledOpenCookieAttributedLongTaskCount: 0,
    enabledWholePageLongTaskCount: enabled.reduce(
      (sum, run) => sum + run.longTasks.length,
      0,
    ),
  };
  exactKeys(value.summary, SUMMARY_KEYS, "Performance summary");
  if (!isDeepStrictEqual(value.summary, computedSummary)) {
    throw new Error(
      "Performance summary must equal the recomputed raw-run summary.",
    );
  }
  if (
    computedSummary.enabledMeanTotalBlockingTimeMs >=
    CDN_PERFORMANCE_THRESHOLDS.meanTotalBlockingTimeMs
  ) {
    throw new Error(
      `Enabled mean TBT must stay below ${String(CDN_PERFORMANCE_THRESHOLDS.meanTotalBlockingTimeMs)} ms.`,
    );
  }
  return value;
}

export function summarizeCdnPerformanceRuns(runs) {
  const enabled = runs.filter(({ scenario }) => scenario === "enabled");
  const blocked = runs.filter(({ scenario }) => scenario === "blocked");
  return Object.freeze({
    blockedMeanTotalBlockingTimeMs: mean(blocked),
    enabledMeanTotalBlockingTimeMs: mean(enabled),
    enabledOpenCookieAttributedLongTaskCount: 0,
    enabledWholePageLongTaskCount: enabled.reduce(
      (sum, run) => sum + run.longTasks.length,
      0,
    ),
  });
}
