import {
  createPolicySnapshot,
  definePolicy,
  type PolicyDefinition,
} from "@opencookie-dev/core/domain";
import { describe, expect, it } from "vitest";

import { runPolicyCommand, type FileSystemPort } from "./index.js";

const STORE = "opencookie/policy-publications.json";
const POLICY_FILE = "policy.json";

function policyDocument(disclosure: string, version: string): string {
  return JSON.stringify({
    catalogueRevision: `catalogue-${version}`,
    policy: {
      dataCategories: [{ id: "usage-data" }],
      operations: [{ id: "processing" }],
      providers: [{ id: "site-operator" }],
      purposes: [
        {
          dataCategoryIds: ["usage-data"],
          disclosure,
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
        replaceFile: (path, expected, content) => {
          if (files.get(path) !== expected) {
            return Promise.reject(new Error(`Stale replace of ${path}`));
          }
          files.set(path, content);
          return Promise.resolve();
        },
        withLock: (_path, operation) => operation(),
        writeFile: (path, content) => {
          files.set(path, content);
          return Promise.resolve();
        },
      },
      writeLine: (line) => lines.push(line),
    },
  };
}

describe("policy command", () => {
  it("reports that nothing is published yet", async () => {
    const test = harness();

    const result = await runPolicyCommand(test.ports, ["status"]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toContain("No policy is published");
  });

  it("refuses an option it does not know rather than ignoring it", async () => {
    const test = harness();

    const result = await runPolicyCommand(test.ports, ["status", "--verbose"]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/--verbose/u);
  });

  it("publishes a policy document and reports it as current", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });

    const published = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
    const status = await runPolicyCommand(test.ports, ["status"]);

    expect(published.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(test.files.has(STORE)).toBe(true);
    expect(test.lines.join("\n")).toContain("pub-1");
  });

  // Pass B's M-E on 0.2.0: a changed policy published under the same version,
  // so visitors' stored decisions for the old one carried over without a new
  // prompt. A version names one policy; a change needs a new version.
  it("refuses a changed policy under the version already live", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
      "changed.json": policyDocument("Measure site use and ads", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);

    const changed = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-2",
      "--policy",
      "changed.json",
    ]);

    expect(changed.ok).toBe(false);
    expect(changed.message).toMatch(/version-one/u);
    expect(changed.message).toMatch(/new policy version/u);
  });

  it("rolls back to an earlier publication", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
      "second.json": policyDocument(
        "Measure site use and reach",
        "version-two",
      ),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-2",
      "--policy",
      "second.json",
    ]);

    const result = await runPolicyCommand(test.ports, [
      "rollback",
      "--id",
      "pub-3",
      "--to",
      "pub-1",
    ]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toContain("pub-3");
  });

  it("refuses to publish over a store that fails its integrity check", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
    const stored = test.files.get(STORE);
    if (stored === undefined) throw new Error("store must exist");
    test.files.set(STORE, stored.replace("Measure site use", "Widened"));
    const corrupted = test.files.get(STORE);

    const result = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-2",
      "--policy",
      POLICY_FILE,
    ]);

    expect(result.ok).toBe(false);
    expect(test.files.get(STORE)).toBe(corrupted);
  });

  it("rejects an unknown policy subcommand", async () => {
    const test = harness();

    const result = await runPolicyCommand(test.ports, ["destroy"]);

    expect(result.ok).toBe(false);
  });
});

