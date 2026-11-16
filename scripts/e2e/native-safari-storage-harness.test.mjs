import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";

import { startNativeSafariStorageHarness } from "./native-safari-storage-harness.mjs";

const repositoryRoot = new URL("../../", import.meta.url);
const runningHarnesses = [];

afterEach(async () => {
  await Promise.all(
    runningHarnesses.splice(0).map((harness) => harness.close()),
  );
});

describe("native Safari storage harness", () => {
  it("serves a real loopback cross-site iframe and a first-party control", async () => {
    const runId = "contract-proof";
    const harness = await startNativeSafariStorageHarness({
      childPort: 0,
      parentPort: 0,
      repositoryRoot,
      runId,
    });
    runningHarnesses.push(harness);

    const [parentResponse, crossSiteResponse, firstPartyResponse] =
      await Promise.all([
        fetch(harness.parentUrl),
        fetch(harness.crossSiteChildUrl),
        fetch(harness.firstPartyUrl),
      ]);
    assert.equal(parentResponse.status, 200);
    assert.equal(crossSiteResponse.status, 200);
    assert.equal(firstPartyResponse.status, 200);

    const [parent, crossSite, firstParty] = await Promise.all([
      parentResponse.text(),
      crossSiteResponse.text(),
      firstPartyResponse.text(),
    ]);
    assert.equal(new URL(harness.parentUrl).hostname, "localhost");
    assert.equal(new URL(harness.crossSiteChildUrl).hostname, "127.0.0.1");
    assert.match(parent, new RegExp(harness.crossSiteChildUrl, "u"));
    assert.match(parent, /title="Cross-site OpenCookie consent surface"/u);
    assert.match(crossSite, /data-oc-storage="cookie"/u);
    assert.match(
      crossSite,
      /<script\s+defer\s+nonce="opencookie-native-safari-proof"/u,
    );
    assert.match(
      crossSite,
      /data-oc-storage-key="opencookie[.]native[.]cross-site[.]contract-proof"/u,
    );
    assert.match(
      firstParty,
      /data-oc-storage-key="opencookie[.]native[.]first-party[.]contract-proof"/u,
    );
    assert.doesNotMatch(crossSite, /data-oc-cookie-domain/u);
    assert.doesNotMatch(firstParty, /data-oc-cookie-domain/u);
    assert.match(crossSite, /Decision cookie present/u);
    assert.match(crossSite, /Optional script runs/u);
    assert.match(crossSite, /Persistence alert/u);
    assert.match(
      crossSite,
      /target && target[.]textContent !== next/u,
      "status rendering must not recursively retrigger its MutationObserver",
    );
  });

  it("serves the exact built vanilla IIFE with matching integrity", async () => {
    const harness = await startNativeSafariStorageHarness({
      childPort: 0,
      parentPort: 0,
      repositoryRoot,
      runId: "integrity-proof",
    });
    runningHarnesses.push(harness);

    const [pageResponse, bundleResponse, builtBundle] = await Promise.all([
      fetch(harness.firstPartyUrl),
      fetch(harness.bundleUrl),
      readFile(
        new URL(
          "../../packages/adapters/vanilla/dist/auto.iife.js",
          import.meta.url,
        ),
      ),
    ]);
    const [page, servedBundle] = await Promise.all([
      pageResponse.text(),
      bundleResponse.arrayBuffer(),
    ]);
    const integrity = `sha384-${createHash("sha384")
      .update(builtBundle)
      .digest("base64")}`;

    assert.deepEqual(Buffer.from(servedBundle), builtBundle);
    assert.ok(page.includes(`integrity="${integrity}"`));
    assert.equal(bundleResponse.headers.get("cache-control"), "no-store");
  });
});
