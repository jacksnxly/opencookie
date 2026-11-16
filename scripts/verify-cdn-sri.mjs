import { spawn } from "node:child_process";
import { readFile, readdir, rm, mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  CDN_BUILD_COMMAND,
  assertCdnScriptMarkup,
  canonicalCdnUrl,
  proveCrossOriginSri,
  sha384Integrity,
  validateCdnIntegrityMetadata,
} from "./verify-cdn-sri-lib.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const canonicalSources = Object.freeze([
  Object.freeze({
    expectedCount: 3,
    path: "packages/adapters/vanilla/README.md",
  }),
  Object.freeze({
    expectedCount: 1,
    path: "apps/docs/samples/cdn-one-line.sample.ts",
  }),
  Object.freeze({
    expectedCount: 1,
    path: "apps/docs/samples/subdomain-cdn.sample.ts",
  }),
  Object.freeze({ expectedCount: 1, path: "fixtures/plain-cdn/index.html" }),
  Object.freeze({ expectedCount: 1, path: "packages/cli/src/init.ts" }),
]);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ?? `exit code ${String(code)}`}.`,
        ),
      );
    });
  });
}

async function readMetadata() {
  return validateCdnIntegrityMetadata(
    JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "packages/adapters/vanilla/cdn-integrity.json",
        ),
        "utf8",
      ),
    ),
  );
}

async function verifyCanonicalSources(metadata) {
  for (const source of canonicalSources) {
    assertCdnScriptMarkup(
      await readFile(path.join(repositoryRoot, source.path), "utf8"),
      metadata,
      { expectedCount: source.expectedCount, label: source.path },
    );
  }
}

async function packedBundle(temporaryDirectory) {
  const tarballDirectory = path.join(temporaryDirectory, "tarballs");
  const extractionDirectory = path.join(temporaryDirectory, "extracted");
  await Promise.all([
    mkdir(tarballDirectory, { recursive: true }),
    mkdir(extractionDirectory, { recursive: true }),
  ]);
  await run(CDN_BUILD_COMMAND.command, CDN_BUILD_COMMAND.args, repositoryRoot);
  await run(
    "pnpm",
    [
      "--filter",
      "@opencookie-dev/vanilla",
      "pack",
      "--pack-destination",
      tarballDirectory,
      "--json",
    ],
    repositoryRoot,
  );
  const tarballs = (await readdir(tarballDirectory)).filter((entry) =>
    entry.endsWith(".tgz"),
  );
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one packed vanilla tarball, found ${String(tarballs.length)}.`,
    );
  }
  await run(
    "tar",
    [
      "-xzf",
      path.join(tarballDirectory, tarballs[0]),
      "-C",
      extractionDirectory,
    ],
    repositoryRoot,
  );
  const packageRoot = path.join(extractionDirectory, "package");
  return Object.freeze({
    bytes: await readFile(path.join(packageRoot, "dist/auto.iife.js")),
    manifest: JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ),
    readme: await readFile(path.join(packageRoot, "README.md"), "utf8"),
  });
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "opencookie-cdn-sri-"),
);
try {
  const metadata = await readMetadata();
  await verifyCanonicalSources(metadata);
  const packed = await packedBundle(temporaryDirectory);
  if (
    packed.manifest.name !== metadata.package ||
    packed.manifest.version !== metadata.version ||
    packed.manifest.jsdelivr !== `./${metadata.file}` ||
    packed.manifest.unpkg !== `./${metadata.file}`
  ) {
    throw new Error(
      "Packed vanilla manifest does not match the pinned CDN metadata.",
    );
  }
  assertCdnScriptMarkup(packed.readme, metadata, {
    expectedCount: 3,
    label: "packed vanilla README",
  });
  const actualIntegrity = sha384Integrity(packed.bytes);
  if (actualIntegrity !== metadata.integrity) {
    throw new Error(
      `Packed IIFE integrity changed: expected ${metadata.integrity}, received ${actualIntegrity}.`,
    );
  }
  const proof = await proveCrossOriginSri({
    browserType: chromium,
    bundleBytes: packed.bytes,
    integrity: metadata.integrity,
  });
  if (
    proof.genuine.loaded !== true ||
    proof.genuine.namespacePresent !== true ||
    proof.tampered.loaded !== false ||
    proof.tampered.namespacePresent !== false
  ) {
    throw new Error(`Cross-origin SRI proof failed: ${JSON.stringify(proof)}.`);
  }
  console.log(`CDN SRI PASS: ${canonicalCdnUrl(metadata)}`);
  console.log(`Packed integrity: ${metadata.integrity}`);
  console.log("Browser proof: genuine loaded; tampered bytes rejected.");
} catch (error) {
  console.error(
    `[verify-cdn-sri] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  const resolvedTemporaryDirectory = path.resolve(temporaryDirectory);
  const allowedPrefix = path.join(
    path.resolve(os.tmpdir()),
    "opencookie-cdn-sri-",
  );
  if (!resolvedTemporaryDirectory.startsWith(allowedPrefix)) {
    console.error("Refusing to remove an unexpected SRI temporary directory.");
    process.exitCode = 1;
  } else {
    await rm(resolvedTemporaryDirectory, { force: true, recursive: true });
  }
}
