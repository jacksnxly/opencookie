import { describe, expect, it } from "vitest";

import {
  EVIDENCE_STORE_PATH,
  openSite,
  runEvidenceCommand,
  selectSite,
  runSitesCommand,
  SITE_REGISTRY_PATH,
  type FileSystemPort,
} from "./index.js";

function harness(initial: Readonly<Record<string, string>> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const directories: string[] = [];
  const locks: string[] = [];
  const lines: string[] = [];
  const fileSystem: FileSystemPort = {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: (path) => {
      directories.push(path);
      return Promise.resolve();
    },
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing file: ${path}`);
      return Promise.resolve(value);
    },
    replaceFile: (path, previous, content) => {
      if (files.get(path) !== previous)
        throw new Error(`Stale replace of ${path}`);
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (path, operation) => {
      locks.push(path);
      return operation();
    },
    writeFile: (path, content) => {
      if (files.has(path)) throw new Error(`EEXIST: ${path}`);
      files.set(path, content);
      return Promise.resolve();
    },
  };
  const ports = {
    fileSystem,
    writeLine: (line: string) => {
      lines.push(line);
    },
  };
  return { directories, files, fileSystem, lines, locks, ports };
}

const RECEIPT = {
  catalogueDigest: "sha256-catalogue",
  consentId: "visitor-1",
  decidedAt: 1_000,
  decisionSurfaceDigest: "sha256-surface",
  decisions: [{ decision: "granted", purposeId: "analytics" }],
  idempotencyKey: "key-1",
  method: "accept-all",
  occurredAt: 1_000,
  persistenceStatus: "confirmed",
  policyVersion: "1.0.0",
  revision: 1,
  schemaVersion: 2,
  transitionId: "transition-1",
};

async function withSites(
  sites: readonly (readonly [string, ...string[]])[],
): Promise<ReturnType<typeof harness>> {
  const context = harness();
  for (const [name, ...domains] of sites) {
    const args = ["add", "--name", name];
    for (const domain of domains) args.push("--domain", domain);
    const result = await runSitesCommand(context.ports, args);
    if (!result.ok) throw new Error(result.message);
  }
  return context;
}

describe("opencookie sites", () => {
  it("registers a site and reports where its data will live", async () => {
    const context = harness();
    const result = await runSitesCommand(context.ports, [
      "add",
      "--name",
      "shop",
      "--domain",
      "shop.example.test",
      "--domain",
      "www.shop.example.test",
    ]);

    expect(result.ok).toBe(true);
    const stored = JSON.parse(context.files.get(SITE_REGISTRY_PATH) ?? "") as {
      sites: unknown;
    };
    expect(stored.sites).toEqual([
      { domains: ["shop.example.test", "www.shop.example.test"], name: "shop" },
    ]);
    expect(context.lines.join("\n")).toContain("opencookie/sites/shop");
  });

  it("refuses an option it does not know rather than ignoring it", async () => {
    const context = harness();

    const result = await runSitesCommand(context.ports, [
      "add",
      "--name",
      "shop",
      "--domains",
      "shop.example.test",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/--domains/u);
  });

  it("lists every registered site with its domains", async () => {
    const context = await withSites([
      ["shop", "shop.example.test"],
      ["blog", "blog.example.test"],
    ]);
    context.lines.length = 0;

    const result = await runSitesCommand(context.ports, ["list"]);

    expect(result.ok).toBe(true);
    const output = context.lines.join("\n");
    expect(output).toContain("shop");
    expect(output).toContain("shop.example.test");
    expect(output).toContain("blog");
    expect(output).toContain("blog.example.test");
  });

  it("says so when no site is registered", async () => {
    const context = harness();
    const result = await runSitesCommand(context.ports, ["list"]);
    expect(result.ok).toBe(true);
    expect(context.lines.join("\n")).toMatch(/no sites/iu);
  });

  it("refuses a domain another site owns and leaves the registry unchanged", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);
    const before = context.files.get(SITE_REGISTRY_PATH);

    const result = await runSitesCommand(context.ports, [
      "add",
      "--name",
      "shop-eu",
      "--domain",
      "shop.example.test",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("shop.example.test");
    expect(result.message).toContain("shop");
    expect(context.files.get(SITE_REGISTRY_PATH)).toBe(before);
  });

  it("requires a domain", async () => {
    const context = harness();
    const result = await runSitesCommand(context.ports, [
      "add",
      "--name",
      "shop",
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/--domain/u);
    expect(context.files.has(SITE_REGISTRY_PATH)).toBe(false);
  });

  it("refuses to change a registry that fails validation", async () => {
    const clashing = JSON.stringify({
      sites: [
        { domains: ["shop.example.test"], name: "shop" },
        { domains: ["shop.example.test"], name: "blog" },
      ],
      version: 1,
    });
    const context = harness({ [SITE_REGISTRY_PATH]: clashing });

    const result = await runSitesCommand(context.ports, [
      "add",
      "--name",
      "news",
      "--domain",
      "news.example.test",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(SITE_REGISTRY_PATH);
    expect(context.files.get(SITE_REGISTRY_PATH)).toBe(clashing);
  });

  it("names the unknown subcommand", async () => {
    const context = harness();
    const result = await runSitesCommand(context.ports, ["rename"]);
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Unknown sites command: rename");
  });
});

describe("working on one site", () => {
  it("keeps each site's data in its own directory", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);
    const opened = await openSite(context.fileSystem, "shop");
    if (!opened.ok) throw new Error(opened.message);

    await opened.fileSystem.mkdir("opencookie");
    await opened.fileSystem.writeFile(EVIDENCE_STORE_PATH, "{}");
    await opened.fileSystem.withLock(EVIDENCE_STORE_PATH, () =>
      Promise.resolve(),
    );

    expect(
      context.files.has("opencookie/sites/shop/consent-evidence.json"),
    ).toBe(true);
    expect(context.files.has(EVIDENCE_STORE_PATH)).toBe(false);
    expect(context.directories).toContain("opencookie/sites/shop");
    expect(context.locks).toContain(
      "opencookie/sites/shop/consent-evidence.json",
    );
  });

  // Files an operator passes by path, such as receipts to ingest, are theirs,
  // not the site's, so they are still read from where the operator named them.
  it("reads the operator's own files from the project, not the site", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);
    context.files.set("exports/receipts.json", "[]");
    const opened = await openSite(context.fileSystem, "shop");
    if (!opened.ok) throw new Error(opened.message);

    expect(await opened.fileSystem.readFile("exports/receipts.json")).toBe(
      "[]",
    );
  });

  it("refuses a site that is not registered and names the registered ones", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);
    const opened = await openSite(context.fileSystem, "blog");
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.message).toContain("blog");
    expect(opened.message).toContain("shop");
  });

  it("never lets evidence recorded for one site appear on another", async () => {
    const context = await withSites([
      ["shop", "shop.example.test"],
      ["blog", "blog.example.test"],
    ]);
    context.files.set("receipts.json", JSON.stringify([RECEIPT]));
    const shop = await openSite(context.fileSystem, "shop");
    const blog = await openSite(context.fileSystem, "blog");
    if (!shop.ok || !blog.ok) throw new Error("fixture sites must open");

    const ingested = await runEvidenceCommand(
      { fileSystem: shop.fileSystem, now: () => 10_000, writeLine: () => {} },
      ["ingest", "--from", "receipts.json"],
    );
    expect(ingested.ok).toBe(true);

    const blogLines: string[] = [];
    await runEvidenceCommand(
      {
        fileSystem: blog.fileSystem,
        now: () => 10_000,
        writeLine: (line) => blogLines.push(line),
      },
      ["query"],
    );
    const shopLines: string[] = [];
    await runEvidenceCommand(
      {
        fileSystem: shop.fileSystem,
        now: () => 10_000,
        writeLine: (line) => shopLines.push(line),
      },
      ["query"],
    );

    expect(shopLines.join("\n")).toContain("visitor-1");
    expect(blogLines.join("\n")).not.toContain("visitor-1");
  });
});

describe("choosing the site a command works on", () => {
  it("leaves a single-site project's commands on its own data", async () => {
    const context = harness();
    const selected = await selectSite(context.fileSystem, ["query"]);
    if (!selected.ok) throw new Error(selected.message);

    expect(selected.site).toBeUndefined();
    expect(selected.args).toEqual(["query"]);
    await selected.fileSystem.writeFile(EVIDENCE_STORE_PATH, "{}");
    expect(context.files.has(EVIDENCE_STORE_PATH)).toBe(true);
  });

  it("routes a command with --site to that site and removes the flag", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);
    const selected = await selectSite(context.fileSystem, [
      "query",
      "--site",
      "shop",
      "--consent-id",
      "visitor-1",
    ]);
    if (!selected.ok) throw new Error(selected.message);

    expect(selected.site?.name).toBe("shop");
    expect(selected.args).toEqual(["query", "--consent-id", "visitor-1"]);
    await selected.fileSystem.writeFile(EVIDENCE_STORE_PATH, "{}");
    expect(
      context.files.has("opencookie/sites/shop/consent-evidence.json"),
    ).toBe(true);
  });

  // Once a project manages sites, data written without naming one would belong
  // to no site, and a later query for any site would silently miss it.
  it("requires --site once the project manages sites", async () => {
    const context = await withSites([
      ["shop", "shop.example.test"],
      ["blog", "blog.example.test"],
    ]);
    const selected = await selectSite(context.fileSystem, ["query"]);
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.message).toContain("--site");
    expect(selected.message).toContain("shop, blog");
  });

  // Falling back to the project's own data would write one site's evidence
  // where another site, or no site, would read it.
  it("refuses --site without a name rather than falling back", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);
    const selected = await selectSite(context.fileSystem, ["query", "--site"]);
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.message).toBe("--site requires a site name.");
  });

  it("refuses an unregistered site rather than falling back", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);
    const selected = await selectSite(context.fileSystem, [
      "query",
      "--site",
      "blog",
    ]);
    expect(selected.ok).toBe(false);
  });
});

describe("paths given to a site-scoped command", () => {
  // Under --site, a path inside opencookie/ already means the site's own
  // directory. An operator who types the real on-disk path would have it
  // mapped a second time and be told the file is unreadable, which is true and
  // useless.
  it("refuses a path that already points into the sites directory", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);

    const selected = await selectSite(context.fileSystem, [
      "publish",
      "--site",
      "shop",
      "--policy",
      "opencookie/sites/shop/policy.json",
    ]);

    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.message).toContain("opencookie/policy.json");
    expect(selected.message).toContain("opencookie/sites/shop/policy.json");
  });

  it("leaves an ordinary path alone", async () => {
    const context = await withSites([["shop", "shop.example.test"]]);

    const selected = await selectSite(context.fileSystem, [
      "ingest",
      "--site",
      "shop",
      "--from",
      "exports/receipts.json",
    ]);

    expect(selected.ok).toBe(true);
  });
});