describe("policy preview", () => {
  // A preview exists so an operator can see what visitors would be told before
  // anything is published, so it must never write.
  it("shows what a candidate would declare without publishing it", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });

    const result = await runPolicyCommand(test.ports, [
      "preview",
      "--policy",
      POLICY_FILE,
    ]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("version-one");
    expect(output).toContain("analytics");
    expect(output).toContain("Measure site use");
    expect(test.files.has(STORE)).toBe(false);
    expect([...test.files.keys()]).toEqual([POLICY_FILE]);
  });

  it("names what the candidate would add and remove", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
    test.files.set(
      "next.json",
      JSON.stringify({
        catalogueRevision: "catalogue-version-two",
        policy: {
          dataCategories: [{ id: "usage-data" }],
          operations: [{ id: "processing" }],
          providers: [{ id: "site-operator" }],
          purposes: [
            {
              dataCategoryIds: ["usage-data"],
              disclosure: "Remember what you chose.",
              id: "preferences",
              operationIds: ["processing"],
              providerIds: ["site-operator"],
              recipientIds: ["site-operator"],
              retentionIds: ["thirteen-months"],
            },
          ],
          recipients: [{ id: "site-operator" }],
          retentions: [{ id: "thirteen-months" }],
        },
        policyVersion: "version-two",
      }),
    );
    test.lines.length = 0;

    const result = await runPolicyCommand(test.ports, [
      "preview",
      "--policy",
      "next.json",
    ]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("pub-1");
    expect(output).toMatch(/adds\b[\s\S]*preferences/u);
    expect(output).toMatch(/removes\b[\s\S]*analytics/u);
  });

  it("says when a candidate would change nothing a visitor sees", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
    test.lines.length = 0;

    const result = await runPolicyCommand(test.ports, [
      "preview",
      "--policy",
      POLICY_FILE,
    ]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toMatch(/no change/iu);
  });

  it("refuses a candidate that is not a readable policy document", async () => {
    const test = harness({ [POLICY_FILE]: "{ not a policy" });

    const result = await runPolicyCommand(test.ports, [
      "preview",
      "--policy",
      POLICY_FILE,
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(POLICY_FILE);
  });

  it("requires the candidate to preview", async () => {
    const test = harness();

    const result = await runPolicyCommand(test.ports, ["preview"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("--policy");
  });

  // Rewording a disclosure changes what a visitor reads even though the purpose
  // keeps its identifier, so a preview that only compared identifiers would
  // report no change.
  it("names a purpose whose wording changed", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
    test.files.set(
      "reworded.json",
      policyDocument("Count visits to each page", "version-two"),
    );
    test.lines.length = 0;

    const result = await runPolicyCommand(test.ports, [
      "preview",
      "--policy",
      "reworded.json",
    ]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toMatch(/changes\b[\s\S]*analytics/u);
    expect(output).toContain("Count visits to each page");
  });
});

describe("policy install", () => {
  it("writes a policy module carrying exactly what was published", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);

    const result = await runPolicyCommand(test.ports, ["install"]);

    expect(result.ok).toBe(true);
    const module = test.files.get("opencookie.policy.ts");
    if (module === undefined) throw new Error("the module must be written");
    expect(module).toContain("pub-1");
    expect(module).toContain("definePolicy(");
    expect(module).toContain('export const policyVersion = "version-one"');
    expect(module).toContain(
      'export const catalogueRevision = "catalogue-version-one"',
    );
    expect(module).toContain("export const openCookiePolicy");
  });

  // The installed runtime must enforce the published policy itself, not a
  // retyped copy of it, so the embedded definition is compared with the store.
  it("embeds the published policy definition unchanged", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
    await runPolicyCommand(test.ports, ["install"]);

    const module = test.files.get("opencookie.policy.ts") ?? "";
    const start = module.indexOf("definePolicy(") + "definePolicy(".length;
    const embedded = module.slice(start, module.indexOf(");", start));
    const stored = JSON.parse(test.files.get(STORE) ?? "{}") as {
      publications: { snapshot: { policy: unknown } }[];
    };
    expect(JSON.parse(embedded)).toStrictEqual(
      stored.publications[0]?.snapshot.policy,
    );
  });

  it("refuses to install when no policy is published", async () => {
    const test = harness();

    const result = await runPolicyCommand(test.ports, ["install"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No policy is published");
    expect(test.files.has("opencookie.policy.ts")).toBe(false);
  });

  it("writes where the project keeps its policy module", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);

    await runPolicyCommand(test.ports, [
      "install",
      "--out",
      "src/opencookie.policy.ts",
    ]);

    expect(test.files.has("src/opencookie.policy.ts")).toBe(true);
  });
});

