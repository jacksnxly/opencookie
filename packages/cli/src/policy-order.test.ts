import { describe, expect, it } from "vitest";

import { runPolicyCommand, type FileSystemPort } from "./index.js";

// The order an operator gives the categories is the order the panel and the
// declaration show them in. Publishing keeps it, and since it is not part of
// what a visitor decided, a reordering publishes under the live version.

const STORE = "opencookie/policy-publications.json";
const AUTHORED = ["preferences", "statistics", "marketing"];

function document(roots: readonly string[]): string {
  const purposes = ["language", "analytics", "ads"];
  return JSON.stringify({
    catalogueRevision: "catalogue-1",
    policy: {
      categories: roots.map((id) => ({
        id,
        purposeIds: [purposes[AUTHORED.indexOf(id)]],
      })),
      dataCategories: [{ id: "usage-data" }],
      operations: [{ id: "processing" }],
      presentationRootCategoryIds: roots,
      providers: [{ id: "site-operator" }],
      purposes: purposes.map((id) => ({
        dataCategoryIds: ["usage-data"],
        disclosure: `Uses ${id}.`,
        id,
        operationIds: ["processing"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["thirteen-months"],
      })),
      recipients: [{ id: "site-operator" }],
      retentions: [{ id: "thirteen-months" }],
    },
    policyVersion: "version-one",
  });
}

function harness(files: Map<string, string>) {
  const fileSystem: FileSystemPort = {
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
  };
  return { fileSystem, writeLine: () => undefined };
}

interface StoredSnapshot {
  readonly catalogueDigest: string;
  readonly decisionSurfaceDigest: string;
  readonly policy: { readonly presentationRootCategoryIds: string[] };
}

function stored(files: Map<string, string>): readonly StoredSnapshot[] {
  const log = JSON.parse(files.get(STORE) ?? "{}") as {
    publications: { snapshot: StoredSnapshot }[];
  };
  return log.publications.map(({ snapshot }) => snapshot);
}

async function publish(
  files: Map<string, string>,
  id: string,
  roots: readonly string[],
) {
  files.set("policy.json", document(roots));
  return runPolicyCommand(harness(files), [
    "publish",
    "--id",
    id,
    "--policy",
    "policy.json",
  ]);
}

describe("the order categories are published in", () => {
  it("is kept by publish and by install", async () => {
    const files = new Map<string, string>();

    const published = await publish(files, "pub-1", AUTHORED);
    await runPolicyCommand(harness(files), [
      "install",
      "--out",
      "src/policy.json",
    ]);

    expect(published.ok).toBe(true);
    expect(stored(files)[0]?.policy.presentationRootCategoryIds).toEqual(
      AUTHORED,
    );
    const installed = JSON.parse(files.get("src/policy.json") ?? "{}") as {
      policy?: { presentationRootCategoryIds?: unknown };
    };
    expect(installed.policy?.presentationRootCategoryIds).toEqual(AUTHORED);
  });

  // A store written before the order was kept holds it sorted. Publishing the
  // authored order again must not need a new version, which would ask every
  // visitor again over a change none of them decided on.
  it("publishes a reordering under the live version, once", async () => {
    const files = new Map<string, string>();
    await publish(files, "pub-1", [...AUTHORED].sort());

    const reordered = await publish(files, "pub-2", AUTHORED);
    const again = await publish(files, "pub-3", AUTHORED);

    expect(reordered.ok).toBe(true);
    const [before, after] = stored(files);
    expect(after?.policy.presentationRootCategoryIds).toEqual(AUTHORED);
    expect(after?.catalogueDigest).toBe(before?.catalogueDigest);
    expect(after?.decisionSurfaceDigest).toBe(before?.decisionSurfaceDigest);
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/unchanged-current-policy/u);
  });
});
