import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createStorageContractCases,
  STORAGE_E2E_CONTRACTS,
  STORAGE_E2E_INTEGRATIONS,
} from "./storage-contract-catalogue.mjs";

const EXPECTED_CONTRACTS = [
  "TEST-STORAGE-LOCALSTORAGE-GETTER-SECURITYERROR",
  "TEST-STORAGE-CACHED-GETITEM-SECURITYERROR",
  "TEST-STORAGE-SETITEM-QUOTAEXCEEDED",
  "TEST-STORAGE-SILENT-COOKIE-SUPPRESSION",
  "TEST-STORAGE-CONTEXT-EPHEMERALITY",
  "TEST-STORAGE-DETERMINISTIC-CROSS-SITE-COOKIE-DENIAL-EMULATION",
];

describe("storage-resilience contract catalogue", () => {
  it("crosses six exact storage contracts with both shipped integrations", () => {
    assert.deepEqual(STORAGE_E2E_CONTRACTS, EXPECTED_CONTRACTS);
    assert.deepEqual(STORAGE_E2E_INTEGRATIONS, [
      {
        id: "plain-cdn-auto",
        fixtureId: "plain-cdn",
        integration: "auto",
      },
      {
        id: "react-vite-generic",
        fixtureId: "react-vite",
        integration: "generic",
      },
    ]);

    const cases = createStorageContractCases();
    assert.equal(cases.length, 12);
    assert.equal(new Set(cases.map(({ id }) => id)).size, 12);
    for (const contract of EXPECTED_CONTRACTS) {
      assert.equal(
        cases.filter((entry) => entry.contract === contract).length,
        2,
      );
    }
    for (const integration of STORAGE_E2E_INTEGRATIONS) {
      assert.equal(
        cases.filter((entry) => entry.integration.id === integration.id).length,
        6,
      );
    }
  });

  it("labels the policy case as deterministic emulation and never as Safari", () => {
    const cases = createStorageContractCases();
    const serialized = JSON.stringify(cases);
    assert.match(
      serialized,
      /deterministic cross-site cookie denial emulation/iu,
    );
    assert.deepEqual(
      cases
        .filter(
          ({ fault }) =>
            fault === "deterministic-cross-site-cookie-denial-emulation",
        )
        .map(({ recoveryOutcome }) => recoveryOutcome),
      ["policy-remains-blocked", "policy-remains-blocked"],
    );
    assert.ok(
      cases
        .filter(
          ({ fault }) =>
            fault !== "deterministic-cross-site-cookie-denial-emulation",
        )
        .every(({ recoveryOutcome }) => recoveryOutcome === undefined),
    );
    assert.doesNotMatch(serialized, /Safari/u);
  });

  it("declares two screenshots only for isolated-context proof", () => {
    const cases = createStorageContractCases();
    assert.deepEqual(
      cases
        .filter(({ fault }) => fault === "context-ephemerality")
        .map(({ screenshotCount }) => screenshotCount),
      [2, 2],
    );
    assert.ok(
      cases
        .filter(({ fault }) => fault !== "context-ephemerality")
        .every(({ screenshotCount }) => screenshotCount === undefined),
    );
  });
});