// The configuration init generates binds resources to purposes by id. A policy
// without one of them makes that configuration throw when the application
// imports it, so installing such a policy would take the whole site down.
describe("installing against the project's resource bindings", () => {
  const CONFIG = [
    "const resourceResult = defineResourcePolicy({",
    "  policy: openCookiePolicy,",
    "  resources: [",
    "    {",
    '      access: "optional",',
    '      id: "opencookie-demo-script",',
    '      purposeIds: ["analytics"],',
    '      serviceId: "opencookie-demo-service",',
    "    },",
    "  ],",
    '  services: [{ id: "opencookie-demo-service" }],',
    "});",
    "",
  ].join("\n");
  const INSTALLED =
    "// Generated by opencookie policy install from publication pub-0.\n";

  it("refuses a policy without a purpose the configuration binds, and keeps the installed one", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument(
        "Measure site use",
        "version-one",
      ).replaceAll('"analytics"', '"statistics"'),
      "opencookie.config.ts": CONFIG,
      "opencookie.policy.ts": INSTALLED,
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);

    const result = await runPolicyCommand(test.ports, ["install"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("opencookie.config.ts");
    expect(result.message).toContain("analytics");
    expect(test.files.get("opencookie.policy.ts")).toBe(INSTALLED);
  });

  it("installs a policy that declares every purpose the configuration binds", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
      "opencookie.config.ts": CONFIG,
      "opencookie.policy.ts": INSTALLED,
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);

    const result = await runPolicyCommand(test.ports, ["install"]);

    expect(result.ok).toBe(true);
    expect(test.files.get("opencookie.policy.ts")).toContain("pub-1");
  });
});

// A plain-HTML page runs the drop-in, which enforces the one purpose its
// data-oc-* attributes describe and never loads a policy module. Reporting an
// install there would say a policy is enforced when visitors never see it.
// Writing a generated file must not create stray directories or replace a file
// the project owns, such as its entrypoint or package manifest.
describe("where install and declaration write", () => {
  const published = async (test: Harness): Promise<void> => {
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
  };

  it("creates no directory for a file at the project root", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    const created: string[] = [];
    const ports = {
      ...test.ports,
      fileSystem: {
        ...test.ports.fileSystem,
        mkdir: (path: string) => {
          created.push(path);
          return Promise.resolve();
        },
      },
    };
    await published(test);

    await runPolicyCommand(ports, ["install"]);
    await runPolicyCommand(ports, ["declaration", "--out", "declaration.json"]);

    expect(created).not.toContain("opencookie.policy.t");
    expect(created).not.toContain("declaration.jso");
  });

  it("refuses to install over a file that is not a policy module", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
      "src/main.tsx": "render(<App />);\n",
    });
    await published(test);

    const result = await runPolicyCommand(test.ports, [
      "install",
      "--out",
      "src/main.tsx",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("src/main.tsx");
    expect(test.files.get("src/main.tsx")).toBe("render(<App />);\n");
  });

  it("refuses to write a declaration over a file that is not one", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
      "package.json": '{ "name": "site" }\n',
    });
    await published(test);

    const result = await runPolicyCommand(test.ports, [
      "declaration",
      "--out",
      "package.json",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("package.json");
    expect(test.files.get("package.json")).toBe('{ "name": "site" }\n');
  });

  it("replaces its own earlier policy module and declaration", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await published(test);
    await runPolicyCommand(test.ports, ["install"]);
    await runPolicyCommand(test.ports, ["declaration"]);

    const installed = await runPolicyCommand(test.ports, ["install"]);
    const declared = await runPolicyCommand(test.ports, ["declaration"]);

    expect(installed.ok).toBe(true);
    expect(declared.ok).toBe(true);
  });
});

