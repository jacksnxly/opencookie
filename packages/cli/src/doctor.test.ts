import { describe, expect, it } from "vitest";

import { runDoctor, runPolicyCommand, type FileSystemPort } from "./index.js";
import { PathOutsideProjectError } from "./project-paths.js";

const STORE = "opencookie/policy-publications.json";
const DECLARATION = "opencookie/cookie-declaration.json";
const FINDINGS = "opencookie/findings.json";

interface Harness {
  readonly files: Map<string, string>;
  readonly lines: string[];
  readonly ports: {
    readonly fileSystem: FileSystemPort;
    readonly writeLine: (line: string) => void;
  };
}

function harness(initial: Readonly<Record<string, string>> = {}): Harness {
  const files = new Map<string, string>(Object.entries(initial));
  const lines: string[] = [];
  return {
    files,
    lines,
    ports: {
      fileSystem: {
        exists: (path) => Promise.resolve(files.has(path)),
        mkdir: () => Promise.resolve(),
        readFile: (path) => {
          const value = files.get(path);
          if (value === undefined) throw new Error(`Missing file: ${path}`);
          return Promise.resolve(value);
        },
        replaceFile: (path, previous, content) => {
          if (files.get(path) !== previous) {
            throw new Error(`Stale replace of ${path}`);
          }
          files.set(path, content);
          return Promise.resolve();
        },
        withLock: (_path, operation) => operation(),
        writeFile: (path, content) => {
          if (files.has(path)) throw new Error(`EEXIST: ${path}`);
          files.set(path, content);
          return Promise.resolve();
        },
      },
      writeLine: (line) => lines.push(line),
    },
  };
}

function findingsDocument(classified: number, unclassified: number): string {
  const findings = [];
  for (let index = 0; index < classified; index += 1) {
    findings.push({
      classification: "classified",
      decision: {
        decidedAt: "2026-09-21T12:00:00.000Z",
        necessary: false,
        purposeId: "analytics",
      },
      kind: "cookie",
      name: `classified-${String(index)}`,
      observations: [],
      uncertainty: "observed",
    });
  }
  for (let index = 0; index < unclassified; index += 1) {
    findings.push({
      classification: "unclassified",
      kind: "cookie",
      name: `unclassified-${String(index)}`,
      observations: [],
      uncertainty: "observed",
    });
  }
  return JSON.stringify({ findings });
}

