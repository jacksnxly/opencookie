import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const specUrl = new URL(
  "../../tests/e2e/storage/storage-resilience.spec.ts",
  import.meta.url,
);
const faultsUrl = new URL(
  "../../tests/e2e/storage/support/storage-faults.ts",
  import.meta.url,
);

describe("storage-resilience browser suite source", () => {
  it("declares the exact 12 catalogue cases without a Safari claim", async () => {
    const source = await readFile(specUrl, "utf8");

    assert.match(source, /createStorageContractCases/u);
    assert.match(source, /for \(const contractCase of storageCases\)/u);
    assert.match(source, /storageCases[.]length !== 12/u);
    assert.doesNotMatch(source, /Safari/u);
  });

  it("installs one self-contained fault script with native browser semantics", async () => {
    const [spec, faults] = await Promise.all([
      readFile(specUrl, "utf8"),
      readFile(faultsUrl, "utf8"),
    ]);

    assert.equal(spec.match(/[.]addInitScript\(/gu)?.length, 1);
    assert.match(faults, /Storage[.]prototype[.]getItem[.]bind/u);
    assert.match(faults, /Storage[.]prototype[.]setItem[.]bind/u);
    assert.match(faults, /Storage[.]prototype[.]removeItem[.]bind/u);
    assert.match(faults, /new DOMException\([^)]*"SecurityError"/su);
    assert.match(faults, /new DOMException\([^)]*"QuotaExceededError"/su);
    assert.match(faults, /sessionStorage/u);
    assert.match(faults, /enumerable: false/u);
  });

  it("pins visible fail-closed recovery and deterministic emulation labels", async () => {
    const source = await readFile(specUrl, "utf8");

    assert.match(source, /getByRole\("alert"\)/u);
    assert.match(source, /Try saving again/u);
    assert.match(source, /press\("Enter"\)/u);
    assert.match(source, /deterministic emulation/u);
    assert.match(source, /recoveryOutcome: "policy-remains-blocked"/u);
    assert.match(source, /released: false/u);
    assert.match(source, /beforeRetryOperations/u);
    assert.match(source, /afterRetryOperations/u);
    assert.match(source, /context A/u);
    assert.match(source, /context B/u);
  });

  it("persists storage evidence to a per-test JSON path before attachment", async () => {
    const source = await readFile(specUrl, "utf8");

    assert.match(source, /import \{ writeFile \} from "node:fs\/promises"/u);
    assert.match(source, /testInfo[.]outputPath\("storage-evidence[.]json"\)/u);
    assert.match(source, /writeFile\(evidencePath,/u);
    assert.match(
      source,
      /testInfo[.]attach\("storage-evidence", \{[\s\S]*path: evidencePath/u,
    );
    assert.doesNotMatch(source, /body: Buffer[.]from/u);
  });
});