// A project can manage several sites, but it has one policy module at the
// default path. Installing one site's policy over another's would silently
// change what the other site enforces.
describe("installing for one of several sites", () => {
  const publishedFor = async (test: Harness, site: string): Promise<void> => {
    await runPolicyCommand({ ...test.ports, site }, [
      "publish",
      "--id",
      `${site}-1`,
      "--policy",
      POLICY_FILE,
    ]);
  };

  it("records which site an installed module belongs to", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await publishedFor(test, "shop");

    const result = await runPolicyCommand({ ...test.ports, site: "shop" }, [
      "install",
    ]);

    expect(result.ok).toBe(true);
    expect(test.files.get("opencookie.policy.ts")).toContain("for site shop");
  });

  it("refuses to replace another site's module, and installs with --out", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await publishedFor(test, "shop");
    await runPolicyCommand({ ...test.ports, site: "shop" }, ["install"]);
    const shopModule = test.files.get("opencookie.policy.ts");

    const refused = await runPolicyCommand({ ...test.ports, site: "blog" }, [
      "install",
    ]);
    const elsewhere = await runPolicyCommand({ ...test.ports, site: "blog" }, [
      "install",
      "--out",
      "blog/opencookie.policy.ts",
    ]);

    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("shop");
    expect(refused.message).toContain("--out");
    expect(test.files.get("opencookie.policy.ts")).toBe(shopModule);
    expect(elsewhere.ok).toBe(true);
    expect(test.files.get("blog/opencookie.policy.ts")).toContain(
      "for site blog",
    );
  });
});

