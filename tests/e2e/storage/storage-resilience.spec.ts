import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";

import { createStorageContractCases } from "../../../scripts/e2e/storage-contract-catalogue.mjs";
import {
  installStorageFault,
  type StorageFault,
  type StorageFaultGlobal,
  type StorageFaultSnapshot,
} from "./support/storage-faults.js";

interface StorageIntegration {
  readonly fixtureId: "plain-cdn" | "react-vite";
  readonly id: "plain-cdn-auto" | "react-vite-generic";
  readonly integration: "auto" | "generic";
}

interface StorageContractCase {
  readonly contract: string;
  readonly fault: StorageFault;
  readonly id: string;
  readonly integration: StorageIntegration;
  readonly mechanism: string;
  readonly recoveryOutcome?: "policy-remains-blocked";
  readonly route: "/__storage/cookie" | "/__storage/local";
}

interface TargetResult {
  readonly page: Page;
  readonly target: Frame | Page;
  readonly url: string;
}

const storageCases =
  createStorageContractCases() as readonly StorageContractCase[];
if (storageCases.length !== 12) {
  throw new Error("The storage suite requires exactly 12 logical cases.");
}

function fixtureUrl(contractCase: StorageContractCase): string {
  return `http://app.${contractCase.integration.fixtureId}.opencookie.test:4400${contractCase.route}`;
}

async function configureFault(
  context: BrowserContext,
  contractCase: StorageContractCase,
): Promise<void> {
  await context.addInitScript(installStorageFault, {
    fault: contractCase.fault,
    route: contractCase.route,
  });
}

function trackerRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname.startsWith("tracker.")) requests.push(request.url());
  });
  return requests;
}