// @covers PP-30 REQ-DIAGNOSTIC-DX / TEST-DX-DOCTOR: setup problems are reported
// with stable reason codes instead of being silently suppressed.
describe("opencookie doctor", () => {
  it("reports a reason code when no policy is published", async () => {
    const test = harness();

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "no-policy-published",
    );
  });

  it("reports an unreadable store as its own reason code", async () => {
    const test = harness({ [STORE]: "{not json" });

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "publication-history-unreadable",
    );
  });

  it("treats unclassified findings as advice, not failure", async () => {
    const test = harness({ [FINDINGS]: findingsDocument(1, 2) });

    const result = await runDoctor(test.ports);

    const advice = result.diagnostics.filter(
      ({ code }) => code === "findings-unclassified",
    );
    expect(advice).toHaveLength(1);
    expect(advice[0]?.severity).toBe("advice");
  });

  // `findings check` treats a resource as decided when a decision covers it by
  // its exact name, by the same origin and path, or through the decision's
  // declared pattern. doctor must count the same way, or it calls resources
  // unclassified that the check already applies a decision to.
  it("counts a finding a decision already covers as classified", async () => {
    const decided = {
      classification: "classified",
      decision: {
        decidedAt: "2026-09-21T12:00:00.000Z",
        matchPattern: "https://cdn.example.test/include/*/loader.js",
        necessary: false,
        purposeId: "analytics",
      },
      kind: "script",
      name: "https://cdn.example.test/include/v1/loader.js",
      observations: [],
      uncertainty: "observed",
    };
    const unclassified = (kind: string, name: string) => ({
      classification: "unclassified",
      kind,
      name,
      observations: [],
      uncertainty: "observed",
    });
    const test = harness({
      [FINDINGS]: JSON.stringify({
        findings: [
          decided,
          unclassified(
            "script",
            "https://cdn.example.test/include/v2/loader.js",
          ),
          unclassified(
            "script",
            "https://cdn.example.test/include/v1/loader.js?cb=7",
          ),
          unclassified("script", "https://other.example.test/tag.js"),
        ],
      }),
    });

    const result = await runDoctor(test.ports);

    const advice = result.diagnostics.find(
      ({ code }) => code === "findings-unclassified",
    );
    expect(advice?.detail).toMatch(/^1 of 4 findings are still unclassified/u);
  });

  // install writes wherever --out says, so doctor must look where install
  // wrote, not only at the default module path.
  describe("a policy installed with --out", () => {
    const publish = async (test: Harness, id: string, version: string) => {
      test.files.set("policy.json", policyDocument(version));
      const published = await runPolicyCommand(test.ports, [
        "publish",
        "--id",
        id,
        "--policy",
        "policy.json",
      ]);
      if (!published.ok) throw new Error(published.message);
    };
    const install = async (test: Harness, out: string) => {
      const installed = await runPolicyCommand(test.ports, [
        "install",
        "--out",
        out,
      ]);
      if (!installed.ok) throw new Error(installed.message);
    };
    const codes = async (test: Harness) =>
      (await runDoctor(test.ports)).diagnostics.map(({ code }) => code);

    it("is found as JSON and reported current", async () => {
      const test = harness();
      await publish(test, "pub-1", "1.0.0");
      await install(test, "src/policy.json");

      const found = await codes(test);

      expect(found).not.toContain("policy-not-installed");
      expect(found).not.toContain("installed-policy-stale");
    });

    it("is reported stale as JSON once a newer policy is live", async () => {
      const test = harness();
      await publish(test, "pub-1", "1.0.0");
      await install(test, "src/policy.json");
      await publish(test, "pub-2", "2.0.0");

      const result = await runDoctor(test.ports);

      const stale = result.diagnostics.find(
        ({ code }) => code === "installed-policy-stale",
      );
      expect(stale?.detail).toContain("src/policy.json");
      expect(stale?.severity).toBe("problem");
    });

    it("is found as a module outside the default path", async () => {
      const test = harness();
      await publish(test, "pub-1", "1.0.0");
      await install(test, "lib/opencookie.policy.ts");

      expect(await codes(test)).not.toContain("policy-not-installed");
    });
  });

  it("names every diagnostic with a stable code and a severity", async () => {
    const test = harness({ [STORE]: "{not json" });

    const result = await runDoctor(test.ports);

    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code).toMatch(/^[a-z][a-z-]+$/u);
      expect(["advice", "problem"]).toContain(diagnostic.severity);
      expect(diagnostic.detail.length).toBeGreaterThan(0);
    }
    expect(test.lines.join("\n")).toContain("publication-history-unreadable");
  });

  it("advises when a published policy would show bare identifiers", async () => {
    const test = harness({ "policy.json": policyDocument("1.0.0") });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);

    const result = await runDoctor(test.ports);

    const advisory = result.diagnostics.find(
      ({ code }) => code === "declaration-without-plain-language",
    );
    expect(advisory?.severity).toBe("advice");
  });

  it("reports a declaration that does not match the live publication", async () => {
    const test = harness({
      [DECLARATION]: JSON.stringify({ publicationId: "old" }),
    });

    const result = await runDoctor(test.ports);

    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "declaration-not-current",
    );
  });
});

function policyDocument(version: string): string {
  return JSON.stringify({
    catalogueRevision: `catalogue-${version}`,
    policy: {
      dataCategories: [{ id: "usage-data" }],
      operations: [{ id: "processing" }],
      providers: [{ id: "site-operator" }],
      purposes: [
        {
          dataCategoryIds: ["usage-data"],
          disclosure: `Measures usage ${version}.`,
          id: "analytics",
          operationIds: ["processing"],
          providerIds: ["site-operator"],
          recipientIds: ["site-operator"],
          retentionIds: ["thirteen-months"],
        },
      ],
      recipients: [{ id: "site-operator" }],
      retentions: [{ id: "thirteen-months" }],
    },
    policyVersion: version,
  });
}

// Pass B's minor 2 on 0.2.0: 0.2.0 wrote consent evidence into a plain-HTML
// site's own directory, which the site serves. A store already there is
// public until it is moved, so the doctor must say so.
describe("consent evidence in a served directory", () => {
  it("reports an evidence store inside a plain-HTML web root", async () => {
    const test = harness({
      "index.html":
        '<script src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.2.0/dist/auto.iife.js"></script>',
      "opencookie/consent-evidence.json": "{}",
    });

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(false);
    const exposed = result.diagnostics.find(
      ({ code }) => code === "evidence-in-web-root",
    );
    expect(exposed?.severity).toBe("problem");
    expect(exposed?.detail).toContain("opencookie/consent-evidence.json");
  });
});

