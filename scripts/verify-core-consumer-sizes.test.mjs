import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertCanonicalCoreBuildArtifacts,
  assertDocumentedCoreConsumerGraphSizes,
  ConsumerGraphSizeError,
  coreConsumerGraphs,
  evaluateCeilingHeadroom,
  createConsumerGraphSource,
  programmaticRouteGraphs,
  verifyCoreConsumerGraphs,
  verifyProgrammaticRouteGraphs,
} from "./verify-core-consumer-sizes-lib.mjs";

const coreEntryFileNames = [
  "application.js",
  "auto.js",
  "domain.js",
  "index.js",
  "infrastructure.js",
  "reconciliation.js",
];

test("defines the three additive packed consumer graph caps", () => {
  // The graph composition is what this test owns: which subpaths each graph
  // bundles, in order, under which name. The cap values are owned by
  // scripts/size-budget-units.test.mjs, which holds them to the same
  // one-percent rule as the eight per-artifact ceilings. They were written out
  // here as a sixth hand-maintained copy and went stale the first time the
  // caps tightened, so this asserts composition and leaves the numbers to the
  // one place that reasons about them.
  assert.deepEqual(
    coreConsumerGraphs.map(({ name, specifiers }) => ({ name, specifiers })),
    [
      {
        name: "core root plus infrastructure",
        specifiers: [
          "@opencookie-dev/core",
          "@opencookie-dev/core/infrastructure",
        ],
      },
      {
        name: "core root plus domain plus infrastructure",
        specifiers: [
          "@opencookie-dev/core",
          "@opencookie-dev/core/domain",
          "@opencookie-dev/core/infrastructure",
        ],
      },
      {
        name: "core domain plus application plus infrastructure",
        specifiers: [
          "@opencookie-dev/core/domain",
          "@opencookie-dev/core/application",
          "@opencookie-dev/core/infrastructure",
        ],
      },
    ],
  );

  for (const graph of coreConsumerGraphs) {
    assert.ok(
      Number.isSafeInteger(graph.limitBytes) && graph.limitBytes > 0,
      `${graph.name} must declare a positive integer cap.`,
    );
  }
});

test("retains every runtime export from each representative subpath", () => {
  const source = createConsumerGraphSource(coreConsumerGraphs[1]);

  assert.match(source, /import \* as entry0 from "@opencookie-dev\/core";/u);
  assert.match(
    source,
    /import \* as entry1 from "@opencookie-dev\/core\/domain";/u,
  );
  assert.match(
    source,
    /import \* as entry2 from "@opencookie-dev\/core\/infrastructure";/u,
  );
  assert.match(source, /globalThis\.__openCookieConsumerGraph/u);
});