// A site that bundles its own integration with bootstrapOpenCookie() cannot
// import the TypeScript module. It reads a JSON document instead, whose
// recorded identity the bootstrap checks and doctor --bundle looks for.
describe("installing as JSON for a custom integration", () => {
  const OUT = "src/opencookie-policy.json";

  interface InstalledJson {
    readonly catalogueDigest?: unknown;
    readonly catalogueRevision?: unknown;
    readonly decisionSurfaceDigest?: unknown;
    readonly generatedBy?: unknown;
    readonly policy?: unknown;
    readonly policyVersion?: unknown;
    readonly publicationId?: unknown;
    readonly site?: unknown;
  }

  interface StoredSnapshot {
    readonly catalogueDigest: string;
    readonly catalogueRevision: string;
    readonly decisionSurfaceDigest: string;
    readonly policy: unknown;
    readonly policyVersion: string;
  }

  const publish = async (
    test: Harness,
    id: string,
    disclosure: string,
    version: string,
    site?: string,
  ): Promise<void> => {
    test.files.set(POLICY_FILE, policyDocument(disclosure, version));
    const published = await runPolicyCommand(
      site === undefined ? test.ports : { ...test.ports, site },
      ["publish", "--id", id, "--policy", POLICY_FILE],
    );
    if (!published.ok) throw new Error("fixture publish must succeed");
  };

  const storedSnapshot = (test: Harness, index: number): StoredSnapshot => {
    const stored = JSON.parse(test.files.get(STORE) ?? "{}") as {
      publications: { snapshot: StoredSnapshot }[];
    };
    const snapshot = stored.publications[index]?.snapshot;
    if (snapshot === undefined) throw new Error("the publication must exist");
    return snapshot;
  };

  const installedJson = (test: Harness, path = OUT): InstalledJson =>
    JSON.parse(test.files.get(path) ?? "null") as InstalledJson;

  it("writes the live publication and its recorded identity as JSON", async () => {
    const test = harness();
    await publish(test, "pub-1", "Measure site use", "version-one");

    const result = await runPolicyCommand(test.ports, [
      "install",
      "--out",
      OUT,
    ]);

    expect(result.ok).toBe(true);
    const snapshot = storedSnapshot(test, 0);
    const installed = installedJson(test);
    expect(installed).toStrictEqual({
      catalogueDigest: snapshot.catalogueDigest,
      catalogueRevision: "catalogue-version-one",
      decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
      generatedBy: "opencookie policy install",
      policy: snapshot.policy,
      policyVersion: "version-one",
      publicationId: "pub-1",
    });
    expect(snapshot.catalogueDigest).toMatch(/^sha256-v1:[0-9a-f]{64}$/u);
    expect(test.files.get(OUT)?.endsWith("}\n")).toBe(true);
    expect(test.lines.at(-1)).toContain(OUT);
  });

  // The runtime rebuilds the snapshot from `policy`. Only a document that core
  // accepts unchanged, and that derives the recorded digests, can pass its check.
  it("records a policy that core defines back to the recorded digests", async () => {
    const test = harness();
    await publish(test, "pub-1", "Measure site use", "version-one");
    await runPolicyCommand(test.ports, ["install", "--out", OUT]);

    const installed = installedJson(test);
    const defined = definePolicy(installed.policy as PolicyDefinition);
    if (!defined.ok) throw new Error("the installed policy must be valid");
    const rebuilt = createPolicySnapshot({
      catalogueRevision: String(installed.catalogueRevision),
      policy: defined.policy,
      policyVersion: String(installed.policyVersion),
    });

    expect(rebuilt.catalogueDigest).toBe(installed.catalogueDigest);
    expect(rebuilt.decisionSurfaceDigest).toBe(installed.decisionSurfaceDigest);
  });

  it("replaces its own earlier JSON with the newer live publication", async () => {
    const test = harness();
    await publish(test, "pub-1", "Measure site use", "version-one");
    await runPolicyCommand(test.ports, ["install", "--out", OUT]);
    await publish(test, "pub-2", "Measure site use and errors", "version-two");

    const result = await runPolicyCommand(test.ports, [
      "install",
      "--out",
      OUT,
    ]);

    expect(result.ok).toBe(true);
    const installed = installedJson(test);
    expect(installed.publicationId).toBe("pub-2");
    expect(installed.policyVersion).toBe("version-two");
    expect(installed.catalogueDigest).toBe(
      storedSnapshot(test, 1).catalogueDigest,
    );
  });

  // A manifest can quote the command in a script. Naming it does not make the
  // file OpenCookie's, so it must never be overwritten.
  it("refuses to replace a JSON file it did not write, even one naming the command", async () => {
    const foreign = `${JSON.stringify({
      scripts: { policy: `opencookie policy install --out ${OUT}` },
    })}\n`;
    const test = harness({ [OUT]: foreign });
    await publish(test, "pub-1", "Measure site use", "version-one");

    const result = await runPolicyCommand(test.ports, [
      "install",
      "--out",
      OUT,
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(OUT);
    expect(result.message).toContain("--out");
    expect(test.files.get(OUT)).toBe(foreign);
  });

  it("records the site it belongs to, and never replaces another site's", async () => {
    const test = harness();
    await publish(test, "shop-1", "Measure site use", "version-one", "shop");
    await runPolicyCommand({ ...test.ports, site: "shop" }, [
      "install",
      "--out",
      OUT,
    ]);
    const shopJson = test.files.get(OUT);
    // This harness keeps one history, so the other site's policy is published
    // over it; the module's owner is what the refusal must read.
    await publish(test, "blog-1", "Measure reading", "version-two", "blog");

    const refused = await runPolicyCommand({ ...test.ports, site: "blog" }, [
      "install",
      "--out",
      OUT,
    ]);

    expect(installedJson(test).site).toBe("shop");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("shop");
    expect(test.files.get(OUT)).toBe(shopJson);
  });
});

describe("installing on a plain-HTML page", () => {
  const PAGE =
    '<script defer src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.1.0/dist/auto.iife.js" data-oc-policy-version="policy-1"></script>';

  it("refuses and writes nothing, saying what the page still enforces", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "1.0.0"),
      ".opencookie-init.json": JSON.stringify({ framework: "plain-html" }),
      "index.html": PAGE,
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);

    const result = await runPolicyCommand(test.ports, ["install"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("plain-HTML");
    expect(result.message).toContain("policy-1");
    expect(test.files.has("opencookie.policy.ts")).toBe(false);
    expect(test.files.get("index.html")).toBe(PAGE);
  });

  it("recognises a plain-HTML page set up without init", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "1.0.0"),
      "index.html": PAGE,
    });
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);

    const result = await runPolicyCommand(test.ports, ["install"]);

    expect(result.ok).toBe(false);
    expect(test.files.has("opencookie.policy.ts")).toBe(false);
  });
});

