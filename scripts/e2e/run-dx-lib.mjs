function assertInitialization(result, expectedStatus, caseId) {
  if (result.status !== expectedStatus) {
    throw new Error(
      `${caseId} init expected ${expectedStatus} but reported ${String(result.status)}.`,
    );
  }
}

export const EXPECTED_DEMO_REQUEST_COUNTS = Object.freeze([0, 1, 2, 2, 3, 3]);

export const RICH_MODULE_REQUEST_PATHS = Object.freeze([
  "/opencookie-rich-evidence/packages/core-domain.js",
  "/opencookie-rich-evidence/packages/core-infrastructure.js",
  "/opencookie-rich-evidence/packages/core.js",
  "/opencookie-rich-evidence/packages/vanilla.js",
]);

const CATEGORY_SELECTION_PURPOSE_IDS = Object.freeze([
  "ads",
  "analytics",
  "recommendations",
]);
const ALL_RICH_PURPOSE_IDS = Object.freeze([
  "ads",
  "analytics",
  "profile",
  "recommendations",
]);
const GENERATED_PANEL_TAB_ORDER = Object.freeze([
  "opencookie-category:optional",
  "opencookie-purpose:analytics",
  "save",
  "close",
  "opencookie-category:optional",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    hasExactArray(Object.keys(value).sort(), [...keys].sort())
  );
}

function hasExactDemoRequestCounts(value) {
  return (
    Array.isArray(value) &&
    value.length === EXPECTED_DEMO_REQUEST_COUNTS.length &&
    value.every((count, index) => count === EXPECTED_DEMO_REQUEST_COUNTS[index])
  );
}

function hasExactArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function hasCommittedSelection(
  value,
  {
    categoryState,
    nestedCategoryState,
    persistedGrantedPurposeIds,
    resourceActive,
    resourceExecutions,
    resourceRequests,
    selectedPurposeIds,
  },
) {
  return (
    hasExactKeys(value, [
      "categoryState",
      "nestedCategoryState",
      "persistedGrantedPurposeIds",
      "persistedMethod",
      "persistedPendingGrantPresent",
      "resourceActive",
      "resourceExecutions",
      "resourceRequests",
      "selectedPurposeIds",
    ]) &&
    value.categoryState === categoryState &&
    value.nestedCategoryState === nestedCategoryState &&
    hasExactArray(
      value.persistedGrantedPurposeIds,
      persistedGrantedPurposeIds,
    ) &&
    value.persistedMethod === "granular" &&
    value.persistedPendingGrantPresent === false &&
    value.resourceActive === resourceActive &&
    value.resourceExecutions === resourceExecutions &&
    value.resourceRequests === resourceRequests &&
    hasExactArray(value.selectedPurposeIds, selectedPurposeIds)
  );
}

function hasUncommittedSelection(
  value,
  { categoryState, nestedCategoryState, selectedPurposeIds },
) {
  return (
    hasExactKeys(value, [
      "activeResourceCount",
      "categoryState",
      "inertResourceSourceCount",
      "nestedCategoryState",
      "persistedRecordPresent",
      "resourceActive",
      "resourceExecutions",
      "resourceRequests",
      "resourceSourceCount",
      "selectedPurposeIds",
    ]) &&
    value.activeResourceCount === 0 &&
    value.categoryState === categoryState &&
    value.inertResourceSourceCount === 1 &&
    value.nestedCategoryState === nestedCategoryState &&
    value.persistedRecordPresent === false &&
    value.resourceActive === false &&
    value.resourceExecutions === 0 &&
    value.resourceRequests === 0 &&
    value.resourceSourceCount === 1 &&
    hasExactArray(value.selectedPurposeIds, selectedPurposeIds)
  );
}

