import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { chromium } from "@playwright/test";

import {
  CDN_PERFORMANCE_PROFILE,
  CDN_PERFORMANCE_RUN_PLAN,
  CDN_COMPILE_HINT,
  CDN_PERFORMANCE_THRESHOLDS,
  assertCompileHint,
  calculateTotalBlockingTime,
  validateCdnPerformanceArtifact,
} from "./cdn-cold-load-lib.mjs";

const integrity = `sha384-${"A".repeat(64)}`;
const candidateUrl =
  "http://app.plain-cdn.opencookie.test:4400/__opencookie/auto.iife.js";
const calibrationUrl = "http://performance.opencookie.test/calibration.js";

async function observeCandidateScript(scriptBody) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await context.addInitScript(() => {
      const state = { longAnimationFrames: [], longTasks: [] };
      const longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            duration: entry.duration,
            startTime: entry.startTime,
          });
        }
      });
      const longAnimationFrameObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longAnimationFrames.push({
            blockingDuration: entry.blockingDuration,
            duration: entry.duration,
            renderStart: entry.renderStart,
            scripts: entry.scripts.map((script) => ({
              duration: script.duration,
              executionStart: script.executionStart,
              forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
              invoker: script.invoker,
              invokerType: script.invokerType,
              pauseDuration: script.pauseDuration,
              sourceCharPosition: script.sourceCharPosition,
              sourceFunctionName: script.sourceFunctionName,
              sourceURL: script.sourceURL,
              startTime: script.startTime,
              windowAttribution: script.windowAttribution,
            })),
            startTime: entry.startTime,
            styleAndLayoutStart: entry.styleAndLayoutStart,
          });
        }
      });
      longTaskObserver.observe({ buffered: true, type: "longtask" });
      longAnimationFrameObserver.observe({
        buffered: true,
        type: "long-animation-frame",
      });
      Object.defineProperty(globalThis, "__performanceTest", {
        value: { longAnimationFrameObserver, longTaskObserver, state },
      });
    });
    await context.route("http://performance.opencookie.test/**", (route) =>
      route.fulfill({
        body: `<!doctype html><script src="${candidateUrl}"></script><p>ready</p>`,
        contentType: "text/html",
        status: 200,
      }),
    );
    await context.route(candidateUrl, (route) =>
      route.fulfill({
        body: scriptBody,
        contentType: "text/javascript",
        status: 200,
      }),
    );
    const page = await context.newPage();
    await page.goto("http://performance.opencookie.test/multi-short", {
      waitUntil: "load",
    });
    await page.waitForFunction(() => globalThis.__candidateDone === true);
    await page.waitForTimeout(250);
    return await page.evaluate(() => {
      const proof = globalThis.__performanceTest;
      for (const entry of proof.longTaskObserver.takeRecords()) {
        proof.state.longTasks.push({
          duration: entry.duration,
          startTime: entry.startTime,
        });
      }
      for (const entry of proof.longAnimationFrameObserver.takeRecords()) {
        proof.state.longAnimationFrames.push({
          blockingDuration: entry.blockingDuration,
          duration: entry.duration,
          renderStart: entry.renderStart,
          scripts: entry.scripts.map((script) => ({
            duration: script.duration,
            executionStart: script.executionStart,
            forcedStyleAndLayoutDuration: script.forcedStyleAndLayoutDuration,
            invoker: script.invoker,
            invokerType: script.invokerType,
            pauseDuration: script.pauseDuration,
            sourceCharPosition: script.sourceCharPosition,
            sourceFunctionName: script.sourceFunctionName,
            sourceURL: script.sourceURL,
            startTime: script.startTime,
            windowAttribution: script.windowAttribution,
          })),
          startTime: entry.startTime,
          styleAndLayoutStart: entry.styleAndLayoutStart,
        });
      }
      return {
        longAnimationFrames: proof.state.longAnimationFrames,
        longTasks: proof.state.longTasks,
        measurementEndMs: performance.now(),
      };
    });
  } finally {
    await context.close();
    await browser.close();
  }
}

