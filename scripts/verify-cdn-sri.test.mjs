import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "@playwright/test";

import {
  CDN_BUILD_COMMAND,
  assertCdnScriptMarkup,
  canonicalCdnUrl,
  proveCrossOriginSri,
  sha384Integrity,
  validateCdnIntegrityMetadata,
} from "./verify-cdn-sri-lib.mjs";

const metadata = Object.freeze({
  algorithm: "sha384",
  file: "dist/auto.iife.js",
  integrity:
    "sha384-569b1nnHrx/UdPqYNZS7A7gdEeRZZaRz8kzyBqO3D2qhLcDvh+iLpo64ZeC78/s3",
  package: "@opencookie-dev/vanilla",
  version: "0.1.0",
});

test("builds the vanilla package after its workspace dependencies", () => {
  assert.deepEqual(CDN_BUILD_COMMAND, {
    args: ["--filter", "@opencookie-dev/vanilla...", "build"],
    command: "pnpm",
  });
});

test("derives a SHA-384 SRI token from the exact artifact bytes", () => {
  assert.equal(
    sha384Integrity(Buffer.from("packed vanilla bytes")),
    "sha384-oSSgZfmMk4U4qk7GY6Xpq+OpxJAZr8H0vTwnTXxYoWNcibZtw0Rb5q5C2DRV55qo",
  );
});

test("accepts only an exact package version and a SHA-384 digest", () => {
  assert.deepEqual(validateCdnIntegrityMetadata(metadata), metadata);
  assert.equal(
    canonicalCdnUrl(metadata),
    "https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.1.0/dist/auto.iife.js",
  );

  for (const version of ["latest", "^0.1.0", "~0.1.0", "0.1", "*"]) {
    assert.throws(
      () => validateCdnIntegrityMetadata({ ...metadata, version }),
      /exact semantic version/iu,
    );
  }
  assert.throws(
    () =>
      validateCdnIntegrityMetadata({
        ...metadata,
        integrity: metadata.integrity.replace("sha384-", "sha256-"),
      }),
    /SHA-384/iu,
  );
});

test("requires every canonical CDN script to bind integrity and anonymous CORS", () => {
  const url = canonicalCdnUrl(metadata);
  const protectedMarkup = `<script
    defer
    data-oc-policy-version="policy-1"
    crossorigin="anonymous"
    integrity="${metadata.integrity}"
    src="${url}"
  ></script>`;

  assert.equal(
    assertCdnScriptMarkup(protectedMarkup, metadata, {
      expectedCount: 1,
      label: "protected sample",
    }),
    1,
  );

  for (const [label, unsafeMarkup] of [
    ["missing integrity", protectedMarkup.replace(/\s+integrity="[^"]+"/u, "")],
    [
      "wrong integrity",
      protectedMarkup.replace(
        metadata.integrity,
        `${metadata.integrity.slice(0, -1)}A`,
      ),
    ],
    [
      "missing CORS",
      protectedMarkup.replace(/\s+crossorigin="anonymous"/u, ""),
    ],
    [
      "credentialed CORS",
      protectedMarkup.replace(
        'crossorigin="anonymous"',
        'crossorigin="use-credentials"',
      ),
    ],
  ]) {
    assert.throws(
      () =>
        assertCdnScriptMarkup(unsafeMarkup, metadata, {
          expectedCount: 1,
          label,
        }),
      /integrity|crossorigin/iu,
    );
  }
});

test("a real cross-origin browser accepts exact bytes and rejects tampering", async () => {
  const bundleBytes = Buffer.from(
    "globalThis.OpenCookie = Object.freeze({}); globalThis.__ocSriLoaded = true;",
  );
  const proof = await proveCrossOriginSri({
    browserType: chromium,
    bundleBytes,
    integrity: sha384Integrity(bundleBytes),
  });

  assert.deepEqual(proof, {
    genuine: { loaded: true, namespacePresent: true },
    tampered: { loaded: false, namespacePresent: false },
  });
});
