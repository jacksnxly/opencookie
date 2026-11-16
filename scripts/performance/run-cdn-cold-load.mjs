import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

import { startE2EEnvironment } from "../e2e/fixture-supervisor.mjs";
import {
  sha384Integrity,
  validateCdnIntegrityMetadata,
} from "../verify-cdn-sri-lib.mjs";
import {
  assertCompileHint,
  CDN_CALIBRATION_SCRIPT_URL,
  CDN_CANDIDATE_SCRIPT_URL,
  CDN_PERFORMANCE_PROFILE,
  CDN_PERFORMANCE_RUN_PLAN,
  CDN_PERFORMANCE_THRESHOLDS,
  calculateTotalBlockingTime,
  summarizeCdnPerformanceRuns,
  validateCdnPerformanceArtifact,
} from "./cdn-cold-load-lib.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bundlePath = path.join(
  repositoryRoot,
  "packages/adapters/vanilla/dist/auto.iife.js",
);
const metadataPath = path.join(
  repositoryRoot,
  "packages/adapters/vanilla/cdn-integrity.json",
);
const outputPath = path.join(
  repositoryRoot,
  "artifacts/performance/cdn-cold-load.json",
);
const calibrationDocumentUrl = "http://performance.opencookie.test/";

function isCandidateUrl(value) {
  return value === CDN_CANDIDATE_SCRIPT_URL;
}

function intervalsOverlap(left, right) {
  return (
    left.startTime < right.startTime + right.duration &&
    right.startTime < left.startTime + left.duration
  );
}

async function candidateSha() {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return stdout.trim();
}

async function candidateArtifact() {
  const [bytes, metadataSource] = await Promise.all([
    readFile(bundlePath),
    readFile(metadataPath, "utf8"),
  ]);
  const metadata = validateCdnIntegrityMetadata(JSON.parse(metadataSource));
  assertCompileHint(bytes);
  const integrity = sha384Integrity(bytes);
  if (integrity !== metadata.integrity) {
    throw new Error(
      `Canonical IIFE integrity mismatch: metadata has ${metadata.integrity}, built bytes have ${integrity}.`,
    );
  }
  return Object.freeze({
    bytes: bytes.byteLength,
    integrity,
    path: "packages/adapters/vanilla/dist/auto.iife.js",
  });
}

export async function installPerformanceObservers(context) {
  await context.addInitScript(() => {
    if (globalThis !== globalThis.top) return;
    const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
    const state = {
      longAnimationFrameObserver: undefined,
      longAnimationFrameObserverSupported: supportedEntryTypes.includes(
        "long-animation-frame",
      ),
      longAnimationFrames: [],
      longTaskObserver: undefined,
      longTaskObserverSupported: supportedEntryTypes.includes("longtask"),
      longTasks: [],
    };
    const recordLongTasks = (entries) => {
      for (const entry of entries) {
        state.longTasks.push({
          duration: entry.duration,
          startTime: entry.startTime,
        });
      }
    };
    const recordLongAnimationFrames = (entries) => {
      for (const entry of entries) {
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
    };
    if (state.longTaskObserverSupported) {
      state.longTaskObserver = new PerformanceObserver((list) => {
        recordLongTasks(list.getEntries());
      });
      state.longTaskObserver.observe({ buffered: true, type: "longtask" });
    }
    if (state.longAnimationFrameObserverSupported) {
      state.longAnimationFrameObserver = new PerformanceObserver((list) => {
        recordLongAnimationFrames(list.getEntries());
      });
      state.longAnimationFrameObserver.observe({
        buffered: true,
        type: "long-animation-frame",
      });
    }
    Object.defineProperty(globalThis, "__ocColdLoadProof", {
      configurable: false,
      enumerable: false,
      value: {
        recordLongAnimationFrames,
        recordLongTasks,
        state,
      },
      writable: false,
    });
  });
}

async function readPerformanceWindow(page) {
  return page.evaluate(() => {
    const proof = globalThis.__ocColdLoadProof;
    const state = proof?.state;
    if (state?.longTaskObserver !== undefined) {
      proof.recordLongTasks(state.longTaskObserver.takeRecords());
    }
    if (state?.longAnimationFrameObserver !== undefined) {
      proof.recordLongAnimationFrames(
        state.longAnimationFrameObserver.takeRecords(),
      );
    }
    const firstContentfulPaint = performance
      .getEntriesByName("first-contentful-paint")
      .at(0);
    return {
      firstContentfulPaintMs: firstContentfulPaint?.startTime ?? null,
      longAnimationFrames: state?.longAnimationFrames ?? [],
      longTasks: state?.longTasks ?? [],
      measurementEndMs: performance.now(),
      observerSupport: {
        longAnimationFrame: state?.longAnimationFrameObserverSupported ?? false,
        longTask: state?.longTaskObserverSupported ?? false,
      },
    };
  });
}

export async function waitForLongTaskQuietWindow(
  page,
  {
    quietWindowMs = CDN_PERFORMANCE_PROFILE.longTaskQuietWindowMs,
    timeoutMs = CDN_PERFORMANCE_PROFILE.measurementTimeoutMs,
  } = {},
) {
  if (
    !Number.isFinite(quietWindowMs) ||
    quietWindowMs <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < quietWindowMs
  ) {
    throw new TypeError(
      "Long-task quiet-window timings must be finite, positive, and bounded by the timeout.",
    );
  }
  const waitStartedMs = await page.evaluate(() => performance.now());
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const measurement = await readPerformanceWindow(page);
    const lastLongTaskEndMs = measurement.longTasks.reduce(
      (latest, { duration, startTime }) =>
        Math.max(latest, startTime + duration),
      waitStartedMs,
    );
    const quietForMs = measurement.measurementEndMs - lastLongTaskEndMs;
    if (quietForMs >= quietWindowMs) return measurement;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `Page did not reach a ${String(quietWindowMs)} ms long-task-free window within ${String(timeoutMs)} ms.`,
      );
    }
    await page.waitForTimeout(
      Math.min(100, remainingMs, Math.max(1, quietWindowMs - quietForMs)),
    );
  }
}

