import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const coreRoot = path.join(repositoryRoot, "packages/core");
const autoPublicTypeClosure = Object.freeze([
  "AccessBlockReason",
  "AccessConsentSnapshot",
  "AccessConsentStatus",
  "AccessDecisionValue",
  "AccessPolicyPurpose",
  "AccessPolicyResource",
  "AccessPolicySnapshot",
  "AccessPurposeDecision",
  "AllowedResourceAccess",
  "AppliedDecisionChange",
  "AutoOpenCookieController",
  "AutoOpenCookieDefinition",
  "AutoOpenCookieFactory",
  "AutoOpenCookieGoogleInput",
  "AutoOpenCookieGoogleResourceMapping",
  "AutoOpenCookieGpcInput",
  "AutoOpenCookieGpcObservation",
  "AutoOpenCookiePersistenceInput",
  "AutoOpenCookiePolicySection",
  "AutoOpenCookieResourceInput",
  "AutoOpenCookieRuntimeOptions",
  "AutoOpenCookieStorage",
  "BlockedResourceAccess",
  "ConfirmedGrantTransition",
  "ConsentDecision",
  "ConsentDecisionEvent",
  "ConsentDecisionMethod",
  "ConsentDecisionState",
  "ConsentDomainEvent",
  "ConsentEvaluation",
  "ConsentEvaluationIssue",
  "ConsentInitializationDiagnostic",
  "ConsentPolicyAffectedPurposeInput",
  "ConsentPolicyIdentityInput",
  "ConsentPolicyInput",
  "ConsentPolicyReconciliation",
  "ConsentPolicyReconciliationIssue",
  "ConsentRecord",
  "ConsentRecordBase",
  "ConsentRecordCreatedEvent",
  "ConsentRecordSchemaVersion",
  "ConsentRuntimeDecisionDiagnostic",
  "ConsentRuntimeDecisionResult",
  "ConsentRuntimeProjection",
  "ConsentRuntimeTransitionEffect",
  "ConsentRuntimeWithdrawalResult",
  "ConservativeGrantTransition",
  "DecisionBeforeCurrentTransitionIssue",
  "DecisionDiff",
  "DefinedPolicy",
  "DefinedPolicyCategory",
  "DefinedPolicyPurpose",
  "DefinedPolicyReference",
  "DenialPersistenceDiagnostic",
  "DenialReceiptDiagnostic",
  "DenialTransition",
  "DenialTransitionDiagnostic",
  "DiscoveredResourceState",
  "EffectiveAccessPlan",
  "EffectiveResourceAccess",
  "EnforcementOperationResult",
  "GoogleConsentModeCall",
  "GoogleConsentModeCommand",
  "GoogleConsentModePayload",
  "GoogleConsentStatus",
  "GrantActivationDiagnostic",
  "GrantPersistenceDiagnostic",
  "GrantTransition",
  "InvalidConsentIdIssue",
  "InvalidConsentPolicyIssue",
  "InvalidCurrentRecordIssue",
  "InvalidDecisionIntervalIssue",
  "InvalidDecisionMethodIssue",
  "InvalidDecisionTimestampIssue",
  "InvalidGrantedPurposeSetIssue",
  "InvalidLocaleIssue",
  "InvalidRecordIdIssue",
  "InvalidWithdrawalRecordIssue",
  "InvalidWithdrawalTimeIssue",
  "MissingRecordIdIssue",
  "OpenCookie",
  "OpenCookieAdoptionResult",
  "OpenCookieExternalStore",
  "OpenCookieGrantActivation",
  "OpenCookieIdKind",
  "OpenCookiePendingGrant",
  "OpenCookiePendingGrantRetryResult",
  "OpenCookiePortContext",
  "OpenCookieReadiness",
  "OpenCookieSnapshot",
  "OpenCookieWithdrawalResult",
  "PendingGrantRuntimeTransition",
  "PersistedDecisionRecord",
  "PersistedDecisionRecordBase",
  "PolicyCategoryTranslation",
  "PolicyPurposeTranslation",
  "PolicySnapshot",
  "PurposeDecision",
  "PurposeDecisionState",
  "RecordDecisionIssue",
  "StoredConsentInvalidReason",
  "UnknownPurposeIdIssue",
]);

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

function dualEntry(name) {
  return {
    import: {
      types: `./dist/${name}.d.ts`,
      default: `./dist/${name}.js`,
    },
    require: {
      types: `./dist/${name}.d.cts`,
      default: `./dist/${name}.cjs`,
    },
  };
}