describe("opencookie doctor over a real publication lifecycle", () => {
  it("advises generating a declaration once a policy is published", async () => {
    const test = harness({ "policy.json": policyDocument("1.0.0") });
    const published = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);
    expect(published.ok).toBe(true);

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "declaration-not-generated",
    );
  });

  it("reports no problem once the declaration matches the publication", async () => {
    const test = harness({ "policy.json": policyDocument("1.0.0") });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);
    await runPolicyCommand(test.ports, ["declaration"]);

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(true);
    expect(
      result.diagnostics.filter(({ severity }) => severity === "problem"),
    ).toHaveLength(0);
  });

  it("detects the declaration going stale when a newer policy is published", async () => {
    const test = harness({ "policy.json": policyDocument("1.0.0") });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);
    await runPolicyCommand(test.ports, ["declaration"]);
    test.files.set("policy.json", policyDocument("2.0.0"));
    const republished = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-2",
      "--policy",
      "policy.json",
    ]);
    expect(republished.ok).toBe(true);

    const stale = await runDoctor(test.ports);

    expect(stale.ok).toBe(false);
    expect(stale.diagnostics.map(({ code }) => code)).toContain(
      "declaration-not-current",
    );

    await runPolicyCommand(test.ports, ["declaration"]);
    const regenerated = await runDoctor(test.ports);

    expect(regenerated.ok).toBe(true);
    expect(regenerated.diagnostics.map(({ code }) => code)).not.toContain(
      "declaration-not-current",
    );
  });
});

describe("what the project actually enforces", () => {
  const publish = async (
    test: Harness,
    id: string,
    version: string,
  ): Promise<void> => {
    test.files.set("policy.json", policyDocument(version));
    const published = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      id,
      "--policy",
      "policy.json",
    ]);
    if (!published.ok) throw new Error("fixture publish must succeed");
  };

  // The runtime enforces the policy module in the project, not the publication
  // history. If a newer policy is published and never installed, visitors keep
  // deciding against the old one while the history says otherwise.
  it("reports an installed policy older than the live publication", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    await runPolicyCommand(test.ports, ["install"]);
    await publish(test, "pub-2", "2.0.0");

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(false);
    const stale = result.diagnostics.find(
      ({ code }) => code === "installed-policy-stale",
    );
    expect(stale?.severity).toBe("problem");
    expect(stale?.detail).toContain("2.0.0");
    expect(stale?.detail).toContain("1.0.0");
  });

  // The module writes the version as a JSON string, so a quote is escaped and
  // a line separator stays raw. Reading it back must give the same version.
  it.each(['1.0.0"beta', "1.0.0\u2028beta"])(
    "reads an installed version back exactly: %j",
    async (version) => {
      const test = harness();
      await publish(test, "pub-1", version);
      await runPolicyCommand(test.ports, ["install"]);

      const result = await runDoctor(test.ports);

      expect(result.diagnostics.map(({ code }) => code)).not.toContain(
        "installed-policy-stale",
      );
    },
  );

  // Pass B's M-E on 0.2.0: doctor compared versions only, so a module whose
  // policy differed from the live one at the same version passed as current.
  it("reports an installed policy that differs from the live one at the same version", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    await runPolicyCommand(test.ports, ["install"]);
    const installed = [...test.files.keys()].find((path) =>
      path.endsWith("opencookie.policy.ts"),
    );
    if (installed === undefined) throw new Error("install must write a module");
    test.files.set(
      installed,
      (test.files.get(installed) ?? "").replace(
        "Measures usage 1.0.0.",
        "Measures usage and advertising 1.0.0.",
      ),
    );

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(false);
    const stale = result.diagnostics.find(
      ({ code }) => code === "installed-policy-stale",
    );
    expect(stale?.detail).toContain("pub-1");
  });

  it("is satisfied once the published policy is installed", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    await runPolicyCommand(test.ports, ["install"]);

    const result = await runDoctor(test.ports);

    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      "installed-policy-stale",
    );
  });

  it("advises installing a published policy the project never installed", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");

    const result = await runDoctor(test.ports);

    const advice = result.diagnostics.find(
      ({ code }) => code === "policy-not-installed",
    );
    expect(advice?.severity).toBe("advice");
  });

  // The generated configuration binds resources to purposes by id, and throws
  // when the application imports it against a policy without one of them.
  it("reports a configuration that binds a purpose the live publication lacks", async () => {
    const test = harness({
      "opencookie.config.ts": [
        "const resourceResult = defineResourcePolicy({",
        "  policy: openCookiePolicy,",
        '  resources: [{ access: "optional", id: "demo", purposeIds: ["analytics"], serviceId: "demo" }],',
        '  services: [{ id: "demo" }],',
        "});",
      ].join("\n"),
    });
    test.files.set(
      "policy.json",
      policyDocument("1.0.0").replaceAll('"analytics"', '"statistics"'),
    );
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(false);
    const unbound = result.diagnostics.find(
      ({ code }) => code === "configuration-purpose-undeclared",
    );
    expect(unbound?.severity).toBe("problem");
    expect(unbound?.detail).toContain("opencookie.config.ts");
    expect(unbound?.detail).toContain("analytics");
  });

  // The drop-in on a plain-HTML page enforces its data-oc-* attributes, not a
  // published policy, so a publication there is never what visitors decide on.
  it("reports that a plain-HTML page does not enforce the live publication", async () => {
    const test = harness({
      ".opencookie-init.json": JSON.stringify({ framework: "plain-html" }),
      "index.html":
        '<script defer src="/vendor/opencookie/auto.iife.js" data-oc-policy-version="policy-1"></script>',
      // Written by an earlier CLI, and loaded by nothing on this page.
      "opencookie.policy.ts": 'export const policyVersion = "1.0.0";\n',
    });
    await publish(test, "pub-1", "1.0.0");

    const result = await runDoctor(test.ports);

    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map(({ code }) => code);
    expect(codes).not.toContain("policy-not-installed");
    const unenforced = result.diagnostics.find(
      ({ code }) => code === "plain-html-policy-not-enforced",
    );
    expect(unenforced?.severity).toBe("problem");
    expect(unenforced?.detail).toContain("1.0.0");
    expect(unenforced?.detail).toContain("policy-1");
  });

  // With several sites, the default module holds one site's policy. For any
  // other site it is not a stale install of its own policy.
  it("does not report another site's module as this site's stale install", async () => {
    const test = harness({
      "opencookie.policy.ts": [
        "// Generated by opencookie policy install from publication blog-1 for site blog.",
        'export const policyVersion = "blog-v1";',
        "",
      ].join("\n"),
    });
    await publish(test, "pub-1", "1.0.0");

    const result = await runDoctor({ ...test.ports, site: "shop" });

    const codes = result.diagnostics.map(({ code }) => code);
    expect(codes).not.toContain("installed-policy-stale");
    const advice = result.diagnostics.find(
      ({ code }) => code === "policy-not-installed",
    );
    expect(advice?.severity).toBe("advice");
    expect(advice?.detail).toContain("blog");
  });

  it("says nothing about installation when nothing is published", async () => {
    const test = harness();

    const result = await runDoctor(test.ports);

    expect(result.diagnostics.map(({ code }) => code)).not.toContain(
      "policy-not-installed",
    );
  });
});

