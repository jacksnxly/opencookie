import { join } from "node:path";

const PUBLISHED = [
  "packages/core",
  "packages/cli",
  "packages/adapters/vanilla",
  "packages/adapters/react",
  "packages/adapters/vue",
  "packages/adapters/svelte",
  "packages/adapters/next",
  "packages/adapters/nuxt",
  "packages/adapters/astro",
];

/** The packages this repository publishes, read from their own manifests. */
export function shippedPackages(root, readJson) {
  return PUBLISHED.map((directory) => {
    const manifest = readJson(join(root, directory, "package.json"));
    return {
      directory,
      license: manifest.license,
      name: manifest.name,
      version: manifest.version,
    };
  });
}

/** The optional peers a manifest declares and does not also depend on. */
function optionalPeers(manifest) {
  const depended = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.optionalDependencies ?? {}),
  ]);
  return new Set(
    Object.entries(manifest?.peerDependenciesMeta ?? {})
      .filter(([name, meta]) => meta?.optional === true && !depended.has(name))
      .map(([name]) => name),
  );
}

/**
 * Every third-party package a published package brings to a user, from
 * `pnpm list --prod --json` trees.
 *
 * `pnpm list` fills an optional peer from whatever else the workspace has
 * installed. Neither npm nor pnpm installs an optional peer for a user, so an
 * edge to one is the host's choice, and it is left out here. A required peer
 * stays, since both install it.
 */
export function runtimeClosureOf(trees, readManifest) {
  const found = new Map();
  const walk = (dependencies, path) => {
    const skipped = optionalPeers(readManifest(path));
    for (const [dependency, info] of Object.entries(dependencies ?? {})) {
      if (skipped.has(dependency)) continue;
      const version = String(info.version ?? "");
      if (!version.startsWith("link:")) {
        found.set(`${dependency}@${version}`, { name: dependency, version });
      }
      walk(info.dependencies, info.path);
    }
  };
  for (const tree of trees) walk(tree.dependencies, tree.path);
  return found;
}

function identifier(prefix, name, version) {
  return `SPDXRef-${prefix}-${name.replace(/[^\w.-]/gu, "-")}-${version}`;
}

/**
 * Builds an SPDX 2.3 document for what this repository ships.
 *
 * It covers the published packages and the third-party packages that reach a
 * user at runtime. Development tooling is deliberately out of scope: it is not
 * in any artifact a user installs, and listing it would make the document say
 * less about what ships, not more.
 */
export function spdxDocument({
  checksums,
  created,
  licences,
  shipped,
  thirdParty,
}) {
  const packages = [
    ...shipped.map((entry) => ({
      SPDXID: identifier("Package", entry.name, entry.version),
      checksums:
        checksums.get(entry.name) === undefined
          ? undefined
          : [
              {
                algorithm: "SHA256",
                checksumValue: checksums.get(entry.name),
              },
            ],
      downloadLocation: `https://registry.npmjs.org/${entry.name}/-/${entry.name.split("/").at(-1)}-${entry.version}.tgz`,
      externalRefs: [
        {
          referenceCategory: "PACKAGE-MANAGER",
          referenceLocator: `pkg:npm/${entry.name}@${entry.version}`,
          referenceType: "purl",
        },
      ],
      filesAnalyzed: false,
      licenseConcluded: entry.license ?? "NOASSERTION",
      licenseDeclared: entry.license ?? "NOASSERTION",
      name: entry.name,
      supplier: "Organization: OpenCookie",
      versionInfo: entry.version,
    })),
    ...[...thirdParty.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({
        SPDXID: identifier("Dependency", entry.name, entry.version),
        downloadLocation: `https://registry.npmjs.org/${entry.name}/-/${entry.name.split("/").at(-1)}-${entry.version}.tgz`,
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceLocator: `pkg:npm/${entry.name}@${entry.version}`,
            referenceType: "purl",
          },
        ],
        filesAnalyzed: false,
        licenseConcluded:
          licences.get(`${entry.name}@${entry.version}`) ?? "NOASSERTION",
        licenseDeclared:
          licences.get(`${entry.name}@${entry.version}`) ?? "NOASSERTION",
        name: entry.name,
        versionInfo: entry.version,
      })),
  ];

  // Named after the initializer's release, which pins every other package.
  const release = `opencookie-${shipped.find(({ name }) => name === "opencookie")?.version ?? "unknown"}`;
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      creators: ["Tool: opencookie-generate-sbom"],
      created,
    },
    dataLicense: "CC0-1.0",
    documentNamespace: `https://opencookie.dev/spdx/${release}`,
    name: release,
    packages,
    relationships: shipped.map((entry) => ({
      relatedSpdxElement: identifier("Package", entry.name, entry.version),
      relationshipType: "DESCRIBES",
      spdxElementId: "SPDXRef-DOCUMENT",
    })),
    spdxVersion: "SPDX-2.3",
  };
}

const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "Python-2.0",
  "Unlicense",
]);

/** A platform binary is only installed on its own platform, so this machine
 * cannot read its licence and says so rather than guessing. */
const PLATFORM_BINARY = /binding-|-(darwin|linux|win32|android|freebsd)-/u;

/**
 * Checks what a user would actually install.
 *
 * A copyleft licence in that set is a licensing defect. An unasserted licence
 * is tolerated only for a platform binary this machine never installed, and is
 * a gap to close anywhere else.
 */
export function checkShippedLicences(packages) {
  const issues = [];
  for (const entry of packages) {
    const licence = String(entry.licenseDeclared ?? "NOASSERTION");
    if (licence === "NOASSERTION") {
      if (!PLATFORM_BINARY.test(entry.name)) {
        issues.push(
          `${entry.name}@${String(entry.versionInfo)} ships without a declared licence.`,
        );
      }
      continue;
    }
    if (!PERMISSIVE.has(licence)) {
      issues.push(
        `${entry.name}@${String(entry.versionInfo)} ships under ${licence}, which is not one of the permissive licences this project allows to reach a user.`,
      );
    }
  }
  return issues;
}