function hasCategorySelection(value, caseId) {
  if (
    !hasExactKeys(value, [
      "afterCategoryDeselection",
      "afterCategorySave",
      "afterCategorySelection",
      "afterDeniedReload",
      "afterDeselectionSave",
      "afterGrantReload",
      "artifactTransport",
      "beforeCategorySelection",
      "beforeCategoryDeselection",
      "categoryId",
      "directPurposeIds",
      "downstreamPurposeId",
      "expandedPurposeIds",
      "moduleRequestPaths",
      "nestedCategoryId",
      "partialSelection",
      "persistence",
      "prerequisitePurposeId",
      "screenshot",
    ]) ||
    value.artifactTransport !== "packed-programmatic-esm" ||
    value.categoryId !== "optional" ||
    !hasExactArray(value.directPurposeIds, ["recommendations"]) ||
    value.downstreamPurposeId !== "profile" ||
    !hasExactArray(value.expandedPurposeIds, ["ads"]) ||
    !hasExactArray(value.moduleRequestPaths, RICH_MODULE_REQUEST_PATHS) ||
    value.nestedCategoryId !== "advertising" ||
    value.prerequisitePurposeId !== "analytics" ||
    !hasUncommittedSelection(value.beforeCategorySelection, {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      selectedPurposeIds: [],
    }) ||
    !hasUncommittedSelection(value.afterCategorySelection, {
      categoryState: "checked",
      nestedCategoryState: "checked",
      selectedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
    }) ||
    !hasCommittedSelection(value.afterCategorySave, {
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 1,
      selectedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
    }) ||
    !hasCommittedSelection(value.afterGrantReload, {
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
    }) ||
    !hasCommittedSelection(value.partialSelection, {
      categoryState: "mixed",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics", "recommendations"],
    }) ||
    !hasCommittedSelection(value.beforeCategoryDeselection, {
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ALL_RICH_PURPOSE_IDS,
    }) ||
    !hasCommittedSelection(value.afterCategoryDeselection, {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: CATEGORY_SELECTION_PURPOSE_IDS,
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    }) ||
    // The deselection save reloads the tab that ran the resource (Pass B's
    // M-C), so the reloaded page has run it zero times.
    !hasCommittedSelection(value.afterDeselectionSave, {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["analytics"],
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    }) ||
    !hasCommittedSelection(value.afterDeniedReload, {
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["analytics"],
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    }) ||
    !hasExactKeys(value.persistence, [
      "afterCategoryDeselectionSha256",
      "afterCategorySaveSha256",
      "afterDeselectionSaveSha256",
      "afterDeniedReloadSha256",
      "afterGrantReloadSha256",
      "beforeCategoryDeselectionSha256",
      "partialSelectionSha256",
    ]) ||
    !Object.values(value.persistence).every((digest) =>
      SHA256_PATTERN.test(digest),
    ) ||
    value.persistence.afterCategorySaveSha256 !==
      value.persistence.afterGrantReloadSha256 ||
    value.persistence.partialSelectionSha256 !==
      value.persistence.afterGrantReloadSha256 ||
    value.persistence.beforeCategoryDeselectionSha256 !==
      value.persistence.afterGrantReloadSha256 ||
    value.persistence.afterCategoryDeselectionSha256 !==
      value.persistence.afterGrantReloadSha256 ||
    value.persistence.afterDeselectionSaveSha256 !==
      value.persistence.afterDeniedReloadSha256 ||
    value.persistence.afterCategorySaveSha256 ===
      value.persistence.afterDeselectionSaveSha256 ||
    !hasExactKeys(value.screenshot, ["path", "sha256"]) ||
    value.screenshot.path !==
      `screenshots/${caseId}-category-indeterminate.png` ||
    !SHA256_PATTERN.test(value.screenshot.sha256)
  ) {
    return false;
  }
  return true;
}

function hasGeneratedStarterState(value, persistedRecordPresent) {
  return (
    hasExactKeys(value, [
      "activeResourceCount",
      "inertResourceSourceCount",
      "launcherRendered",
      "persistedDecision",
      "persistedMethod",
      "persistedRecordPresent",
      "resourceExecutions",
      "resourceRequests",
    ]) &&
    value.activeResourceCount === 0 &&
    value.inertResourceSourceCount === 1 &&
    value.launcherRendered === persistedRecordPresent &&
    value.persistedDecision === (persistedRecordPresent ? "denied" : null) &&
    value.persistedMethod === (persistedRecordPresent ? "reject-all" : null) &&
    value.persistedRecordPresent === persistedRecordPresent &&
    value.resourceExecutions === 0 &&
    value.resourceRequests === 0
  );
}

