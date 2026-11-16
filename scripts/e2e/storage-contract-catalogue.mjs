/** The two shipped browser integrations covered by storage-resilience proof. */
export const STORAGE_E2E_INTEGRATIONS = Object.freeze([
  Object.freeze({
    fixtureId: "plain-cdn",
    id: "plain-cdn-auto",
    integration: "auto",
  }),
  Object.freeze({
    fixtureId: "react-vite",
    id: "react-vite-generic",
    integration: "generic",
  }),
]);

const STORAGE_SCENARIOS = Object.freeze([
  Object.freeze({
    contract: "TEST-STORAGE-LOCALSTORAGE-GETTER-SECURITYERROR",
    fault: "local-storage-getter-security-error",
    mechanism: "window.localStorage getter SecurityError",
    route: "/__storage/local",
  }),
  Object.freeze({
    contract: "TEST-STORAGE-CACHED-GETITEM-SECURITYERROR",
    fault: "cached-get-item-security-error",
    mechanism: "cached Storage getItem SecurityError",
    route: "/__storage/local",
  }),
  Object.freeze({
    contract: "TEST-STORAGE-SETITEM-QUOTAEXCEEDED",
    fault: "set-item-quota-exceeded-error",
    mechanism: "Storage setItem QuotaExceededError",
    route: "/__storage/local",
  }),
  Object.freeze({
    contract: "TEST-STORAGE-SILENT-COOKIE-SUPPRESSION",
    fault: "silent-cookie-write-suppression",
    mechanism: "silent cookie write suppression and readback mismatch",
    route: "/__storage/cookie",
  }),
  Object.freeze({
    contract: "TEST-STORAGE-CONTEXT-EPHEMERALITY",
    fault: "context-ephemerality",
    mechanism: "isolated BrowserContext A and B storage",
    route: "/__storage/local",
    screenshotCount: 2,
  }),
  Object.freeze({
    contract: "TEST-STORAGE-DETERMINISTIC-CROSS-SITE-COOKIE-DENIAL-EMULATION",
    fault: "deterministic-cross-site-cookie-denial-emulation",
    mechanism: "deterministic cross-site cookie denial emulation",
    recoveryOutcome: "policy-remains-blocked",
    route: "/__storage/cookie",
  }),
]);

/** Stable storage contract identifiers required in every selected project. */
export const STORAGE_E2E_CONTRACTS = Object.freeze(
  STORAGE_SCENARIOS.map(({ contract }) => contract),
);

/** Crosses every required mechanism with both shipped integrations. */
export function createStorageContractCases() {
  return Object.freeze(
    STORAGE_E2E_INTEGRATIONS.flatMap((integration) =>
      STORAGE_SCENARIOS.map((scenario) =>
        Object.freeze({
          ...scenario,
          id: `${integration.id}:${scenario.contract}`,
          integration,
        }),
      ),
    ),
  );
}