async function configureCpuAndNetwork(session, { network }) {
  await session.send("Network.enable");
  const commands = [
    session.send("Network.setCacheDisabled", { cacheDisabled: true }),
    session.send("Emulation.setCPUThrottlingRate", {
      rate: CDN_PERFORMANCE_PROFILE.cpuSlowdownMultiplier,
    }),
  ];
  if (network) {
    commands.push(
      session.send("Network.emulateNetworkConditions", {
        connectionType: "cellular4g",
        downloadThroughput:
          CDN_PERFORMANCE_PROFILE.network.downloadThroughputBytesPerSecond,
        latency: CDN_PERFORMANCE_PROFILE.network.latencyMs,
        offline: false,
        uploadThroughput:
          CDN_PERFORMANCE_PROFILE.network.uploadThroughputBytesPerSecond,
      }),
    );
  }
  await Promise.all(commands);
}

async function calibrateObservers(browserType) {
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: CDN_PERFORMANCE_PROFILE.viewport,
  });
  let session;
  try {
    await installPerformanceObservers(context);
    await context.route(calibrationDocumentUrl, (route) =>
      route.fulfill({
        body: `<!doctype html><html><head><script src="${CDN_CALIBRATION_SCRIPT_URL}"></script></head><body>calibration</body></html>`,
        contentType: "text/html",
        status: 200,
      }),
    );
    await context.route(CDN_CALIBRATION_SCRIPT_URL, (route) =>
      route.fulfill({
        body: "const started = performance.now(); while (performance.now() - started < 80) {} globalThis.__ocCalibrationDone = true;",
        contentType: "text/javascript",
        status: 200,
      }),
    );
    const page = await context.newPage();
    session = await context.newCDPSession(page);
    await configureCpuAndNetwork(session, { network: false });
    await page.goto(calibrationDocumentUrl, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.__ocCalibrationDone === true);
    await page.waitForTimeout(250);
    const measurement = await readPerformanceWindow(page);
    const calibrationScripts = measurement.longAnimationFrames.flatMap(
      ({ scripts }) =>
        scripts.filter(
          ({ sourceURL, windowAttribution }) =>
            sourceURL === CDN_CALIBRATION_SCRIPT_URL &&
            windowAttribution === "self",
        ),
    );
    const calibrationLongTaskObserved = measurement.longTasks.some((task) =>
      calibrationScripts.some((script) => intervalsOverlap(task, script)),
    );
    return Object.freeze({
      calibration: Object.freeze({
        longAnimationFrameObserved: calibrationScripts.length > 0,
        longTaskObserved: calibrationLongTaskObserved,
        sourceURL: CDN_CALIBRATION_SCRIPT_URL,
      }),
      longAnimationFrameObserverSupported:
        measurement.observerSupport.longAnimationFrame,
      longTaskObserverSupported: measurement.observerSupport.longTask,
    });
  } finally {
    await session?.detach().catch(() => {});
    await context.close();
    await browser.close();
  }
}