function scriptTiming({
  duration = 10,
  sourceURL = "http://app.plain-cdn.opencookie.test:4400/fixture.js",
  startTime = 200,
  windowAttribution = "self",
} = {}) {
  return {
    duration,
    executionStart: startTime,
    forcedStyleAndLayoutDuration: 0,
    invoker: sourceURL,
    invokerType: "classic-script",
    pauseDuration: 0,
    sourceCharPosition: 0,
    sourceFunctionName: "",
    sourceURL,
    startTime,
    windowAttribution,
  };
}

function longAnimationFrame({
  duration = 100,
  scripts = [],
  startTime = 190,
} = {}) {
  return {
    blockingDuration: Math.max(0, duration - 50),
    duration,
    renderStart: startTime + duration - 10,
    scripts,
    startTime,
    styleAndLayoutStart: startTime + duration - 5,
  };
}

function validRun(sequence, pair, scenario) {
  const enabled = scenario === "enabled";
  return {
    bundleCacheHitCount: 0,
    bundleRequestCount: 1,
    bundleResponseCount: enabled ? 1 : 0,
    bundleResponseIntegrity: enabled ? integrity : null,
    bundleServiceWorkerResponseCount: 0,
    completedAt: `2026-08-25T00:00:0${String(sequence)}.500Z`,
    barVisible: enabled,
    firstContentfulPaintMs: 100,
    longAnimationFrames: [],
    longTasks: [],
    measurementEndMs: 5_100,
    namespacePresent: enabled,
    observerSupport: { longAnimationFrame: true, longTask: true },
    pair,
    scenario,
    sequence,
    startedAt: `2026-08-25T00:00:0${String(sequence)}.000Z`,
    totalBlockingTimeMs: 0,
  };
}

function validArtifact() {
  const runs = CDN_PERFORMANCE_RUN_PLAN.map(({ pair, scenario }, index) =>
    validRun(index + 1, pair, scenario),
  );
  return {
    artifact: {
      bytes: 98_407,
      integrity,
      path: "packages/adapters/vanilla/dist/auto.iife.js",
    },
    browser: { name: "chromium", version: "140.0.7339.16" },
    candidateSha: "a".repeat(40),
    completedAt: "2026-08-25T00:00:07.000Z",
    instrumentation: {
      calibration: {
        longAnimationFrameObserved: true,
        longTaskObserved: true,
        sourceURL: calibrationUrl,
      },
      longAnimationFrameObserverSupported: true,
      longTaskObserverSupported: true,
    },
    profile: structuredClone(CDN_PERFORMANCE_PROFILE),
    runs,
    schemaVersion: 4,
    startedAt: "2026-08-25T00:00:00.000Z",
    status: "PASS",
    summary: {
      blockedMeanTotalBlockingTimeMs: 0,
      enabledMeanTotalBlockingTimeMs: 0,
      enabledOpenCookieAttributedLongTaskCount: 0,
      enabledWholePageLongTaskCount: 0,
    },
    thresholds: structuredClone(CDN_PERFORMANCE_THRESHOLDS),
  };
}

function setEnabledUnrelatedTask(artifact, runIndex, duration) {
  const run = artifact.runs[runIndex];
  run.longTasks = [{ duration, startTime: 200 }];
  run.longAnimationFrames = [longAnimationFrame({ duration: duration + 20 })];
  run.totalBlockingTimeMs = Math.max(0, duration - 50);
}