async function openTarget(
  page: Page,
  contractCase: StorageContractCase,
): Promise<TargetResult> {
  const url = fixtureUrl(contractCase);
  if (
    contractCase.fault !== "deterministic-cross-site-cookie-denial-emulation"
  ) {
    const response = await page.goto(url, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    return { page, target: page, url };
  }

  const parentUrl = "http://storage-policy.test:4400/storage-parent";
  await page.route(`${parentUrl}*`, async (route) => {
    await route.fulfill({
      body: `<!doctype html><html lang="en"><head><title>Deterministic storage policy emulation</title></head><body><h1>Deterministic emulation</h1><iframe title="Cross-site consent fixture" src="${url}" style="width:100%;height:760px;border:0"></iframe></body></html>`,
      contentType: "text/html",
      status: 200,
    });
  });
  const response = await page.goto(parentUrl, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Deterministic emulation" }),
  ).toBeVisible();
  const target = page.frames().find((frame) => frame.url().startsWith(url));
  if (target === undefined) {
    throw new Error("The deterministic cross-site fixture frame did not load.");
  }
  return { page, target, url };
}

async function ready(
  target: Frame | Page,
  contractCase: StorageContractCase,
): Promise<void> {
  if (contractCase.integration.id === "react-vite-generic") {
    await expect(target.locator('html[data-oc-ready="true"]')).toBeVisible();
  }
  await expect(target.locator(".oc-bar")).toBeVisible();
  await expect(target.locator("dialog.oc-panel")).toHaveCount(1);
  await expect(target.locator("dialog.oc-panel")).toBeHidden();
}

async function snapshot(target: Frame | Page): Promise<StorageFaultSnapshot> {
  return target.evaluate(() => {
    const control = (globalThis as unknown as StorageFaultGlobal)
      .__ocStorageFaultControl;
    if (control === undefined) {
      throw new Error("The storage fault control is missing.");
    }
    return control.snapshot();
  });
}

async function release(target: Frame | Page): Promise<void> {
  await target.evaluate(() => {
    const control = (globalThis as unknown as StorageFaultGlobal)
      .__ocStorageFaultControl;
    if (control === undefined) {
      throw new Error("The storage fault control is missing.");
    }
    control.release();
  });
}

async function analyticsLoads(target: Frame | Page): Promise<number> {
  return target.evaluate(
    () => (globalThis as unknown as StorageFaultGlobal).__ocAnalyticsLoads ?? 0,
  );
}

async function assertBlocked(
  target: Frame | Page,
  requests: readonly string[],
): Promise<void> {
  expect(await analyticsLoads(target)).toBe(0);
  await expect(
    target.locator('[data-oc-active-resource="analytics-script"]'),
  ).toHaveCount(0);
  await expect(
    target.locator('iframe[data-oc-resource="product-video"]'),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
}

async function attachEvidence(
  testInfo: TestInfo,
  contractCase: StorageContractCase,
  evidence: Record<string, unknown>,
): Promise<void> {
  const evidencePath = testInfo.outputPath("storage-evidence.json");
  const serializedEvidence = `${JSON.stringify(
    {
      browser: String(testInfo.project.metadata["browserLabel"]),
      contract: contractCase.contract,
      integration: contractCase.integration.id,
      mechanism: contractCase.mechanism,
      ...evidence,
    },
    null,
    2,
  )}\n`;
  await writeFile(evidencePath, serializedEvidence, "utf8");
  await testInfo.attach("storage-evidence", {
    contentType: "application/json",
    path: evidencePath,
  });
}

function serializedDecision(observation: StorageFaultSnapshot): string {
  return `${observation.localDecision ?? ""} ${decodeURIComponent(
    observation.cookieHeader,
  )}`;
}

async function runRecoverableFailure(
  page: Page,
  contractCase: StorageContractCase,
  testInfo: TestInfo,
): Promise<void> {
  const requests = trackerRequests(page);
  const opened = await openTarget(page, contractCase);
  const { target, url } = opened;
  await ready(target, contractCase);
  await assertBlocked(target, requests);

  const initial = await snapshot(target);
  expect(initial.active).toBe(true);
  expect(initial.globalControlEnumerable).toBe(false);
  await target.getByRole("button", { name: "Accept all", exact: true }).click();

  const alert = target.getByRole("alert");
  const retry = target.getByRole("button", {
    exact: true,
    name: "Try saving again",
  });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("could not save");
  await expect(retry).toBeVisible();
  await expect(
    target.getByRole("button", { name: "Privacy choices", exact: true }),
  ).toBeVisible();
  await expect(target.locator("dialog.oc-panel")).toBeHidden();
  await assertBlocked(target, requests);
  const pending = await snapshot(target);
  expect(serializedDecision(pending)).not.toContain('"method":"accept-all"');

  await release(target);
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press("Enter");

  await expect(
    target.getByRole("button", { name: "Privacy choices", exact: true }),
  ).toBeVisible();
  await expect(target.locator("dialog.oc-panel")).toHaveCount(1);
  await expect(target.locator("dialog.oc-panel")).toBeHidden();
  await expect(alert).toHaveCount(0);
  await expect.poll(() => analyticsLoads(target)).toBe(1);
  const recovered = await snapshot(target);
  expect(recovered.released).toBe(true);
  expect(serializedDecision(recovered)).toContain('"method":"accept-all"');

  await target.goto(url, { waitUntil: "networkidle" });
  if (contractCase.integration.id === "react-vite-generic") {
    await expect(target.locator('html[data-oc-ready="true"]')).toBeVisible();
  }
  await expect(target.locator("dialog.oc-panel")).toHaveCount(1);
  await expect(target.locator("dialog.oc-panel")).toBeHidden();
  await expect(
    target.getByRole("button", { name: "Privacy choices", exact: true }),
  ).toBeVisible();
  await expect.poll(() => analyticsLoads(target)).toBe(1);
  const reloaded = await snapshot(target);
  expect(reloaded.released).toBe(true);
  expect(serializedDecision(reloaded)).toContain('"method":"accept-all"');

  await attachEvidence(testInfo, contractCase, {
    final: reloaded,
    initial,
    pending,
    recoveryInput: "keyboard Enter",
    trackerRequests: requests,
  });
}

async function runPersistentPolicyDenial(
  page: Page,
  contractCase: StorageContractCase,
  testInfo: TestInfo,
): Promise<void> {
  const requests = trackerRequests(page);
  const { target } = await openTarget(page, contractCase);
  await ready(target, contractCase);
  await assertBlocked(target, requests);

  const initial = await snapshot(target);
  expect(initial.active).toBe(true);
  expect(initial.released).toBe(false);
  expect(initial.globalControlEnumerable).toBe(false);
  await target.getByRole("button", { name: "Accept all", exact: true }).click();

  const alert = target.getByRole("alert");
  const retry = target.getByRole("button", {
    exact: true,
    name: "Try saving again",
  });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("could not save");
  await expect(retry).toBeVisible();
  await expect(
    target.getByRole("button", { name: "Privacy choices", exact: true }),
  ).toBeVisible();
  await expect(target.locator("dialog.oc-panel")).toBeHidden();
  await assertBlocked(target, requests);
  const beforeRetry = await snapshot(target);
  expect(beforeRetry.released).toBe(false);
  expect(beforeRetry.operations.cookieWrites).toBeGreaterThan(
    initial.operations.cookieWrites,
  );
  expect(serializedDecision(beforeRetry)).not.toContain(
    '"method":"accept-all"',
  );

  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press("Enter");

  await expect
    .poll(async () => (await snapshot(target)).operations.cookieWrites)
    .toBeGreaterThan(beforeRetry.operations.cookieWrites);
  await expect(alert).toBeVisible();
  await expect(retry).toBeVisible();
  await expect(
    target.getByRole("button", { name: "Privacy choices", exact: true }),
  ).toBeVisible();
  await expect(target.locator("dialog.oc-panel")).toBeHidden();
  await assertBlocked(target, requests);
  const afterRetry = await snapshot(target);
  expect(afterRetry.released).toBe(false);
  expect(serializedDecision(afterRetry)).not.toContain('"method":"accept-all"');

  await attachEvidence(testInfo, contractCase, {
    afterRetry,
    afterRetryOperations: afterRetry.operations,
    beforeRetry,
    beforeRetryOperations: beforeRetry.operations,
    initial,
    policyLabel: "deterministic emulation",
    recoveryInput: "keyboard Enter",
    recoveryOutcome: "policy-remains-blocked",
    released: false,
    trackerRequests: requests,
  });
}

async function newIsolatedContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    hasTouch: false,
    proxy: { server: "http://127.0.0.1:4400" },
    screen: { height: 900, width: 1440 },
    viewport: { height: 900, width: 1440 },
  });
}