test("measures one self-contained minified bundle per graph at gzip level 9", async () => {
  const calls = [];
  const result = await verifyCoreConsumerGraphs({
    bundle: ({ graph, source }) => {
      calls.push({ graph, source });
      return Promise.resolve({
        code: `globalThis.graph=${JSON.stringify(graph.name)};`,
        fileNames: [`${graph.name.replaceAll(" ", "-")}.js`],
      });
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(
    result.map(({ limitBytes, name }) => ({ limitBytes, name })),
    coreConsumerGraphs.map(({ limitBytes, name }) => ({ limitBytes, name })),
  );
  assert.ok(
    result.every(({ gzipBytes, rawBytes }) => gzipBytes < rawBytes + 40),
  );
});

test("rejects hidden chunks, unresolved imports, and an exceeded graph cap", async () => {
  await assert.rejects(
    verifyCoreConsumerGraphs({
      bundle: () =>
        Promise.resolve({
          code: 'import "./hidden.js";',
          fileNames: ["graph.js", "hidden.js"],
        }),
    }),
    (error) => {
      assert.ok(error instanceof ConsumerGraphSizeError);
      assert.match(error.message, /self-contained.*one JavaScript file/i);
      return true;
    },
  );

  let state = 17;
  const noisyCode = Array.from({ length: 100_000 }, () => {
    state = (state * 48_271) % 2_147_483_647;
    return String.fromCharCode(33 + (state % 90));
  }).join("");
  await assert.rejects(
    verifyCoreConsumerGraphs({
      bundle: () =>
        Promise.resolve({ code: noisyCode, fileNames: ["graph.js"] }),
    }),
    /exceeds.*byte gzip cap/i,
  );
});

test("rejects TypeScript build stubs before measuring consumer graphs", () => {
  const canonicalArtifacts = Object.fromEntries(
    coreEntryFileNames.map((fileName) => [
      fileName,
      fileName === "application.js"
        ? 'import{createPolicyReconciler as reconcile}from"@opencookie-dev/core/reconciliation";const value=reconcile;export{value};'
        : "const value=1;export{value};",
    ]),
  );
  assert.doesNotThrow(() =>
    assertCanonicalCoreBuildArtifacts(canonicalArtifacts),
  );

  assert.throws(
    () =>
      assertCanonicalCoreBuildArtifacts({
        ...canonicalArtifacts,
        "index.js": 'export * from "./application/index.js";',
      }),
    /canonical core build products.*index[.]js/iu,
  );

  const withoutAuto = { ...canonicalArtifacts };
  delete withoutAuto["auto.js"];
  assert.throws(
    () => assertCanonicalCoreBuildArtifacts(withoutAuto),
    /canonical core build products.*auto[.]js/iu,
  );

  const withoutReconciliation = { ...canonicalArtifacts };
  delete withoutReconciliation["reconciliation.js"];
  assert.throws(
    () => assertCanonicalCoreBuildArtifacts(withoutReconciliation),
    /canonical core build products.*reconciliation[.]js/iu,
  );

  assert.throws(
    () =>
      assertCanonicalCoreBuildArtifacts({
        ...canonicalArtifacts,
        "application.js":
          'import{createPolicyReconciler}from"@opencookie-dev/core/other";export{createPolicyReconciler};',
      }),
    /exact application-to-reconciliation link/iu,
  );
});

test("aliases the reconciliation product in consumer graph builds", () => {
  const verifier = readFileSync(
    new URL("./verify-core-consumer-sizes.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    verifier,
    /"@opencookie-dev\/core\/reconciliation": path[.]join\([\s\S]*?"reconciliation[.]js"/u,
  );
});

test("rejects an auto entry that carries consent-receipt projection", () => {
  const canonicalArtifacts = Object.fromEntries(
    coreEntryFileNames.map((fileName) => [
      fileName,
      fileName === "application.js"
        ? 'import{createPolicyReconciler as reconcile}from"@opencookie-dev/core/reconciliation";const value=reconcile;export{value};'
        : "const value=1;export{value};",
    ]),
  );

  assert.throws(
    () =>
      assertCanonicalCoreBuildArtifacts({
        ...canonicalArtifacts,
        "auto.js": 'const receipt={idempotencyKey:"a:1"};export{receipt};',
      }),
    /auto[.]js.*receipt-free/iu,
  );
});

// The drop-in's resources each serve one purpose, so the any-of access rule
// for a tag manager's container is injected only into the generic product.
test("rejects an auto entry that carries the any-of access rule", () => {
  const canonicalArtifacts = Object.fromEntries(
    coreEntryFileNames.map((fileName) => [
      fileName,
      fileName === "application.js"
        ? 'import{createPolicyReconciler as reconcile}from"@opencookie-dev/core/reconciliation";const value=reconcile;export{value};'
        : "const value=1;export{value};",
    ]),
  );

  for (const rule of [
    "const r=t.purposeMatch===`any`?a(e,t):o(e,t);export{r};",
    'const r=t.purposeMatch==="any"?a(e,t):o(e,t);export{r};',
  ]) {
    assert.throws(
      () =>
        assertCanonicalCoreBuildArtifacts({
          ...canonicalArtifacts,
          "auto.js": rule,
        }),
      /auto[.]js.*any-of access rule/iu,
    );
  }
  // Carrying the field through a projection is not the rule.
  assert.doesNotThrow(() =>
    assertCanonicalCoreBuildArtifacts({
      ...canonicalArtifacts,
      "auto.js":
        "const r=e.purposeMatch===void 0?{}:{purposeMatch:e.purposeMatch};export{r};",
    }),
  );
});

test("rejects stale documented combined graph measurements", () => {
  const results = [
    {
      gzipBytes: 17_586,
      name: "core root plus infrastructure",
    },
    {
      gzipBytes: 26_573,
      name: "core root plus domain plus infrastructure",
    },
    {
      gzipBytes: 25_927,
      name: "core domain plus application plus infrastructure",
    },
  ];
  const documentation =
    "The current graphs are 17,586 bytes for root plus infrastructure, 26,573 bytes for root plus domain plus infrastructure, and 25,927 bytes for domain plus application plus infrastructure.";

  assert.doesNotThrow(() =>
    assertDocumentedCoreConsumerGraphSizes({ documentation, results }),
  );
  assert.throws(
    () =>
      assertDocumentedCoreConsumerGraphSizes({
        documentation: documentation.replace("25,927", "25,892"),
        results,
      }),
    /documented combined graph sizes are stale.*25,927/iu,
  );
});

test("the canonical size command rebuilds measured artifacts before every budget", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.scripts.size,
    "pnpm --filter @opencookie-dev/core build && pnpm --filter @opencookie-dev/vanilla build && size-limit && node scripts/verify-core-consumer-sizes.mjs",
  );
});

test("documented graph measurements are compared only under the pinned Node major", () => {
  const results = [
    { gzipBytes: 17_586, name: "core root plus infrastructure" },
    { gzipBytes: 26_573, name: "core root plus domain plus infrastructure" },
    {
      gzipBytes: 25_927,
      name: "core domain plus application plus infrastructure",
    },
  ];
  const stale =
    "The current graphs are 17,586 bytes for root plus infrastructure, 26,573 bytes for root plus domain plus infrastructure, and 25,892 bytes for domain plus application plus infrastructure.";

  // Off the pinned major the documented gzip figures describe a different
  // toolchain, so comparing them reports a defect that does not exist.
  assert.doesNotThrow(() =>
    assertDocumentedCoreConsumerGraphSizes({
      documentation: stale,
      pinnedNodeMajor: 24,
      results,
      runningNodeMajor: 26,
    }),
  );

  // On the pinned major the assertion keeps its full strength.
  assert.throws(
    () =>
      assertDocumentedCoreConsumerGraphSizes({
        documentation: stale,
        pinnedNodeMajor: 24,
        results,
        runningNodeMajor: 24,
      }),
    /documented combined graph sizes are stale/iu,
  );
});

test("the headroom predicate separates over-budget from excess slack", () => {
  // exactly at the ceiling is over budget: headroom must be positive
  assert.equal(
    evaluateCeilingHeadroom({ ceiling: 1_000, measured: 1_000 }).overBudget,
    true,
  );
  assert.equal(
    evaluateCeilingHeadroom({ ceiling: 999, measured: 1_000 }).overBudget,
    true,
  );
  assert.equal(
    evaluateCeilingHeadroom({ ceiling: 1_001, measured: 1_000 }).overBudget,
    false,
  );

  // one percent of 1,000 is 10, so 10 bytes of headroom is already absorbable
  assert.equal(
    evaluateCeilingHeadroom({ ceiling: 1_010, measured: 1_000 }).excessSlack,
    true,
  );
  assert.equal(
    evaluateCeilingHeadroom({ ceiling: 1_009, measured: 1_000 }).excessSlack,
    false,
  );

  // the suggestion always satisfies the rule it is suggesting
  for (const measured of [500, 1_000, 5_713, 29_378, 115_195]) {
    const { suggestedCeiling } = evaluateCeilingHeadroom({
      ceiling: measured * 2,
      measured,
    });
    const applied = evaluateCeilingHeadroom({
      ceiling: suggestedCeiling,
      measured,
    });
    assert.equal(
      applied.overBudget,
      false,
      `suggestion for ${String(measured)}`,
    );
    assert.equal(
      applied.excessSlack,
      false,
      `suggestion for ${String(measured)}`,
    );
  }

  assert.throws(
    () => evaluateCeilingHeadroom({ ceiling: 1.5, measured: 1_000 }),
    /integer ceiling and measured/iu,
  );
});

test("measures configured gzip and raw artifact axes with Size Limit parity", async () => {
  const verifier = await import("./verify-core-consumer-sizes-lib.mjs");
  assert.equal(typeof verifier.measureConfiguredArtifactSizes, "function");

  const bytes = Buffer.from("OpenCookie canonical bytes\n".repeat(64));
  const results = verifier.measureConfiguredArtifactSizes({
    artifactBytes: new Map([["dist/example.js", bytes]]),
    entries: [
      {
        gzip: true,
        limit: "10000 B",
        name: "gzip artifact",
        path: "dist/example.js",
      },
      {
        brotli: false,
        limit: "10000 B",
        name: "raw artifact",
        path: "dist/example.js",
      },
    ],
  });

  assert.deepEqual(results, [
    {
      limitBytes: 10_000,
      measuredBytes: gzipSync(bytes, { level: 9 }).length,
      name: "gzip artifact",
      path: "dist/example.js",
    },
    {
      limitBytes: 10_000,
      measuredBytes: bytes.length,
      name: "raw artifact",
      path: "dist/example.js",
    },
  ]);
});

test("the canonical live ratchet aggregates all artifact and graph violations", async () => {
  const verifier = await import("./verify-core-consumer-sizes-lib.mjs");
  assert.equal(typeof verifier.assertLiveSizeRatchet, "function");

  assert.throws(
    () =>
      verifier.assertLiveSizeRatchet({
        artifactResults: [
          {
            limitBytes: 1_010,
            measuredBytes: 1_000,
            name: "loose artifact",
          },
          {
            limitBytes: 2_000,
            measuredBytes: 2_000,
            name: "over-budget artifact",
          },
        ],
        graphResults: [
          {
            gzipBytes: 3_000,
            limitBytes: 3_030,
            name: "loose graph",
          },
        ],
        pinnedNodeVersion: "24.19.0",
        runningNodeVersion: "24.19.0",
      }),
    (error) => {
      assert.ok(error instanceof ConsumerGraphSizeError);
      assert.match(error.message, /loose artifact.*tighten it to 1009/iu);
      assert.match(error.message, /over-budget artifact.*2000.*2000/iu);
      assert.match(error.message, /loose graph.*tighten it to 3029/iu);
      return true;
    },
  );
});

test("excess-slack enforcement requires the exact canonical Node version", async () => {
  const verifier = await import("./verify-core-consumer-sizes-lib.mjs");
  assert.equal(typeof verifier.assertLiveSizeRatchet, "function");
  const input = {
    artifactResults: [
      {
        limitBytes: 1_010,
        measuredBytes: 1_000,
        name: "version-sensitive gzip artifact",
      },
    ],
    graphResults: [],
    pinnedNodeVersion: "24.19.0",
    runningNodeVersion: "24.19.1",
  };

  assert.deepEqual(verifier.assertLiveSizeRatchet(input), {
    axesChecked: 1,
    excessSlackCompared: false,
  });
  assert.throws(
    () =>
      verifier.assertLiveSizeRatchet({
        ...input,
        artifactResults: [
          {
            limitBytes: 1_000,
            measuredBytes: 1_000,
            name: "ambient over-budget artifact",
          },
        ],
      }),
    /ambient over-budget artifact.*1000.*1000/iu,
  );
});

test("the canonical size CLI applies the live ratchet to all configured axes", async () => {
  const verifier = readFileSync(
    new URL("./verify-core-consumer-sizes.mjs", import.meta.url),
    "utf8",
  );

  assert.match(verifier, /[.]size-limit[.]json/u);
  assert.match(verifier, /measureConfiguredArtifactSizes/u);
  assert.match(verifier, /assertLiveSizeRatchet/u);
  assert.match(verifier, /[.]node-version/u);
});

test("measures the programmatic route from a committed page that bootstraps OpenCookie", async () => {
  assert.deepEqual(
    programmaticRouteGraphs.map(({ entry, name }) => ({ entry, name })),
    [
      {
        entry: "scripts/size-fixtures/programmatic-route.mjs",
        name: "vanilla programmatic route",
      },
    ],
  );
  // A real call, so the bundler keeps what a page uses and nothing else.
  const page = readFileSync(
    new URL("./size-fixtures/programmatic-route.mjs", import.meta.url),
    "utf8",
  );
  assert.match(page, /bootstrapOpenCookieFromHead\(/u);
  assert.doesNotMatch(page, /import\s*\*/u);
  for (const used of [
    "VANILLA_COPY_DE",
    "declaredExceptions",
    "googleConsentMode",
    "policyDefinition",
  ]) {
    assert.ok(page.includes(used), `The page must use ${used}.`);
  }

  const calls = [];
  const results = await verifyProgrammaticRouteGraphs({
    bundle: ({ graph }) => {
      calls.push(graph.name);
      return Promise.resolve({
        code: "globalThis.page=1;",
        fileNames: ["page.js"],
      });
    },
  });
  assert.deepEqual(calls, ["vanilla programmatic route"]);
  assert.deepEqual(results, [
    {
      gzipBytes: gzipSync("globalThis.page=1;", { level: 9 }).byteLength,
      limitBytes: programmaticRouteGraphs[0].limitBytes,
      name: "vanilla programmatic route",
      rawBytes: 18,
      rawLimitBytes: programmaticRouteGraphs[0].rawLimitBytes,
    },
  ]);
});

test("rejects a programmatic route over its gzip or raw cap", async () => {
  let state = 17;
  const noisyCode = Array.from({ length: 200_000 }, () => {
    state = (state * 48_271) % 2_147_483_647;
    return String.fromCharCode(33 + (state % 90));
  }).join("");
  await assert.rejects(
    verifyProgrammaticRouteGraphs({
      bundle: () =>
        Promise.resolve({ code: noisyCode, fileNames: ["page.js"] }),
    }),
    /exceeds its \d+ byte gzip cap/u,
  );

  // Code that compresses well can pass gzip and still exceed raw.
  await assert.rejects(
    verifyProgrammaticRouteGraphs({
      bundle: () =>
        Promise.resolve({
          code: `globalThis.page="${"a".repeat(200_000)}";`,
          fileNames: ["page.js"],
        }),
    }),
    /exceeds its \d+ byte raw cap/u,
  );
});

test("rejects a programmatic route bundle that is not self-contained", async () => {
  await assert.rejects(
    verifyProgrammaticRouteGraphs({
      bundle: () =>
        Promise.resolve({
          code: 'import "@opencookie-dev/core";',
          fileNames: ["page.js"],
        }),
    }),
    (error) => {
      assert.ok(error instanceof ConsumerGraphSizeError);
      assert.match(error.message, /self-contained without unresolved imports/u);
      return true;
    },
  );
});

test("the canonical size CLI reports the programmatic route", () => {
  const verifier = readFileSync(
    new URL("./verify-core-consumer-sizes.mjs", import.meta.url),
    "utf8",
  );

  assert.match(verifier, /verifyProgrammaticRouteGraphs/u);
  assert.match(verifier, /packages\/adapters\/vanilla\/dist/u);
  // Its caps are in the live ratchet with every other axis.
  assert.match(verifier, /routeAxes/u);
});
