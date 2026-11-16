import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import ts from "typescript";

import { DX_CASES } from "./dx-catalogue.mjs";
import {
  isSameSchemefulWebSocketOrigin,
  PACKED_CATEGORY_ID,
  packedInitializerArguments,
  remainingBrowserTimeout,
  startPackedPlainServer,
} from "./dx-runtime.mjs";
import * as dxRuntime from "./dx-runtime.mjs";
import { verifyDxLifecycle } from "./run-dx-lib.mjs";

const packagePath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);
const dxRuntimePath = fileURLToPath(
  new URL("./dx-runtime.mjs", import.meta.url),
);

const RICH_MODULE_REQUEST_PATHS = Object.freeze([
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

function committedSelection({
  categoryState,
  nestedCategoryState,
  persistedGrantedPurposeIds,
  resourceActive,
  resourceExecutions,
  resourceRequests,
  selectedPurposeIds,
}) {
  return {
    categoryState,
    nestedCategoryState,
    persistedGrantedPurposeIds,
    persistedMethod: "granular",
    persistedPendingGrantPresent: false,
    resourceActive,
    resourceExecutions,
    resourceRequests,
    selectedPurposeIds,
  };
}

function completeCategorySelection(caseId) {
  return {
    beforeCategorySelection: {
      activeResourceCount: 0,
      categoryState: "unchecked",
      inertResourceSourceCount: 1,
      nestedCategoryState: "unchecked",
      persistedRecordPresent: false,
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 0,
      resourceSourceCount: 1,
      selectedPurposeIds: [],
    },
    afterCategoryDeselection: committedSelection({
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    }),
    afterCategorySave: committedSelection({
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 1,
      selectedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
    }),
    afterCategorySelection: {
      activeResourceCount: 0,
      categoryState: "checked",
      inertResourceSourceCount: 1,
      nestedCategoryState: "checked",
      persistedRecordPresent: false,
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 0,
      resourceSourceCount: 1,
      selectedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
    },
    afterDeniedReload: committedSelection({
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["analytics"],
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    }),
    afterDeselectionSave: committedSelection({
      categoryState: "unchecked",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: ["analytics"],
      resourceActive: false,
      resourceExecutions: 0,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics"],
    }),
    afterGrantReload: committedSelection({
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
    }),
    artifactTransport: "packed-programmatic-esm",
    beforeCategoryDeselection: committedSelection({
      categoryState: "checked",
      nestedCategoryState: "checked",
      persistedGrantedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: [...ALL_RICH_PURPOSE_IDS],
    }),
    categoryId: "optional",
    directPurposeIds: ["recommendations"],
    downstreamPurposeId: "profile",
    expandedPurposeIds: ["ads"],
    moduleRequestPaths: [...RICH_MODULE_REQUEST_PATHS],
    nestedCategoryId: "advertising",
    partialSelection: committedSelection({
      categoryState: "mixed",
      nestedCategoryState: "unchecked",
      persistedGrantedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
      resourceActive: true,
      resourceExecutions: 1,
      resourceRequests: 2,
      selectedPurposeIds: ["analytics", "recommendations"],
    }),
    persistence: {
      afterCategoryDeselectionSha256: "a".repeat(64),
      afterCategorySaveSha256: "a".repeat(64),
      afterDeselectionSaveSha256: "b".repeat(64),
      afterDeniedReloadSha256: "b".repeat(64),
      afterGrantReloadSha256: "a".repeat(64),
      beforeCategoryDeselectionSha256: "a".repeat(64),
      partialSelectionSha256: "a".repeat(64),
    },
    prerequisitePurposeId: "analytics",
    screenshot: {
      path: `screenshots/${caseId}-category-indeterminate.png`,
      sha256: "c".repeat(64),
    },
  };
}

function rejectedStarterState({ persistedRecordPresent }) {
  return {
    activeResourceCount: 0,
    inertResourceSourceCount: 1,
    launcherRendered: persistedRecordPresent,
    persistedDecision: persistedRecordPresent ? "denied" : null,
    persistedMethod: persistedRecordPresent ? "reject-all" : null,
    persistedRecordPresent,
    resourceExecutions: 0,
    resourceRequests: 0,
  };
}

function completeGeneratedStarter(caseId) {
  return {
    documentPath: "/",
    keyboard: {
      barEscape: "host-control",
      barTabOrder: ["reject-all", "accept-all", "settings"],
      escaped: {
        activeElement: "settings",
        dialogOpen: false,
        modal: false,
        openerConnected: true,
      },
      opened: {
        activeElement: "title",
        dialogOpen: true,
        modal: true,
        opener: "settings",
      },
      reopened: {
        activeElement: "title",
        dialogOpen: true,
        modal: true,
        opener: "privacy-choices",
      },
      restored: {
        activeElement: "privacy-choices",
        dialogOpen: false,
        modal: false,
        openerConnected: true,
      },
      panelTabOrder: [
        "opencookie-category:optional",
        "opencookie-purpose:analytics",
        "save",
        "close",
        "opencookie-category:optional",
      ],
      reverseWrap: "close",
    },
    persistence: {
      acceptedReloadSha256: "a".repeat(64),
      acceptedSha256: "a".repeat(64),
      rejectedReloadSha256: "b".repeat(64),
      rejectedSha256: "b".repeat(64),
    },
    rejection: {
      afterRejectAll: rejectedStarterState({ persistedRecordPresent: true }),
      afterRejectedReload: rejectedStarterState({
        persistedRecordPresent: true,
      }),
      beforeRejectAll: rejectedStarterState({ persistedRecordPresent: false }),
    },
    screenshot: {
      dialogOpenAfterCapture: true,
      dialogOpenBeforeCapture: true,
      modalAfterCapture: true,
      modalBeforeCapture: true,
      path: `screenshots/${caseId}-generated-root.png`,
      sha256: "d".repeat(64),
    },
    theme: {
      accentToken: "#0b5fff",
      acceptAllBackground: "rgb(11, 95, 255)",
      acceptAllColor: "rgb(255, 255, 255)",
      consumerRulePrecedesLibrary: true,
      panelAccentToken: "#0b5fff",
      panelMarkerBackground: "rgba(0, 0, 0, 0)",
      // The library declares its paper as a light-dark() pair that follows
      // the page; a custom property reads back as declared.
      paperToken: "light-dark(#ffffff,#0b1220)",
      rejectAllBackground: "rgb(11, 95, 255)",
      rejectAllColor: "rgb(255, 255, 255)",
      settingsBackground: "rgba(0, 0, 0, 0)",
      settingsColor: "rgb(11, 95, 255)",
    },
  };
}

function completeBrowserProof(overrides = {}) {
  return {
    afterGrantExecutions: 1,
    afterWithdrawalReloadExecutions: 0,
    bannerRendered: true,
    beforeConsentExecutions: 0,
    categorySelection: completeCategorySelection("plain-cdn"),
    consentPersisted: true,
    crossOriginRequests: [],
    demoRequestCounts: [0, 1, 2, 2, 3, 3],
    denialLauncherRendered: true,
    denialPersisted: true,
    denialResourceBlocked: true,
    generatedStarter: completeGeneratedStarter("plain-cdn"),
    withdrawalLauncherRendered: true,
    withdrawalPersisted: true,
    withdrawalPromptedAfterReload: false,
    withdrawalResourceBlocked: true,
    withdrawalRetainedAfterReload: true,
    ...overrides,
  };
}

function ports(overrides = {}) {
  const calls = [];
  let tick = 1_000;
  return {
    calls,
    value: {
      browserProof: async () => {
        calls.push("browser");
        return completeBrowserProof();
      },
      build: async () => calls.push("build"),
      initialize: async ({ blockInstaller }) => {
        calls.push(blockInstaller ? "init-again" : "init");
        return {
          installerInvoked: false,
          status: blockInstaller ? "unchanged" : "initialized",
        };
      },
      install: async () => calls.push("install"),
      now: () => {
        tick += 1_000;
        return tick;
      },
      scaffold: async () => calls.push("scaffold"),
      snapshot: async () => {
        calls.push("snapshot");
        return "same-tree";
      },
      ...overrides,
    },
  };
}

describe("packed initializer DX lifecycle", () => {
  it("proves scaffold, install, init, build, browser, persistence, and idempotence", async () => {
    const fixture = ports();
    const summary = await verifyDxLifecycle(DX_CASES[0], fixture.value);

    assert.deepEqual(fixture.calls, [
      "scaffold",
      "install",
      "init",
      "build",
      "browser",
      "snapshot",
      "init-again",
      "snapshot",
    ]);
    assert.equal(summary.caseId, "plain-cdn");
    assert.equal(summary.elapsedMs, 1_000);
    assert.deepEqual(summary.resourceExecution, {
      afterGrant: 1,
      afterWithdrawalReload: 0,
      beforeConsent: 0,
      requestCounts: [0, 1, 2, 2, 3, 3],
    });
    assert.equal(summary.sameOriginOnly, true);
    assert.deepEqual(
      summary.categorySelection,
      completeCategorySelection("plain-cdn"),
    );
    assert.deepEqual(
      summary.generatedStarter,
      completeGeneratedStarter("plain-cdn"),
    );
    assert.deepEqual(summary.withdrawal, {
      persisted: true,
      promptedAfterReload: false,
      retainedAfterReload: true,
    });
  });

  it("rejects an idempotence mutation, hidden installer, missing browser proof, or budget breach", async () => {
    let snapshots = 0;
    await assert.rejects(
      verifyDxLifecycle(
        DX_CASES[0],
        ports({ snapshot: async () => String((snapshots += 1)) }).value,
      ),
      /changed the consumer tree/u,
    );
    await assert.rejects(
      verifyDxLifecycle(
        DX_CASES[0],
        ports({
          initialize: async ({ blockInstaller }) => ({
            installerInvoked: blockInstaller,
            status: blockInstaller ? "unchanged" : "initialized",
          }),
        }).value,
      ),
      /invoked the package manager/u,
    );
    await assert.rejects(
      verifyDxLifecycle(
        DX_CASES[0],
        ports({
          browserProof: async () => ({
            bannerRendered: true,
            consentPersisted: false,
          }),
        }).value,
      ),
      /browser proof is incomplete/u,
    );
    await assert.rejects(
      verifyDxLifecycle(
        DX_CASES[0],
        ports({
          browserProof: async () => ({
            afterGrantExecutions: 1,
            afterWithdrawalReloadExecutions: 0,
            bannerRendered: true,
            beforeConsentExecutions: 0,
            consentPersisted: true,
            crossOriginRequests: [],
            denialLauncherRendered: true,
            denialPersisted: true,
            denialResourceBlocked: true,
            withdrawalLauncherRendered: true,
            withdrawalPersisted: true,
            withdrawalPromptedAfterReload: false,
            withdrawalResourceBlocked: true,
            withdrawalRetainedAfterReload: true,
          }),
        }).value,
      ),
      /browser proof is incomplete/u,
      "inline execution markers without real resource requests must not pass",
    );
    for (const browserProof of [
      completeBrowserProof({ afterGrantExecutions: 2 }),
      completeBrowserProof({ beforeConsentExecutions: 1 }),
      completeBrowserProof({ categorySelection: undefined }),
      completeBrowserProof({ afterWithdrawalReloadExecutions: 1 }),
      completeBrowserProof({
        crossOriginRequests: ["https://telemetry.invalid/collect"],
      }),
      completeBrowserProof({ demoRequestCounts: [0, 1, 1, 1, 2, 2] }),
      completeBrowserProof({
        demoRequestCounts: [0, 1, 2, 2, 3, 3, 3],
      }),
      completeBrowserProof({ denialLauncherRendered: false }),
      completeBrowserProof({ denialPersisted: false }),
      completeBrowserProof({ denialResourceBlocked: false }),
      completeBrowserProof({ generatedStarter: undefined }),
      completeBrowserProof({ withdrawalLauncherRendered: false }),
      completeBrowserProof({ withdrawalPersisted: false }),
      completeBrowserProof({ withdrawalPromptedAfterReload: true }),
      completeBrowserProof({ withdrawalResourceBlocked: false }),
      completeBrowserProof({ withdrawalRetainedAfterReload: false }),
    ]) {
      await assert.rejects(
        verifyDxLifecycle(
          DX_CASES[0],
          ports({ browserProof: async () => browserProof }).value,
        ),
        /browser proof is incomplete/u,
      );
    }
    let timeCalls = 0;
    await assert.rejects(
      verifyDxLifecycle(
        DX_CASES[0],
        ports({ now: () => (timeCalls++ === 0 ? 0 : 60_001) }).value,
      ),
      /exceeded 60000 ms/u,
    );
  });

  it("rejects every missing, extra, incorrect, or disconnected generated-starter observation", async () => {
    const baseline = completeGeneratedStarter("plain-cdn");
    const mutations = [
      (evidence) => {
        evidence.unexpected = true;
      },
    ];
    const wrongValue = (value) => {
      if (Array.isArray(value)) return [...value, "unexpected"];
      if (typeof value === "boolean") return !value;
      if (typeof value === "number") return value + 1;
      if (typeof value === "string") return `${value}-unexpected`;
      if (value === null) return "unexpected";
      throw new TypeError("Unsupported generated-starter evidence test value.");
    };
    for (const key of ["documentPath"]) {
      mutations.push(
        (evidence) => delete evidence[key],
        (evidence) => {
          evidence[key] = wrongValue(evidence[key]);
        },
      );
    }
    for (const container of [
      "keyboard",
      "persistence",
      "rejection",
      "screenshot",
      "theme",
    ]) {
      mutations.push(
        (evidence) => delete evidence[container],
        (evidence) => {
          evidence[container].unexpected = true;
        },
      );
    }
    for (const container of ["persistence", "screenshot", "theme"]) {
      for (const key of Object.keys(baseline[container])) {
        mutations.push(
          (evidence) => delete evidence[container][key],
          (evidence) => {
            evidence[container][key] = wrongValue(evidence[container][key]);
          },
        );
      }
    }
    for (const phase of Object.keys(baseline.keyboard)) {
      mutations.push((evidence) => delete evidence.keyboard[phase]);
      if (
        baseline.keyboard[phase] === null ||
        typeof baseline.keyboard[phase] !== "object" ||
        Array.isArray(baseline.keyboard[phase])
      ) {
        mutations.push((evidence) => {
          evidence.keyboard[phase] = wrongValue(evidence.keyboard[phase]);
        });
        continue;
      }
      for (const key of Object.keys(baseline.keyboard[phase])) {
        mutations.push(
          (evidence) => delete evidence.keyboard[phase][key],
          (evidence) => {
            evidence.keyboard[phase][key] = wrongValue(
              evidence.keyboard[phase][key],
            );
          },
        );
      }
    }
    for (const phase of Object.keys(baseline.rejection)) {
      mutations.push((evidence) => delete evidence.rejection[phase]);
      for (const key of Object.keys(baseline.rejection[phase])) {
        mutations.push(
          (evidence) => delete evidence.rejection[phase][key],
          (evidence) => {
            evidence.rejection[phase][key] = wrongValue(
              evidence.rejection[phase][key],
            );
          },
        );
      }
    }
    mutations.push(
      (evidence) => {
        evidence.persistence.acceptedReloadSha256 = "c".repeat(64);
      },
      (evidence) => {
        evidence.persistence.rejectedReloadSha256 = "c".repeat(64);
      },
      (evidence) => {
        evidence.persistence.rejectedSha256 =
          evidence.persistence.acceptedSha256;
        evidence.persistence.rejectedReloadSha256 =
          evidence.persistence.acceptedSha256;
      },
    );

    for (const mutate of mutations) {
      const generatedStarter = structuredClone(baseline);
      mutate(generatedStarter);
      await assert.rejects(
        verifyDxLifecycle(
          DX_CASES[0],
          ports({
            browserProof: async () =>
              completeBrowserProof({ generatedStarter }),
          }).value,
        ),
        /browser proof is incomplete/u,
      );
    }
  });

  it("accepts the quiet settings choice and rejects a filled one", async () => {
    const quiet = completeGeneratedStarter("plain-cdn");
    quiet.theme.panelMarkerBackground = "rgba(0, 0, 0, 0)";
    quiet.theme.settingsBackground = "rgba(0, 0, 0, 0)";
    quiet.theme.settingsColor = "rgb(11, 95, 255)";
    const accepted = await verifyDxLifecycle(
      DX_CASES[0],
      ports({
        browserProof: async () =>
          completeBrowserProof({ generatedStarter: quiet }),
      }).value,
    );
    assert.equal(
      accepted.generatedStarter.theme.panelMarkerBackground,
      "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      accepted.generatedStarter.theme.settingsBackground,
      "rgba(0, 0, 0, 0)",
    );
    assert.equal(
      accepted.generatedStarter.theme.settingsColor,
      "rgb(11, 95, 255)",
    );
    assert.equal(
      accepted.generatedStarter.theme.acceptAllBackground,
      "rgb(11, 95, 255)",
    );
    assert.equal(
      accepted.generatedStarter.theme.acceptAllColor,
      "rgb(255, 255, 255)",
    );
    assert.equal(
      accepted.generatedStarter.theme.rejectAllBackground,
      "rgb(11, 95, 255)",
    );
    assert.equal(
      accepted.generatedStarter.theme.rejectAllColor,
      "rgb(255, 255, 255)",
    );
    assert.equal(accepted.generatedStarter.theme.accentToken, "#0b5fff");
    assert.equal(accepted.generatedStarter.theme.panelAccentToken, "#0b5fff");
    assert.equal(
      accepted.generatedStarter.theme.consumerRulePrecedesLibrary,
      true,
    );
    assert.equal(
      accepted.generatedStarter.theme.paperToken,
      "light-dark(#ffffff,#0b1220)",
    );

    const filled = completeGeneratedStarter("plain-cdn");
    filled.theme.panelMarkerBackground = "rgb(11, 95, 255)";
    filled.theme.settingsBackground = "rgb(11, 95, 255)";
    filled.theme.settingsColor = "rgb(255, 255, 255)";
    await assert.rejects(
      verifyDxLifecycle(
        DX_CASES[0],
        ports({
          browserProof: async () =>
            completeBrowserProof({ generatedStarter: filled }),
        }).value,
      ),
      /browser proof is incomplete/u,
    );
  });

  it("exposes the autonomous packed DX command", async () => {
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    assert.equal(manifest.scripts["e2e:dx"], "node scripts/e2e/run-dx.mjs");
  });

  it("selects the self-hosted initializer only for the plain consumer", () => {
    const registry = "http://127.0.0.1:4873/";
    assert.deepEqual(packedInitializerArguments(DX_CASES[0], registry), [
      "--yes",
      `--registry=${registry}`,
      "opencookie@0.4.1",
      "init",
      "--yes",
      "--self-host",
    ]);
    assert.deepEqual(packedInitializerArguments(DX_CASES[1], registry), [
      "--yes",
      `--registry=${registry}`,
      "opencookie@0.4.1",
      "init",
      "--yes",
    ]);
  });

  it("uses the exact domain-backed category in every packed browser proof", async () => {
    assert.equal(PACKED_CATEGORY_ID, "optional");
    const runtimeSource = await readFile(dxRuntimePath, "utf8");
    assert.match(
      runtimeSource,
      /getByRole\("checkbox", \{[\s\S]*?name: PACKED_CATEGORY_ID,[\s\S]*?exact: true/u,
    );
    assert.doesNotMatch(runtimeSource, /name: \/Analytics\/u/u);
    assert.match(runtimeSource, /packed-programmatic-esm/u);
    assert.match(runtimeSource, /category.*indeterminate/iu);
    assert.match(runtimeSource, /unsupported.*dependent.*pruned/iu);
  });

  it("rejects pending rich consent envelopes before observing persistence", () => {
    const record = {
      catalogueDigest: "catalogue-rich-v1",
      decidedAt: 1_000,
      decisionSurfaceDigest: "surface-rich-v1",
      decisions: {
        ads: "granted",
        analytics: "granted",
        profile: "denied",
        recommendations: "granted",
      },
      expiresAt: 10_000,
      method: "granular",
      policyVersion: "rich-policy-v1",
      recordId: "rich-record-1",
      revision: 1,
    };
    const input = {
      expectedGrantedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
      expectedPurposeIds: [...ALL_RICH_PURPOSE_IDS],
      storageKey: "opencookie.rich.consent",
    };
    const replacementCandidate = {
      ...record,
      decidedAt: 2_000,
      expiresAt: 11_000,
      revision: 2,
    };
    const pendingRaw = JSON.stringify({
      pendingGrant: {
        candidate: replacementCandidate,
        kind: "decision",
        receiptOccurredAt: 2_100,
        transitionId: "transition-rich-replacement",
      },
      record,
      schemaVersion: 1,
    });

    assert.equal(typeof dxRuntime.terminalRichConsentRecordProbe, "function");
    assert.equal(
      dxRuntime.terminalRichConsentRecordProbe({ ...input, raw: pendingRaw }),
      false,
    );
    assert.equal(
      dxRuntime.terminalRichConsentRecordProbe({
        ...input,
        raw: JSON.stringify({ pendingGrant: null, record, schemaVersion: 1 }),
      }),
      false,
    );

    const raw = JSON.stringify({ record, schemaVersion: 1 });
    assert.deepEqual(
      dxRuntime.terminalRichConsentRecordProbe({ ...input, raw }),
      {
        persistedGrantedPurposeIds: [...CATEGORY_SELECTION_PURPOSE_IDS],
        persistedMethod: "granular",
        persistedPendingGrantPresent: false,
        raw,
      },
    );
  });

  it("rejects every missing or incorrect category-selection observation", async () => {
    const baseline = completeCategorySelection("plain-cdn");
    const mutations = [];
    const wrongValue = (value) => {
      if (Array.isArray(value)) return [...value, "unexpected"];
      if (typeof value === "boolean") return !value;
      if (typeof value === "number") return value + 1;
      if (typeof value === "string") return `${value}-unexpected`;
      throw new TypeError("Unsupported category evidence test value.");
    };
    for (const key of [
      "artifactTransport",
      "categoryId",
      "directPurposeIds",
      "downstreamPurposeId",
      "expandedPurposeIds",
      "moduleRequestPaths",
      "nestedCategoryId",
      "prerequisitePurposeId",
    ]) {
      mutations.push(
        (evidence) => delete evidence[key],
        (evidence) => {
          evidence[key] = wrongValue(evidence[key]);
        },
      );
    }
    for (const phase of [
      "afterCategoryDeselection",
      "afterCategorySave",
      "afterCategorySelection",
      "afterDeniedReload",
      "afterDeselectionSave",
      "afterGrantReload",
      "beforeCategorySelection",
      "beforeCategoryDeselection",
      "partialSelection",
    ]) {
      mutations.push((evidence) => delete evidence[phase]);
      for (const key of Object.keys(baseline[phase])) {
        mutations.push(
          (evidence) => delete evidence[phase][key],
          (evidence) => {
            evidence[phase][key] = wrongValue(evidence[phase][key]);
          },
        );
      }
    }
    for (const container of ["persistence", "screenshot"]) {
      mutations.push((evidence) => delete evidence[container]);
      for (const key of Object.keys(baseline[container])) {
        mutations.push(
          (evidence) => delete evidence[container][key],
          (evidence) => {
            evidence[container][key] = wrongValue(evidence[container][key]);
          },
        );
      }
    }
    for (const digest of [
      "afterCategoryDeselectionSha256",
      "beforeCategoryDeselectionSha256",
      "partialSelectionSha256",
    ]) {
      mutations.push((evidence) => {
        evidence.persistence[digest] = "d".repeat(64);
      });
    }

    for (const mutate of mutations) {
      const categorySelection = structuredClone(baseline);
      mutate(categorySelection);
      await assert.rejects(
        verifyDxLifecycle(
          DX_CASES[0],
          ports({
            browserProof: async () =>
              completeBrowserProof({ categorySelection }),
          }).value,
        ),
        /browser proof is incomplete/u,
      );
    }
  });

  it("serves the generated self-hosted vanilla and demo assets byte-for-byte", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "opencookie-dx-plain-"));
    t.after(() => rm(root, { force: true, recursive: true }));
    const vendorDirectory = path.join(root, "vendor", "opencookie");
    await mkdir(vendorDirectory, { recursive: true });
    const vanillaSource = "globalThis.__packedOpenCookie = true;\n";
    const demoSource =
      "globalThis.__openCookieDemoRuns = (globalThis.__openCookieDemoRuns ?? 0) + 1;\n";
    const expectedSha256 = createHash("sha256")
      .update(vanillaSource)
      .digest("hex");
    await Promise.all([
      writeFile(
        path.join(root, "index.html"),
        [
          '<script defer src="/vendor/opencookie/auto.iife.js"></script>',
          '<script type="text/plain" data-src="/opencookie-demo.js" data-oc-resource="opencookie-demo-script" data-oc-category="analytics"></script>',
          "",
        ].join("\n"),
      ),
      writeFile(path.join(vendorDirectory, "auto.iife.js"), vanillaSource),
      writeFile(path.join(root, "opencookie-demo.js"), demoSource),
    ]);
    const materialize = dxRuntime.materializeRichBrowserEvidence;
    assert.equal(typeof materialize, "function");
    await materialize({
      browserModules: {
        core: "export const packedCore = true;\n",
        domain: "export const packedDomain = true;\n",
        infrastructure: "export const packedInfrastructure = true;\n",
        vanilla:
          'import "@opencookie-dev/core";\nexport const packedVanilla = true;\n',
      },
      definition: DX_CASES[0],
      projectRoot: root,
    });

    const server = await startPackedPlainServer({
      expectedSha256,
      projectRoot: root,
      vanillaScript: vanillaSource,
    });
    t.after(() => server.stop());

    const [
      htmlResponse,
      vanillaResponse,
      demoResponse,
      richHtmlResponse,
      richVanillaResponse,
      richResourceResponse,
    ] = await Promise.all([
      fetch(server.url),
      fetch(new URL("vendor/opencookie/auto.iife.js", server.url)),
      fetch(new URL("opencookie-demo.js", server.url)),
      fetch(new URL("opencookie-rich-evidence/index.html", server.url)),
      fetch(
        new URL("opencookie-rich-evidence/packages/vanilla.js", server.url),
      ),
      fetch(new URL("opencookie-rich-evidence/resource.js", server.url)),
    ]);
    assert.equal(htmlResponse.status, 200);
    assert.equal(vanillaResponse.status, 200);
    assert.equal(await vanillaResponse.text(), vanillaSource);
    assert.equal(demoResponse.status, 200);
    assert.equal(await demoResponse.text(), demoSource);
    assert.equal(richHtmlResponse.status, 200);
    assert.match(await richHtmlResponse.text(), /type="importmap"/u);
    assert.equal(richVanillaResponse.status, 200);
    assert.equal(
      await richVanillaResponse.text(),
      'import "@opencookie-dev/core";\nexport const packedVanilla = true;\n',
    );
    assert.equal(richResourceResponse.status, 200);
    assert.match(
      await richResourceResponse.text(),
      /__openCookieRichDemoRuns/u,
    );
  });

  it("uses schemeful WebSocket origin equivalence", () => {
    assert.equal(
      isSameSchemefulWebSocketOrigin(
        "ws://example.test/socket",
        "http://example.test/",
      ),
      true,
    );
    assert.equal(
      isSameSchemefulWebSocketOrigin(
        "wss://example.test/socket",
        "https://example.test/",
      ),
      true,
    );
    for (const [socketUrl, applicationUrl] of [
      ["wss://example.test/socket", "http://example.test/"],
      ["ws://example.test/socket", "https://example.test/"],
      ["ws://example.test:8080/socket", "http://example.test/"],
      ["ws://sub.example.test/socket", "http://example.test/"],
    ]) {
      assert.equal(
        isSameSchemefulWebSocketOrigin(socketUrl, applicationUrl),
        false,
      );
    }
  });

  it("classifies every focus target outside the consent root as host content", () => {
    assert.equal(typeof dxRuntime.classifyGeneratedFocusTarget, "function");
    assert.equal(
      dxRuntime.classifyGeneratedFocusTarget({
        action: null,
        inputName: null,
        inputValue: null,
        isHostControl: true,
        isTitle: false,
        tagName: "button",
      }),
      "host-control",
    );
  });

  it("bounds generated panel observations by the remaining case deadline", async () => {
    assert.equal(typeof dxRuntime.evaluateGeneratedPanel, "function");
    const calls = [];
    const locator = {
      async evaluate(...args) {
        calls.push(args);
        return "observed";
      },
    };
    const observation = () => true;
    assert.equal(
      await dxRuntime.evaluateGeneratedPanel(
        locator,
        observation,
        61_000,
        () => 1_000,
      ),
      "observed",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], observation);
    assert.equal(calls[0][1], undefined);
    assert.deepEqual(calls[0][2], { timeout: 60_000 });
    await assert.rejects(
      dxRuntime.evaluateGeneratedPanel(
        locator,
        observation,
        61_000,
        () => 61_000,
      ),
      /browser proof.*budget/iu,
    );
    assert.equal(calls.length, 1);
  });

  it("routes every generated panel observation through the deadline helper", async () => {
    const runtimeSource = await readFile(dxRuntimePath, "utf8");
    const sourceFile = ts.createSourceFile(
      dxRuntimePath,
      runtimeSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const directPanelEvaluations = [];
    const helperCalls = [];
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "panel" &&
          node.expression.name.text === "evaluate"
        ) {
          directPanelEvaluations.push(node);
        }
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "evaluateGeneratedPanel"
        ) {
          helperCalls.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    assert.equal(directPanelEvaluations.length, 0);
    assert.equal(helperCalls.length, 3);
    for (const call of helperCalls) {
      assert.equal(call.arguments.length, 3);
      assert.equal(call.arguments[0].getText(sourceFile), "panel");
      assert.equal(call.arguments[2].getText(sourceFile), "deadline");
    }
  });

  it("derives every browser wait from the absolute case deadline", () => {
    assert.equal(
      remainingBrowserTimeout(61_000, () => 1_000),
      60_000,
    );
    assert.equal(
      remainingBrowserTimeout(61_000, () => 60_999),
      1,
    );
    assert.throws(
      () => remainingBrowserTimeout(61_000, () => 61_000),
      /browser proof.*budget/iu,
    );
  });

  it("threads the absolute case deadline into the browser lifecycle", async () => {
    const runtimeSource = await readFile(dxRuntimePath, "utf8");
    assert.match(
      runtimeSource,
      /return await proveBrowserLifecycle\(browser, url, deadline, \{/u,
    );
  });
});