describe("installing over a project's own settings", () => {
  const published = async (test: Harness): Promise<void> => {
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      POLICY_FILE,
    ]);
  };

  // The generated config imports consentDurationMs from this module, so an
  // install that dropped it would leave the project unable to build, and one
  // that reset it would silently shorten or lengthen every visitor's consent.
  it("keeps the consent duration the project already set", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
      "opencookie.policy.ts": [
        'import { definePolicy } from "@opencookie-dev/core";',
        "",
        "export const consentDurationMs = 30 * 24 * 60 * 60 * 1000;",
        "",
      ].join("\n"),
    });
    await published(test);

    await runPolicyCommand(test.ports, ["install"]);

    const module = test.files.get("opencookie.policy.ts") ?? "";
    expect(module).toContain(
      "export const consentDurationMs = 30 * 24 * 60 * 60 * 1000;",
    );
  });

  it("supplies a consent duration when the project has none yet", async () => {
    const test = harness({
      [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
    });
    await published(test);

    await runPolicyCommand(test.ports, ["install"]);

    const module = test.files.get("opencookie.policy.ts") ?? "";
    expect(module).toMatch(/export const consentDurationMs = .+;/u);
  });
});

describe("policy starter", () => {
  // Item 7 asks a stranger to publish a working policy in three commands. A
  // starter that publishing then refuses would make that impossible, so the
  // test publishes exactly what the command wrote.
  it("writes a document that publishing accepts", async () => {
    const test = harness();

    const written = await runPolicyCommand(test.ports, ["starter"]);
    const published = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "opencookie/policy.json",
    ]);
    const status = await runPolicyCommand(test.ports, ["status"]);

    expect(written.ok).toBe(true);
    expect(published.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(test.lines.join("\n")).toContain("pub-1");
  });

  // A starter whose purposes show catalogue identifiers would put those in
  // front of visitors, which is what doctor reports as a defect.
  it("declares plain-language terms for every purpose", async () => {
    const test = harness();
    await runPolicyCommand(test.ports, ["starter"]);

    const document = JSON.parse(
      test.files.get("opencookie/policy.json") ?? "{}",
    ) as {
      policy: {
        purposes: {
          dataCategoryIds: string[];
          id: string;
          retentionIds: string[];
        }[];
      };
      terms?: Record<string, { label?: string }>;
    };

    expect(document.policy.purposes.length).toBeGreaterThanOrEqual(2);
    // Every identifier a declaration shows a visitor needs plain language, not
    // only the purposes themselves.
    for (const purpose of document.policy.purposes) {
      for (const id of [
        purpose.id,
        ...purpose.dataCategoryIds,
        ...purpose.retentionIds,
      ]) {
        expect(document.terms?.[id]?.label).toBeTruthy();
      }
    }
  });

  it("names a necessary purpose and an optional one", async () => {
    const test = harness();
    await runPolicyCommand(test.ports, ["starter"]);

    const document = JSON.parse(
      test.files.get("opencookie/policy.json") ?? "{}",
    ) as { policy: { categories: { id: string; purposeIds: string[] }[] } };

    const categories = document.policy.categories.map(({ id }) => id);
    expect(categories).toContain("necessary");
    expect(categories).toContain("optional");
  });

  it("never overwrites a policy document that is already there", async () => {
    const test = harness({ "opencookie/policy.json": "{ mine }" });

    const result = await runPolicyCommand(test.ports, ["starter"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("opencookie/policy.json");
    expect(test.files.get("opencookie/policy.json")).toBe("{ mine }");
  });

  it("writes where the operator asks", async () => {
    const test = harness();

    await runPolicyCommand(test.ports, ["starter", "--out", "draft/site.json"]);

    expect(test.files.has("draft/site.json")).toBe(true);
  });
});