function hasGeneratedStarter(value, caseId) {
  return (
    hasExactKeys(value, [
      "documentPath",
      "keyboard",
      "persistence",
      "rejection",
      "screenshot",
      "theme",
    ]) &&
    value.documentPath === "/" &&
    hasExactKeys(value.keyboard, [
      "barEscape",
      "barTabOrder",
      "escaped",
      "opened",
      "panelTabOrder",
      "reopened",
      "restored",
      "reverseWrap",
    ]) &&
    value.keyboard.barEscape === "host-control" &&
    hasExactArray(value.keyboard.barTabOrder, [
      "reject-all",
      "accept-all",
      "settings",
    ]) &&
    hasExactKeys(value.keyboard.opened, [
      "activeElement",
      "dialogOpen",
      "modal",
      "opener",
    ]) &&
    value.keyboard.opened.activeElement === "title" &&
    value.keyboard.opened.dialogOpen === true &&
    value.keyboard.opened.modal === true &&
    value.keyboard.opened.opener === "settings" &&
    hasExactArray(value.keyboard.panelTabOrder, GENERATED_PANEL_TAB_ORDER) &&
    value.keyboard.reverseWrap === "close" &&
    hasExactKeys(value.keyboard.escaped, [
      "activeElement",
      "dialogOpen",
      "modal",
      "openerConnected",
    ]) &&
    value.keyboard.escaped.activeElement === "settings" &&
    value.keyboard.escaped.dialogOpen === false &&
    value.keyboard.escaped.modal === false &&
    value.keyboard.escaped.openerConnected === true &&
    hasExactKeys(value.keyboard.reopened, [
      "activeElement",
      "dialogOpen",
      "modal",
      "opener",
    ]) &&
    value.keyboard.reopened.activeElement === "title" &&
    value.keyboard.reopened.dialogOpen === true &&
    value.keyboard.reopened.modal === true &&
    value.keyboard.reopened.opener === "privacy-choices" &&
    hasExactKeys(value.keyboard.restored, [
      "activeElement",
      "dialogOpen",
      "modal",
      "openerConnected",
    ]) &&
    value.keyboard.restored.activeElement === "privacy-choices" &&
    value.keyboard.restored.dialogOpen === false &&
    value.keyboard.restored.modal === false &&
    value.keyboard.restored.openerConnected === true &&
    hasExactKeys(value.persistence, [
      "acceptedReloadSha256",
      "acceptedSha256",
      "rejectedReloadSha256",
      "rejectedSha256",
    ]) &&
    Object.values(value.persistence).every((digest) =>
      SHA256_PATTERN.test(digest),
    ) &&
    value.persistence.acceptedSha256 ===
      value.persistence.acceptedReloadSha256 &&
    value.persistence.rejectedSha256 ===
      value.persistence.rejectedReloadSha256 &&
    value.persistence.acceptedSha256 !== value.persistence.rejectedSha256 &&
    hasExactKeys(value.rejection, [
      "afterRejectAll",
      "afterRejectedReload",
      "beforeRejectAll",
    ]) &&
    hasGeneratedStarterState(value.rejection.beforeRejectAll, false) &&
    hasGeneratedStarterState(value.rejection.afterRejectAll, true) &&
    hasGeneratedStarterState(value.rejection.afterRejectedReload, true) &&
    hasExactKeys(value.screenshot, [
      "dialogOpenAfterCapture",
      "dialogOpenBeforeCapture",
      "modalAfterCapture",
      "modalBeforeCapture",
      "path",
      "sha256",
    ]) &&
    value.screenshot.dialogOpenAfterCapture === true &&
    value.screenshot.dialogOpenBeforeCapture === true &&
    value.screenshot.modalAfterCapture === true &&
    value.screenshot.modalBeforeCapture === true &&
    value.screenshot.path === `screenshots/${caseId}-generated-root.png` &&
    SHA256_PATTERN.test(value.screenshot.sha256) &&
    hasExactKeys(value.theme, [
      "accentToken",
      "acceptAllBackground",
      "acceptAllColor",
      "consumerRulePrecedesLibrary",
      "panelAccentToken",
      "panelMarkerBackground",
      "paperToken",
      "rejectAllBackground",
      "rejectAllColor",
      "settingsBackground",
      "settingsColor",
    ]) &&
    value.theme.accentToken === "#0b5fff" &&
    value.theme.acceptAllBackground === "rgb(11, 95, 255)" &&
    value.theme.acceptAllColor === "rgb(255, 255, 255)" &&
    value.theme.consumerRulePrecedesLibrary === true &&
    value.theme.panelAccentToken === "#0b5fff" &&
    value.theme.panelMarkerBackground === "rgba(0, 0, 0, 0)" &&
    value.theme.paperToken === "light-dark(#ffffff,#0b1220)" &&
    value.theme.rejectAllBackground === "rgb(11, 95, 255)" &&
    value.theme.rejectAllColor === "rgb(255, 255, 255)" &&
    value.theme.settingsBackground === "rgba(0, 0, 0, 0)" &&
    value.theme.settingsColor === "rgb(11, 95, 255)"
  );
}

function deepFreezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreezeJson(entry);
    Object.freeze(value);
  }
  return value;
}

/** Applies the packed-consumer lifecycle through explicit testable ports. */
export async function verifyDxLifecycle(definition, ports) {
  const startedAt = ports.now();
  await ports.scaffold(definition);
  await ports.install(definition);
  const first = await ports.initialize({ blockInstaller: false, definition });
  assertInitialization(first, "initialized", definition.id);
  await ports.build(definition);
  const browser = await ports.browserProof(definition);
  if (
    browser.bannerRendered !== true ||
    !hasCategorySelection(browser.categorySelection, definition.id) ||
    !hasGeneratedStarter(browser.generatedStarter, definition.id) ||
    browser.consentPersisted !== true ||
    browser.beforeConsentExecutions !== 0 ||
    browser.afterGrantExecutions !== 1 ||
    browser.afterWithdrawalReloadExecutions !== 0 ||
    !hasExactDemoRequestCounts(browser.demoRequestCounts) ||
    browser.denialLauncherRendered !== true ||
    browser.denialPersisted !== true ||
    browser.denialResourceBlocked !== true ||
    browser.withdrawalLauncherRendered !== true ||
    browser.withdrawalPersisted !== true ||
    browser.withdrawalPromptedAfterReload !== false ||
    browser.withdrawalResourceBlocked !== true ||
    browser.withdrawalRetainedAfterReload !== true ||
    !Array.isArray(browser.crossOriginRequests) ||
    browser.crossOriginRequests.length !== 0
  ) {
    throw new Error(`${definition.id} browser proof is incomplete.`);
  }
  const before = await ports.snapshot(definition);
  const second = await ports.initialize({ blockInstaller: true, definition });
  assertInitialization(second, "unchanged", definition.id);
  if (second.installerInvoked === true) {
    throw new Error(
      `${definition.id} invoked the package manager during an unchanged init.`,
    );
  }
  const after = await ports.snapshot(definition);
  if (before !== after) {
    throw new Error(
      `${definition.id} changed the consumer tree on second init.`,
    );
  }
  const elapsedMs = ports.now() - startedAt;
  if (elapsedMs > definition.timeoutMs) {
    throw new Error(
      `${definition.id} exceeded ${String(definition.timeoutMs)} ms: ${String(elapsedMs)} ms.`,
    );
  }
  return Object.freeze({
    bannerRendered: true,
    caseId: definition.id,
    categorySelection: deepFreezeJson(
      structuredClone(browser.categorySelection),
    ),
    consentPersisted: true,
    elapsedMs,
    generatedStarter: deepFreezeJson(structuredClone(browser.generatedStarter)),
    idempotent: true,
    resourceExecution: Object.freeze({
      afterGrant: browser.afterGrantExecutions,
      afterWithdrawalReload: browser.afterWithdrawalReloadExecutions,
      beforeConsent: browser.beforeConsentExecutions,
      requestCounts: Object.freeze([...browser.demoRequestCounts]),
    }),
    sameOriginOnly: true,
    withdrawal: Object.freeze({
      persisted: true,
      promptedAfterReload: false,
      retainedAfterReload: true,
    }),
  });
}