function runtimeSourceGraph(entry) {
  const visited = new Set();
  const visit = (filename) => {
    const normalized = path.normalize(filename);
    if (visited.has(normalized)) return;
    visited.add(normalized);
    const source = readFileSync(normalized, "utf8");
    const declarations = source.matchAll(
      /(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/gu,
    );
    for (const declaration of declarations) {
      const clause = declaration[1]?.trim() ?? "";
      const specifier = declaration[2] ?? "";
      if (clause.startsWith("type ") || !specifier.startsWith(".")) continue;
      const resolved = path.resolve(
        path.dirname(normalized),
        specifier.replace(/[.]js$/u, ".ts"),
      );
      if (resolved.startsWith(path.join(coreRoot, "src"))) visit(resolved);
    }
  };
  visit(entry);
  return [...visited];
}

test("publishes only the explicit core product and layer entry points", () => {
  const manifest = readJson("packages/core/package.json");

  assert.deepEqual(manifest.exports, {
    ".": dualEntry("index"),
    "./application": dualEntry("application"),
    "./auto": dualEntry("auto"),
    "./domain": dualEntry("domain"),
    "./infrastructure": dualEntry("infrastructure"),
    "./reconciliation": dualEntry("reconciliation"),
  });
  assert.equal(Object.hasOwn(manifest.exports, "./low-level"), false);

  for (const entry of [
    "application",
    "auto",
    "domain",
    "infrastructure",
    "reconciliation",
  ]) {
    assert.equal(
      existsSync(path.join(coreRoot, `src/${entry}.ts`)),
      true,
      `Missing source entry for @opencookie-dev/core/${entry}.`,
    );
  }
});

test("assigns every public core JavaScript entry its fixed gzip budget", () => {
  const sizeLimits = readJson(".size-limit.json");

  // This test owns the product boundary: which entries carry a budget, where
  // they live, and how each is measured. The ceiling values are owned by
  // scripts/size-budget-units.test.mjs, which checks them against the
  // documented decimal figures and the recurrence cap. Duplicating the
  // numbers here let the two drift apart, so this asserts only their form.
  const shape = ({ brotli, gzip, name, path: entryPath }) => ({
    measured: gzip === true ? "gzip" : brotli === false ? "raw" : "unknown",
    name,
    path: entryPath,
  });

  assert.deepEqual(
    sizeLimits
      .filter(({ path: entryPath }) =>
        String(entryPath).startsWith("packages/core/dist/"),
      )
      .map(shape),
    [
      {
        measured: "gzip",
        name: "core browser ESM",
        path: "packages/core/dist/index.js",
      },
      {
        measured: "gzip",
        name: "core domain ESM",
        path: "packages/core/dist/domain.js",
      },
      {
        measured: "gzip",
        name: "core application ESM",
        path: "packages/core/dist/application.js",
      },
      {
        measured: "gzip",
        name: "core reconciliation ESM",
        path: "packages/core/dist/reconciliation.js",
      },
      {
        measured: "gzip",
        name: "core infrastructure ESM",
        path: "packages/core/dist/infrastructure.js",
      },
      {
        measured: "gzip",
        name: "core auto ESM",
        path: "packages/core/dist/auto.js",
      },
    ],
  );

  assert.deepEqual(
    sizeLimits.filter(({ name }) => name.startsWith("vanilla auto")).map(shape),
    [
      {
        measured: "gzip",
        name: "vanilla auto IIFE",
        path: "packages/adapters/vanilla/dist/auto.iife.js",
      },
      {
        measured: "raw",
        name: "vanilla auto IIFE raw",
        path: "packages/adapters/vanilla/dist/auto.iife.js",
      },
    ],
  );

  for (const entry of sizeLimits) {
    assert.match(
      String(entry.limit),
      /^\d+ B$/u,
      `${entry.name} must state an exact byte ceiling.`,
    );
  }
});

test("discovers one predictably named API contract for every core entry", () => {
  const extractorConfigs = readdirSync(coreRoot)
    .filter((name) => /^api-extractor(?:[.][a-z-]+)?[.]json$/u.test(name))
    .sort();
  const apiReports = readdirSync(path.join(coreRoot, "etc"))
    .filter((name) => name.endsWith(".api.md"))
    .sort();

  assert.deepEqual(extractorConfigs, [
    "api-extractor.application.json",
    "api-extractor.auto.json",
    "api-extractor.domain.json",
    "api-extractor.infrastructure.json",
    "api-extractor.json",
    "api-extractor.reconciliation.json",
  ]);
  assert.deepEqual(apiReports, [
    "core-application.api.md",
    "core-auto.api.md",
    "core-domain.api.md",
    "core-infrastructure.api.md",
    "core-reconciliation.api.md",
    "core.api.md",
  ]);
});

test("keeps split core subpaths inside the self-contained vanilla auto bundle", () => {
  const config = readFileSync(
    path.join(repositoryRoot, "packages/adapters/vanilla/tsdown.config.ts"),
    "utf8",
  );

  assert.equal(
    config.includes("alwaysBundle: [/^@opencookie-dev\\/core(?:\\/|$)/u]"),
    true,
  );
});

test("maps every core subpath in the consumer-visible docs compiler", () => {
  const verifier = readFileSync(
    path.join(repositoryRoot, "scripts/verify-docs-samples.mjs"),
    "utf8",
  );

  for (const subpath of [
    "application",
    "auto",
    "domain",
    "infrastructure",
    "reconciliation",
  ]) {
    assert.equal(verifier.includes(`"@opencookie-dev/core/${subpath}"`), true);
  }

  const samplesTsconfig = readFileSync(
    path.join(repositoryRoot, "apps/docs/tsconfig.samples.json"),
    "utf8",
  );
  assert.equal(samplesTsconfig.includes('"@opencookie-dev/core/auto"'), true);
});

test("builds the auto entry as one dedicated self-contained product", () => {
  const config = readFileSync(path.join(coreRoot, "tsdown.config.ts"), "utf8");

  assert.match(config, /auto: "src\/auto[.]ts"/u);
});

test("builds reconciliation as a dedicated public product", () => {
  const config = readFileSync(path.join(coreRoot, "tsdown.config.ts"), "utf8");

  assert.match(config, /reconciliation: "src\/reconciliation[.]ts"/u);
});

test("injects a current-only projector without reaching full reconciliation", () => {
  const factoryPath = path.join(
    coreRoot,
    "src/auto/create-auto-open-cookie-factory.ts",
  );
  const factory = readFileSync(factoryPath, "utf8");
  const graph = runtimeSourceGraph(path.join(coreRoot, "src/auto.ts"));

  assert.match(factory, /projectCurrentConsentPolicy/u);
  assert.match(
    factory,
    /const projectionContext:[\s\S]*projectPolicy: projectCurrentConsentPolicy/u,
  );
  assert.match(
    factory,
    /createOpenCookieKernel\([\s\S]*captureNoopAftercare,[\s\S]*projectionContext/u,
  );
  for (const forbidden of [
    "snapshot-consent-runtime-projection-context.ts",
    "reconcile-policy.ts",
    "diff-policies.ts",
    "plan-reconsent.ts",
    "define-policy.ts",
    "define-resource-policy.ts",
  ]) {
    assert.equal(
      graph.some((filename) => filename.endsWith(forbidden)),
      false,
      `Auto runtime graph reaches ${forbidden}.`,
    );
  }
});

test("advertises only the compact factory surface from the auto entry", () => {
  const autoReport = readFileSync(
    path.join(coreRoot, "etc/core-auto.api.md"),
    "utf8",
  );

  assert.match(autoReport, /^export function createAutoOpenCookieFactory\(/mu);
  assert.doesNotMatch(autoReport, /createOpenCookie\(/u);
  assert.doesNotMatch(autoReport, /ConsentReceipt/u);
  assert.doesNotMatch(autoReport, /projectConsentReceipt/u);
  assert.doesNotMatch(autoReport, /definePolicy\(/u);
});

test("exports the complete explicit type closure for the auto client", () => {
  const autoReport = readFileSync(
    path.join(coreRoot, "etc/core-auto.api.md"),
    "utf8",
  );
  const exportedTypes = [
    ...autoReport.matchAll(/^export (?:interface|type) (\w+)/gmu),
  ]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(exportedTypes, autoPublicTypeClosure);
  assert.doesNotMatch(autoReport, /CONSENT_RECORD_SCHEMA_VERSION/u);
});

test("does not advertise lower-layer runtime values from higher-layer entries", () => {
  const applicationReport = readFileSync(
    path.join(coreRoot, "etc/core-application.api.md"),
    "utf8",
  );
  const infrastructureReport = readFileSync(
    path.join(coreRoot, "etc/core-infrastructure.api.md"),
    "utf8",
  );

  assert.doesNotMatch(
    applicationReport,
    /^export function canonicalizePolicy\(/mu,
  );
  for (const lowerLayerFunction of [
    "canonicalizePolicy",
    "createTransitionQueue",
    "diffDecisions",
  ]) {
    assert.doesNotMatch(
      infrastructureReport,
      new RegExp(`^export function ${lowerLayerFunction}\\(`, "mu"),
    );
  }
});

test("keeps the headless client root-only and reconciliation out of application", () => {
  const rootReport = readFileSync(
    path.join(coreRoot, "etc/core.api.md"),
    "utf8",
  );
  const applicationReport = readFileSync(
    path.join(coreRoot, "etc/core-application.api.md"),
    "utf8",
  );
  const reconciliationReport = readFileSync(
    path.join(coreRoot, "etc/core-reconciliation.api.md"),
    "utf8",
  );

  assert.match(rootReport, /^export function createOpenCookie\(/mu);
  for (const rootClientType of [
    "OpenCookie",
    "OpenCookieExternalStore",
    "OpenCookieOptions",
    "OpenCookiePortContext",
    "OpenCookieSnapshot",
  ]) {
    assert.match(
      rootReport,
      new RegExp(`^export (?:interface|type) ${rootClientType}\\b`, "mu"),
    );
  }

  assert.doesNotMatch(
    applicationReport,
    /^export function createOpenCookie\(/mu,
  );
  assert.doesNotMatch(
    applicationReport,
    /^export function createPolicyReconciler\(/mu,
  );
  assert.doesNotMatch(
    applicationReport,
    /^export (?:interface|type) OpenCookie(?:ExternalStore|GrantActivation|IdKind|Options|PendingGrant|PendingGrantRetryResult|PortContext|Readiness|Snapshot|WithdrawalResult)?\b/mu,
  );
  for (const reconciliationSymbol of [
    "ConsentPolicyReconciliation",
    "ConsentPolicyReconciliationInput",
    "ConsentPolicyReconciliationIssue",
    "PolicyReconciler",
  ]) {
    assert.doesNotMatch(
      applicationReport,
      new RegExp(`^export (?:interface|type) ${reconciliationSymbol}\\b`, "mu"),
    );
    assert.match(
      reconciliationReport,
      new RegExp(`^export (?:interface|type) ${reconciliationSymbol}\\b`, "mu"),
    );
  }
  assert.match(
    applicationReport,
    /^import \{ ConsentPolicyReconciliation \} from '@opencookie-dev\/core\/reconciliation';$/mu,
  );
  assert.match(
    reconciliationReport,
    /^export function createPolicyReconciler\(\): PolicyReconciler;/mu,
  );
  assert.doesNotMatch(reconciliationReport, /^export interface OpenCookie\b/mu);
  assert.doesNotMatch(
    reconciliationReport,
    /^export function createTransitionQueue\(/mu,
  );

  const reconciliationExports = [
    ...reconciliationReport.matchAll(
      /^export (?:declare )?(?:const|function|interface|type) ([A-Za-z0-9_]+)\b/gmu,
    ),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(reconciliationExports, [
    "ConsentDecision",
    "ConsentDecisionMethod",
    "ConsentDecisionState",
    "ConsentPolicyAffectedPurposeInput",
    "ConsentPolicyIdentityInput",
    "ConsentPolicyInput",
    "ConsentPolicyReconciliation",
    "ConsentPolicyReconciliationInput",
    "ConsentPolicyReconciliationIssue",
    "ConsentRecord",
    "ConsentRecordBase",
    "ConsentRecordSchemaVersion",
    "DefinedPolicy",
    "DefinedPolicyCategory",
    "DefinedPolicyPurpose",
    "DefinedPolicyReference",
    "PolicyCategoryTranslation",
    "PolicyPurposeTranslation",
    "PolicyReconciler",
    "PolicySnapshot",
    "PolicyVersionChangedWithoutAffectedPurposeIssue",
    "PolicyVersionConsistencyIssue",
    "PolicyVersionUnchangedWithAffectedPurposeIssue",
    "PurposeDecision",
    "PurposeDecisionState",
    "createPolicyReconciler",
  ]);
});
