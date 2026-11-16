import assert from "node:assert/strict";
import test from "node:test";

import {
  checkShippedLicences,
  runtimeClosureOf,
  shippedPackages,
  spdxDocument,
} from "./generate-sbom-lib.mjs";

function document(extra = []) {
  return spdxDocument({
    checksums: new Map([["@opencookie-dev/core", "a".repeat(64)]]),
    created: "2026-09-24T12:00:00Z",
    licences: new Map([["parse5@8.0.1", "MIT"], ...extra]),
    shipped: [
      {
        directory: "packages/core",
        license: "MIT",
        name: "@opencookie-dev/core",
        version: "0.1.0",
      },
      {
        directory: "packages/cli",
        license: "MIT",
        name: "opencookie",
        version: "0.2.1",
      },
    ],
    thirdParty: new Map([
      ["parse5@8.0.1", { name: "parse5", version: "8.0.1" }],
    ]),
  });
}

test("lists a published package with its version, licence and checksum", () => {
  const spdx = document();
  const core = spdx.packages.find(
    ({ name }) => name === "@opencookie-dev/core",
  );

  assert.equal(core.versionInfo, "0.1.0");
  assert.equal(core.licenseDeclared, "MIT");
  assert.equal(core.checksums[0].checksumValue, "a".repeat(64));
  assert.equal(
    core.externalRefs[0].referenceLocator,
    "pkg:npm/@opencookie-dev/core@0.1.0",
  );
});

test("reads the published set from the manifests themselves", () => {
  const shipped = shippedPackages("/repo", (path) => ({
    license: "MIT",
    name: path.includes("core") ? "@opencookie-dev/core" : "other",
    version: "0.1.0",
  }));

  assert.equal(shipped.length, 9);
  assert.ok(shipped.every(({ license }) => license === "MIT"));
});

// A copyleft licence in what a user installs is a licensing defect, not a note.
test("refuses a copyleft licence anywhere in the shipped closure", () => {
  const issues = checkShippedLicences(
    document([["some-lib@1.0.0", "GPL-3.0-or-later"]]).packages.concat({
      SPDXID: "SPDXRef-Dependency-some-lib-1.0.0",
      licenseDeclared: "GPL-3.0-or-later",
      name: "some-lib",
      versionInfo: "1.0.0",
    }),
  );

  assert.equal(issues.length, 1);
  assert.match(issues[0], /some-lib/u);
});

// An unasserted licence is tolerable only for a platform binary that this
// machine never installed; anywhere else it is a gap to close.
test("allows an unasserted licence only for a platform binary", () => {
  const binding = {
    SPDXID: "SPDXRef-Dependency-x",
    licenseDeclared: "NOASSERTION",
    name: "@oxc-parser/binding-linux-arm64-gnu",
    versionInfo: "0.146.0",
  };
  const ordinary = {
    SPDXID: "SPDXRef-Dependency-y",
    licenseDeclared: "NOASSERTION",
    name: "some-runtime-lib",
    versionInfo: "2.0.0",
  };

  assert.deepEqual(checkShippedLicences([binding]), []);
  assert.match(checkShippedLicences([ordinary])[0], /some-runtime-lib/u);
});

test("accepts the permissive licences the project actually ships", () => {
  const packages = [
    "MIT",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
  ].map((licence, index) => ({
    SPDXID: `SPDXRef-Dependency-${String(index)}`,
    licenseDeclared: licence,
    name: `lib-${String(index)}`,
    versionInfo: "1.0.0",
  }));

  assert.deepEqual(checkShippedLicences(packages), []);
});

// `pnpm list` fills an optional peer from whatever else the workspace has
// installed. The Nuxt adapter reached vite, and through it an MPL-2.0 package,
// only that way: @nuxt/kit, unctx, then unplugin's optional vite peer.
function unpluginTree() {
  const manifests = new Map([
    [
      "/store/unplugin",
      {
        dependencies: { picomatch: "^4.0.4" },
        peerDependencies: { rollup: "*", vite: "*" },
        peerDependenciesMeta: {
          rollup: { optional: true },
          vite: { optional: true },
        },
      },
    ],
    ["/store/vite", { dependencies: { lightningcss: "^1.33.0" } }],
  ]);
  const node = (name, version, dependencies) => [
    name,
    { dependencies, path: `/store/${name}`, version },
  ];
  const trees = [
    {
      dependencies: Object.fromEntries([
        node(
          "unplugin",
          "3.3.0",
          Object.fromEntries([
            node("picomatch", "4.0.4"),
            node("rollup", "4.62.5"),
            node(
              "vite",
              "8.2.2",
              Object.fromEntries([node("lightningcss", "1.33.0")]),
            ),
          ]),
        ),
      ]),
      path: "/workspace/packages/adapters/nuxt",
    },
  ];
  return { manifests, trees };
}

test("leaves out an optional peer, which no install brings to a user", () => {
  const { manifests, trees } = unpluginTree();

  const closure = runtimeClosureOf(trees, (path) => manifests.get(path) ?? {});

  assert.deepEqual([...closure.keys()].sort(), [
    "picomatch@4.0.4",
    "unplugin@3.3.0",
  ]);
});

test("keeps a required peer and an optional peer that is also a dependency", () => {
  const { manifests, trees } = unpluginTree();
  manifests.set("/store/unplugin", {
    dependencies: { picomatch: "^4.0.4", rollup: "^4.0.0" },
    peerDependencies: { rollup: "*", vite: "*" },
    peerDependenciesMeta: { rollup: { optional: true } },
  });

  const closure = runtimeClosureOf(trees, (path) => manifests.get(path) ?? {});

  assert.deepEqual([...closure.keys()].sort(), [
    "lightningcss@1.33.0",
    "picomatch@4.0.4",
    "rollup@4.62.5",
    "unplugin@3.3.0",
    "vite@8.2.2",
  ]);
});

// Pass B's minor 5 on 0.2.0: the document had no DESCRIBES relationship, which
// SPDX 2.3 requires for its root, and it named, dated and placed itself as
// opencookie 0.1.1 whatever it described.
test("describes each published package and names itself after the release", () => {
  const spdx = document();

  assert.equal(spdx.name, "opencookie-0.2.1");
  assert.equal(
    spdx.documentNamespace,
    "https://opencookie.dev/spdx/opencookie-0.2.1",
  );
  assert.equal(spdx.creationInfo.created, "2026-09-24T12:00:00Z");
  const described = spdx.relationships
    .filter(
      ({ relationshipType, spdxElementId }) =>
        relationshipType === "DESCRIBES" &&
        spdxElementId === "SPDXRef-DOCUMENT",
    )
    .map(({ relatedSpdxElement }) => relatedSpdxElement)
    .sort();
  assert.deepEqual(
    described,
    spdx.packages
      .filter(({ supplier }) => supplier === "Organization: OpenCookie")
      .map(({ SPDXID }) => SPDXID)
      .sort(),
  );
});