async function runOne({ browser, environment, pair, scenario, sequence }) {
  const enabled = scenario === "enabled";
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    proxy: {
      server: `http://127.0.0.1:${String(environment.proxyPort)}`,
    },
    screen: CDN_PERFORMANCE_PROFILE.viewport,
    serviceWorkers: "block",
    viewport: CDN_PERFORMANCE_PROFILE.viewport,
  });
  const startedAt = new Date().toISOString();
  let session;
  try {
    await context.clearCookies();
    await installPerformanceObservers(context);
    if (!enabled) {
      await context.route(CDN_CANDIDATE_SCRIPT_URL, (route) =>
        route.abort("blockedbyclient"),
      );
    }
    const page = await context.newPage();
    session = await context.newCDPSession(page);
    await configureCpuAndNetwork(session, { network: true });

    const candidateRequestIds = new Set();
    const cachedCandidateRequestIds = new Set();
    const serviceWorkerCandidateRequestIds = new Set();
    session.on("Network.requestWillBeSent", ({ request, requestId }) => {
      if (isCandidateUrl(request.url)) candidateRequestIds.add(requestId);
    });
    session.on("Network.requestServedFromCache", ({ requestId }) => {
      if (candidateRequestIds.has(requestId)) {
        cachedCandidateRequestIds.add(requestId);
      }
    });
    session.on("Network.responseReceived", ({ requestId, response }) => {
      if (!candidateRequestIds.has(requestId)) return;
      if (
        response.fromDiskCache === true ||
        response.fromPrefetchCache === true
      ) {
        cachedCandidateRequestIds.add(requestId);
      }
      if (response.fromServiceWorker === true) {
        serviceWorkerCandidateRequestIds.add(requestId);
      }
    });

    let bundleRequestCount = 0;
    let bundleResponseCount = 0;
    let bundleResponseIntegrity = null;
    const responseJobs = [];
    page.on("request", (request) => {
      if (isCandidateUrl(request.url())) bundleRequestCount += 1;
    });
    page.on("response", (response) => {
      if (!isCandidateUrl(response.url())) return;
      bundleResponseCount += 1;
      responseJobs.push(
        response
          .body()
          .then((bytes) => {
            bundleResponseIntegrity = sha384Integrity(bytes);
          })
          .catch((error) => {
            throw new Error(
              `Could not hash the candidate IIFE response: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
      );
    });
    const url = `http://app.plain-cdn.opencookie.test:4400/?performance-run=${String(sequence)}`;
    await page.goto(url, { waitUntil: "load" });
    if (enabled) {
      await page.locator(".oc-bar").waitFor({
        state: "visible",
        timeout: 5_000,
      });
    }
    await page.waitForLoadState("networkidle");
    await Promise.all(responseJobs);
    const [namespacePresent, barVisible] = await Promise.all([
      page.evaluate(() => Boolean(globalThis.OpenCookie)),
      page.locator(".oc-bar").isVisible(),
    ]);
    const measurements = await waitForLongTaskQuietWindow(page);
    const totalBlockingTimeMs = calculateTotalBlockingTime(
      measurements.longTasks,
      measurements,
    );
    return Object.freeze({
      bundleCacheHitCount: cachedCandidateRequestIds.size,
      bundleRequestCount,
      bundleResponseCount,
      bundleResponseIntegrity,
      bundleServiceWorkerResponseCount: serviceWorkerCandidateRequestIds.size,
      completedAt: new Date().toISOString(),
      barVisible,
      firstContentfulPaintMs: measurements.firstContentfulPaintMs,
      longAnimationFrames: measurements.longAnimationFrames,
      longTasks: measurements.longTasks,
      measurementEndMs: measurements.measurementEndMs,
      namespacePresent,
      observerSupport: measurements.observerSupport,
      pair,
      scenario,
      sequence,
      startedAt,
      totalBlockingTimeMs,
    });
  } finally {
    await session?.detach().catch(() => {});
    await context.close();
  }
}

export async function runCdnColdLoadPerformance({
  browserType = chromium,
} = {}) {
  await rm(outputPath, { force: true });
  const [artifact, sha] = await Promise.all([
    candidateArtifact(),
    candidateSha(),
  ]);
  const startedAt = new Date().toISOString();
  const instrumentation = await calibrateObservers(browserType);
  const environment = await startE2EEnvironment({
    fixtureIds: ["plain-cdn"],
    proxyPort: 0,
    repositoryRoot,
  });
  let browser;
  try {
    browser = await browserType.launch({ headless: true });
    const browserVersion = browser.version();
    const runs = [];
    for (const [index, plan] of CDN_PERFORMANCE_RUN_PLAN.entries()) {
      runs.push(
        await runOne({
          browser,
          environment,
          ...plan,
          sequence: index + 1,
        }),
      );
    }
    const proof = {
      artifact,
      browser: { name: "chromium", version: browserVersion },
      candidateSha: sha,
      completedAt: new Date().toISOString(),
      instrumentation,
      profile: CDN_PERFORMANCE_PROFILE,
      runs,
      schemaVersion: 4,
      startedAt,
      status: "PASS",
      summary: summarizeCdnPerformanceRuns(runs),
      thresholds: CDN_PERFORMANCE_THRESHOLDS,
    };
    for (const run of runs) {
      console.log(
        `Cold run ${String(run.sequence)} ${run.scenario}: TBT ${String(run.totalBlockingTimeMs)} ms; long tasks ${JSON.stringify(run.longTasks)}.`,
      );
    }
    validateCdnPerformanceArtifact(proof);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    console.log(
      "CDN PERFORMANCE PASS: 3 enabled vs blocked throttled cold-load pairs.",
    );
    console.log(
      `Enabled mean whole-page mobile TBT: ${String(proof.summary.enabledMeanTotalBlockingTimeMs)} ms (< ${String(CDN_PERFORMANCE_THRESHOLDS.meanTotalBlockingTimeMs)} ms).`,
    );
    console.log("OpenCookie-attributed tasks lasting at least 50 ms: 0.");
    console.log(
      `Performance artifact: ${path.relative(repositoryRoot, outputPath)}`,
    );
    return proof;
  } finally {
    await browser?.close();
    await environment.close();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  try {
    await runCdnColdLoadPerformance();
  } catch (error) {
    console.error(
      `[verify-performance] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