async function runContextEphemerality(
  browser: Browser,
  page: Page,
  contractCase: StorageContractCase,
  testInfo: TestInfo,
): Promise<void> {
  const url = fixtureUrl(contractCase);
  const contextARequests = trackerRequests(page);
  const response = await page.goto(url, { waitUntil: "networkidle" });
  expect(response?.status()).toBe(200);
  await ready(page, contractCase);
  await assertBlocked(page, contextARequests);
  await page.getByRole("button", { name: "Accept all", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Privacy choices", exact: true }),
  ).toBeVisible();
  await expect.poll(() => analyticsLoads(page)).toBe(1);
  const contextA = await snapshot(page);
  expect(serializedDecision(contextA)).toContain('"method":"accept-all"');

  const secondContext = await newIsolatedContext(browser);
  let contextB: StorageFaultSnapshot;
  try {
    await configureFault(secondContext, contractCase);
    const secondPage = await secondContext.newPage();
    const contextBRequests = trackerRequests(secondPage);
    const secondResponse = await secondPage.goto(url, {
      waitUntil: "networkidle",
    });
    expect(secondResponse?.status()).toBe(200);
    await ready(secondPage, contractCase);
    await assertBlocked(secondPage, contextBRequests);
    contextB = await snapshot(secondPage);
    expect(serializedDecision(contextB)).not.toContain('"method":"accept-all"');
  } finally {
    await secondContext.close();
  }

  await attachEvidence(testInfo, contractCase, {
    "context A": contextA,
    "context B": contextB,
    isolation: "nonpersistent BrowserContext storage",
  });
}

for (const contractCase of storageCases) {
  test(`${contractCase.contract} ${contractCase.integration.id}`, async ({
    browser,
    context,
    page,
  }, testInfo) => {
    await configureFault(context, contractCase);
    if (
      contractCase.fault === "deterministic-cross-site-cookie-denial-emulation"
    ) {
      await runPersistentPolicyDenial(page, contractCase, testInfo);
      return;
    }
    if (contractCase.fault === "context-ephemerality") {
      await runContextEphemerality(browser, page, contractCase, testInfo);
      return;
    }
    await runRecoverableFailure(page, contractCase, testInfo);
  });
}