test("pins three paired mobile cold loads and immutable safeguards", () => {
  assert.deepEqual(CDN_PERFORMANCE_RUN_PLAN, [
    { pair: 1, scenario: "enabled" },
    { pair: 1, scenario: "blocked" },
    { pair: 2, scenario: "blocked" },
    { pair: 2, scenario: "enabled" },
    { pair: 3, scenario: "enabled" },
    { pair: 3, scenario: "blocked" },
  ]);
  assert.deepEqual(CDN_PERFORMANCE_PROFILE, {
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
  assert.deepEqual(CDN_PERFORMANCE_THRESHOLDS, {
    longTaskDurationMs: 50,
    meanTotalBlockingTimeMs: 20,
  });
});

// @covers PP-21 REQ-SIZE-BUDGETS: synchronous boot cost is measured, not assumed.
test("computes whole-page TBT from every task in the measured window", () => {
  assert.equal(
    calculateTotalBlockingTime(
      [
        { duration: 49.9, startTime: 150 },
        { duration: 80, startTime: 300 },
        { duration: 55, startTime: 1_050 },
      ],
      { firstContentfulPaintMs: 100, measurementEndMs: 1_000 },
    ),
    30,
  );
});

test("clips long tasks to First Contentful Paint and the measurement end", () => {
  assert.equal(
    calculateTotalBlockingTime([{ duration: 250, startTime: 50 }], {
      firstContentfulPaintMs: 100,
      measurementEndMs: 400,
    }),
    150,
  );
  assert.equal(
    calculateTotalBlockingTime([{ duration: 200, startTime: 900 }], {
      firstContentfulPaintMs: 100,
      measurementEndMs: 1_000,
    }),
    50,
  );
});

test("accepts the exact raw six-run attribution proof", () => {
  assert.equal(validateCdnPerformanceArtifact(validArtifact()).status, "PASS");
});

test("rejects stale schema v3 performance evidence", () => {
  const artifact = validArtifact();
  artifact.schemaVersion = 3;
  assert.throws(() => validateCdnPerformanceArtifact(artifact), /schema v4/iu);
});

test("rejects the fixed one-second post-networkidle profile", () => {
  const artifact = validArtifact();
  artifact.profile = {
    cpuSlowdownMultiplier: 4,
    measurementWindowAfterNetworkIdleMs: 1_000,
    network: {
      downloadThroughputBytesPerSecond: 200_000,
      latencyMs: 150,
      uploadThroughputBytesPerSecond: 93_750,
    },
    runsPerScenario: 3,
    viewport: { height: 844, width: 390 },
  };
  assert.throws(() => validateCdnPerformanceArtifact(artifact), /profile/iu);
});

test("real Chromium measurement resets a five-second quiet window for delayed candidate work", async () => {
  const runner = await import("./run-cdn-cold-load.mjs");
  assert.equal(typeof runner.installPerformanceObservers, "function");
  assert.equal(typeof runner.waitForLongTaskQuietWindow, "function");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  try {
    await runner.installPerformanceObservers(context);
    await context.route("http://performance.opencookie.test/**", (route) =>
      route.fulfill({
        body: `<!doctype html><script src="${candidateUrl}"></script><p>ready</p>`,
        contentType: "text/html",
        status: 200,
      }),
    );
    await context.route(candidateUrl, (route) =>
      route.fulfill({
        body: `
          setTimeout(() => {
            const started = performance.now();
            while (performance.now() - started < 65) {}
            globalThis.__delayedCandidateDone = true;
          }, 1_200);
        `,
        contentType: "text/javascript",
        status: 200,
      }),
    );
    const page = await context.newPage();
    await page.goto("http://performance.opencookie.test/delayed", {
      waitUntil: "load",
    });
    const waitStartedMs = await page.evaluate(() => performance.now());
    const measurement = await runner.waitForLongTaskQuietWindow(page);
    const delayedTask = measurement.longTasks.find(
      ({ duration, startTime }) =>
        duration >= 50 && startTime >= waitStartedMs + 900,
    );
    assert.ok(
      delayedTask,
      "the quiet-window measurement must retain delayed work",
    );
    assert.equal(
      await page.evaluate(() => globalThis.__delayedCandidateDone === true),
      true,
    );
    assert.ok(
      measurement.measurementEndMs -
        (delayedTask.startTime + delayedTask.duration) >=
        CDN_PERFORMANCE_PROFILE.longTaskQuietWindowMs,
      "measurement must continue for five quiet seconds after the delayed task",
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test("rejects evidence captured before five quiet seconds follow the last task", () => {
  const artifact = validArtifact();
  const run = artifact.runs[1];
  run.longTasks = [{ duration: 50, startTime: 200 }];
  run.measurementEndMs = 5_249;
  assert.throws(
    () => validateCdnPerformanceArtifact(artifact),
    /five-second long-task-free window/iu,
  );
});

test("rejects every enabled long task even when LoAF has no script attribution", () => {
  const artifact = validArtifact();
  setEnabledUnrelatedTask(artifact, 0, 80);
  artifact.summary.enabledWholePageLongTaskCount = 1;
  artifact.summary.enabledMeanTotalBlockingTimeMs = 10;

  assert.throws(
    () => validateCdnPerformanceArtifact(artifact),
    /enabled long task/iu,
  );
});

test("real Chromium evidence fails closed when short candidate callbacks hide LoAF attribution", async () => {
  // About 72 ms of candidate work in slices Chromium does not attribute,
  // since each script entry stays under its 5 ms floor. A slice's wall time is
  // its loop plus any scheduling gap, so 2 ms slices keep 3 ms of room where
  // 3.2 ms slices kept 1.8 ms, which a loaded run of this suite overran.
  const measurement = await observeCandidateScript(`
    for (let index = 0; index < 36; index += 1) {
      document.addEventListener("DOMContentLoaded", () => {
        const started = performance.now();
        while (performance.now() - started < 2) {}
      });
    }
    document.addEventListener("DOMContentLoaded", () => {
      globalThis.__candidateDone = true;
    });
  `);
  const candidateScripts = measurement.longAnimationFrames.flatMap(
    ({ scripts }) =>
      scripts.filter(({ sourceURL }) => sourceURL === candidateUrl),
  );
  assert.equal(candidateScripts.length, 0);
  const task = measurement.longTasks.find(({ duration }) => duration >= 50);
  assert.ok(task, "Chromium must expose the combined callbacks as a Long Task");

  const artifact = validArtifact();
  const run = artifact.runs[0];
  run.firstContentfulPaintMs = 0;
  run.longAnimationFrames = measurement.longAnimationFrames;
  run.longTasks = [task];
  run.measurementEndMs = measurement.measurementEndMs;
  run.totalBlockingTimeMs = calculateTotalBlockingTime(run.longTasks, run);
  artifact.summary.enabledMeanTotalBlockingTimeMs = Number(
    (run.totalBlockingTimeMs / 3).toFixed(3),
  );
  artifact.summary.enabledWholePageLongTaskCount = 1;

  assert.throws(
    () => validateCdnPerformanceArtifact(artifact),
    /enabled long task/iu,
  );
});

test("does not attribute exact-looking URL variants to OpenCookie", () => {
  for (const sourceURL of [
    `${candidateUrl}.evil`,
    "http://evil.test/__opencookie/auto.iife.js",
    "http://app.plain-cdn.opencookie.test:4400/__opencookie/%61uto.iife.js",
  ]) {
    const artifact = validArtifact();
    artifact.runs[0].longAnimationFrames = [
      longAnimationFrame({
        scripts: [scriptTiming({ duration: 20, sourceURL, startTime: 210 })],
      }),
    ];
    assert.equal(validateCdnPerformanceArtifact(artifact).status, "PASS");
  }
});

for (const [label, mutate, expected] of [
  ["fewer than three pairs", (value) => value.runs.pop(), /six runs/iu],
  [
    "changed throttle profile",
    (value) => {
      value.profile.cpuSlowdownMultiplier = 3;
    },
    /profile/iu,
  ],
  [
    "missing calibration",
    (value) => {
      value.instrumentation.calibration.longTaskObserved = false;
    },
    /calibration/iu,
  ],
  [
    "wrong calibration source",
    (value) => {
      value.instrumentation.calibration.sourceURL = `${calibrationUrl}.evil`;
    },
    /calibration/iu,
  ],
  [
    "unsupported attribution observer",
    (value) => {
      value.runs[0].observerSupport.longAnimationFrame = false;
    },
    /observer/iu,
  ],
  [
    "missing enabled bundle execution",
    (value) => {
      value.runs[0].namespacePresent = false;
    },
    /namespace/iu,
  ],
  [
    "consent bar rendered while blocked",
    (value) => {
      value.runs[1].barVisible = true;
    },
    /blocked.*bar/iu,
  ],
  [
    "stale response digest",
    (value) => {
      value.runs[0].bundleResponseIntegrity = `sha384-${"B".repeat(64)}`;
    },
    /integrity/iu,
  ],
  [
    "a candidate-attributed 50 ms task",
    (value) => {
      value.runs[0].longTasks = [{ duration: 50, startTime: 200 }];
      value.runs[0].longAnimationFrames = [
        longAnimationFrame({
          scripts: [scriptTiming({ sourceURL: candidateUrl })],
        }),
      ];
    },
    /enabled long task/iu,
  ],
  [
    "a 50 ms candidate script",
    (value) => {
      value.runs[0].longAnimationFrames = [
        longAnimationFrame({
          scripts: [scriptTiming({ duration: 50, sourceURL: candidateUrl })],
        }),
      ];
    },
    /candidate script.*50 ms/iu,
  ],
  [
    "an enabled long task without LoAF coverage",
    (value) => {
      value.runs[0].longTasks = [{ duration: 50, startTime: 200 }];
    },
    /enabled long task/iu,
  ],
  [
    "candidate script evidence while blocked",
    (value) => {
      value.runs[1].longAnimationFrames = [
        longAnimationFrame({
          scripts: [scriptTiming({ sourceURL: candidateUrl })],
        }),
      ];
    },
    /blocked.*candidate script/iu,
  ],
  [
    "a bundle cache hit",
    (value) => {
      value.runs[0].bundleCacheHitCount = 1;
    },
    /cache/iu,
  ],
  [
    "a service-worker bundle response",
    (value) => {
      value.runs[0].bundleServiceWorkerResponseCount = 1;
    },
    /service worker/iu,
  ],
  [
    "a forged sub-threshold Long Tasks API entry",
    (value) => {
      value.runs[1].longTasks = [{ duration: 49.9, startTime: 200 }];
    },
    /raw long-task duration/iu,
  ],
  [
    "mean TBT at the boundary",
    (value) => {
      for (const index of [0, 3, 4]) setEnabledUnrelatedTask(value, index, 250);
      value.summary.enabledWholePageLongTaskCount = 3;
      value.summary.enabledMeanTotalBlockingTimeMs = 200;
    },
    /enabled long task/iu,
  ],
  [
    "forged summary",
    (value) => {
      value.summary.enabledMeanTotalBlockingTimeMs = 1;
      value.runs[0].totalBlockingTimeMs = 10;
    },
    /recomputed|summary|TBT/iu,
  ],
  [
    "nonfinite measurement",
    (value) => {
      value.runs[0].measurementEndMs = Number.NaN;
    },
    /finite/iu,
  ],
]) {
  test(`rejects ${label}`, () => {
    const artifact = validArtifact();
    mutate(artifact);
    assert.throws(() => validateCdnPerformanceArtifact(artifact), expected);
  });
}

test("records a proof for an artifact above the byte budget", () => {
  const artifact = validArtifact();
  artifact.artifact.bytes = 115_195;
  assert.doesNotThrow(() => {
    validateCdnPerformanceArtifact(artifact);
  });
});

test("still rejects an impossible artifact byte count", () => {
  const artifact = validArtifact();
  artifact.artifact.bytes = 0;
  assert.throws(() => {
    validateCdnPerformanceArtifact(artifact);
  }, /bytes/iu);
});

test("the run summary reports the configured blocking-time threshold", () => {
  const runner = readFileSync(
    new URL("./run-cdn-cold-load.mjs", import.meta.url),
    "utf8",
  );
  const summaryLine = runner
    .split("\n")
    .find((line) => line.includes("Enabled mean whole-page mobile TBT"));
  assert.ok(
    summaryLine !== undefined,
    "the runner must report an enabled mean blocking time",
  );
  assert.ok(
    summaryLine.includes("CDN_PERFORMANCE_THRESHOLDS.meanTotalBlockingTimeMs"),
    "the reported threshold must derive from the configured constant, not a literal that can silently diverge from what is enforced",
  );
});

// The drop-in must reach the browser with V8's eager-compile hint as its first
// line, or Chrome compiles it lazily on the main thread at first call. Checked on
// the emitted bytes rather than the build config, so a bundler that drops or
// reorders the comment during minification is caught too.
test("the candidate artifact must open with the V8 eager-compile hint", () => {
  assert.equal(CDN_COMPILE_HINT, "//# allFunctionsCalledOnLoad");
  assert.doesNotThrow(() =>
    assertCompileHint(Buffer.from(`${CDN_COMPILE_HINT}\n(function(){})();`)),
  );
  assert.throws(
    () => assertCompileHint(Buffer.from("(function(){})();")),
    /eager-compile hint/u,
  );
  assert.throws(
    () =>
      assertCompileHint(
        Buffer.from(`(function(){})();\n${CDN_COMPILE_HINT}\n`),
      ),
    /eager-compile hint/u,
  );
});