// A site that bundles its own integration with bootstrapOpenCookie() has no
// policy module for doctor to read. The bundle it ships carries the digests of
// the installed policy it was built from, so doctor --bundle compares those
// with the live publication. It says what a bundle carries; the runtime's own
// check, not doctor, is what refuses a policy that does not match.
describe("what a custom integration's bundle carries", () => {
  const BUNDLE = "dist/app.js";

  const publish = async (
    test: Harness,
    id: string,
    version: string,
  ): Promise<void> => {
    test.files.set("policy.json", policyDocument(version));
    const published = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      id,
      "--policy",
      "policy.json",
    ]);
    if (!published.ok) throw new Error("fixture publish must succeed");
  };

  /** The recorded digests of the publication at this place in the history. */
  const identity = (test: Harness, index: number): readonly string[] => {
    const stored = JSON.parse(test.files.get(STORE) ?? "{}") as {
      publications: {
        snapshot: { catalogueDigest: string; decisionSurfaceDigest: string };
      }[];
    };
    const snapshot = stored.publications[index]?.snapshot;
    if (snapshot === undefined) throw new Error("the publication must exist");
    return [snapshot.catalogueDigest, snapshot.decisionSurfaceDigest];
  };

  /** A minified bundle whose installed policy carries these digests. */
  const bundleCarrying = (...digests: readonly string[]): string =>
    `(()=>{const e={${digests.map((digest, index) => `d${String(index)}:\`${digest}\``).join(",")}};window.oc(e)})();\n`;

  const codes = (result: { diagnostics: readonly { code: string }[] }) =>
    result.diagnostics.map(({ code }) => code);

  it("reports a bundle carrying the live identity as current, and drops the install advice", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    test.files.set(BUNDLE, bundleCarrying(...identity(test, 0)));

    const result = await runDoctor(test.ports, { bundles: [BUNDLE] });

    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain("policy-not-installed");
    expect(codes(result)).not.toContain("bundle-policy-stale");
    expect(codes(result)).not.toContain("bundle-policy-unverified");
    const output = test.lines.join("\n");
    expect(output).toContain(
      `${BUNDLE} carries the identity of the live publication pub-1 (policy version 1.0.0).`,
    );
    expect(output).not.toMatch(/enforces/u);
  });

  it("mentions --bundle when advising installation without one", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");

    const result = await runDoctor(test.ports);

    const advice = result.diagnostics.find(
      ({ code }) => code === "policy-not-installed",
    );
    expect(advice?.detail).toContain("--bundle");
  });

  it("accepts older publications' digests alongside the live identity", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    await publish(test, "pub-2", "2.0.0");
    test.files.set(
      BUNDLE,
      bundleCarrying(...identity(test, 0), ...identity(test, 1)),
    );

    const result = await runDoctor(test.ports, { bundles: [BUNDLE] });

    expect(result.ok).toBe(true);
    expect(codes(result)).not.toContain("bundle-policy-stale");
    expect(test.lines.join("\n")).toContain("live publication pub-2");
  });

  it("reports a bundle carrying an older publication's identity as stale, naming both", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    await publish(test, "pub-2", "2.0.0");
    test.files.set(BUNDLE, bundleCarrying(...identity(test, 0)));

    const result = await runDoctor(test.ports, { bundles: [BUNDLE] });

    expect(result.ok).toBe(false);
    const stale = result.diagnostics.find(
      ({ code }) => code === "bundle-policy-stale",
    );
    expect(stale?.severity).toBe("problem");
    expect(stale?.detail).toContain(
      `${BUNDLE} carries the identity of publication pub-1 (policy version 1.0.0)`,
    );
    expect(stale?.detail).toContain("pub-2");
    expect(stale?.detail).not.toMatch(/enforces/u);
  });

  it("reports a bundle carrying only part of the live identity as stale", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    const [catalogueDigest = ""] = identity(test, 0);
    test.files.set(BUNDLE, bundleCarrying(catalogueDigest));

    const result = await runDoctor(test.ports, { bundles: [BUNDLE] });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("bundle-policy-stale");
  });

  // Core itself carries the digest prefix and pattern, so only a complete
  // digest counts as an identity.
  it("reports a bundle with no OpenCookie identity as unverified", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    test.files.set(
      BUNDLE,
      'const p="sha256-v1:",r=/^sha256-v1:[0-9a-f]{64}$/u;window.oc({policy:{}});\n',
    );

    const result = await runDoctor(test.ports, { bundles: [BUNDLE] });

    expect(result.ok).toBe(false);
    const unverified = result.diagnostics.find(
      ({ code }) => code === "bundle-policy-unverified",
    );
    expect(unverified?.severity).toBe("problem");
    expect(unverified?.detail).toContain(BUNDLE);
    expect(codes(result)).toContain("policy-not-installed");
  });

  it("checks every bundle it is given", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    test.files.set(BUNDLE, bundleCarrying(...identity(test, 0)));
    test.files.set("dist/vendor.js", "window.vendor=1;\n");

    const result = await runDoctor(test.ports, {
      bundles: [BUNDLE, "dist/vendor.js"],
    });

    const unverified = result.diagnostics.filter(
      ({ code }) => code === "bundle-policy-unverified",
    );
    expect(unverified).toHaveLength(1);
    expect(unverified[0]?.detail).toContain("dist/vendor.js");
    expect(codes(result)).not.toContain("policy-not-installed");
  });

  it("refuses a bundle outside the project in the CLI's own words", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");
    const ports = {
      ...test.ports,
      fileSystem: {
        ...test.ports.fileSystem,
        readFile: (path: string) =>
          path.startsWith("../")
            ? Promise.reject(new PathOutsideProjectError(path))
            : test.ports.fileSystem.readFile(path),
      },
    };

    const result = await runDoctor(ports, { bundles: ["../site/app.js"] });

    expect(result.ok).toBe(false);
    const refused = result.diagnostics.find(
      ({ code }) => code === "bundle-unreadable",
    );
    expect(refused?.severity).toBe("problem");
    expect(refused?.detail).toContain(
      "../site/app.js is outside the project, and the CLI reads files only inside it.",
    );
  });

  it("reports a bundle that is not there", async () => {
    const test = harness();
    await publish(test, "pub-1", "1.0.0");

    const result = await runDoctor(test.ports, { bundles: [BUNDLE] });

    expect(result.ok).toBe(false);
    const missing = result.diagnostics.find(
      ({ code }) => code === "bundle-unreadable",
    );
    expect(missing?.detail).toContain(`${BUNDLE} could not be read.`);
  });
});
