import {
  createPolicySnapshot,
  definePolicy,
  type PolicySnapshot,
} from "@opencookie-dev/core/domain";
import { describe, expect, it } from "vitest";

import {
  publishPolicyToStore,
  readPolicyPublicationLog,
  rollbackPolicyInStore,
  type FileSystemPort,
} from "./index.js";

const STORE = "opencookie/policy-publications.json";

function fixtureSnapshot(disclosure: string, version: string): PolicySnapshot {
  const result = definePolicy({
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
  });
  if (!result.ok) throw new Error("fixture policy must be valid");
  return createPolicySnapshot({
    catalogueRevision: `catalogue-${version}`,
    policy: result.policy,
    policyVersion: version,
  });
}

interface MemoryStore {
  readonly fileSystem: FileSystemPort;
  readonly files: Map<string, string>;
  wroteOutsideLock: boolean;
}

function memoryStore(initial?: string): MemoryStore {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  if (initial !== undefined) files.set(STORE, initial);
  let lockDepth = 0;
  const state: MemoryStore = {
    fileSystem: {
      exists: (path) => Promise.resolve(files.has(path)),
      mkdir: (path) => {
        directories.add(path);
        return Promise.resolve();
      },
      readFile: (path) => {
        const value = files.get(path);
        if (value === undefined) throw new Error(`Missing file: ${path}`);
        return Promise.resolve(value);
      },
      replaceFile: (path, expectedContent, content) => {
        const current = files.get(path);
        if (current !== expectedContent) {
          throw new Error(`Refusing to replace ${path}; it changed.`);
        }
        files.set(path, content);
        return Promise.resolve();
      },
      withLock: async (path, operation) => {
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (parent !== "" && !directories.has(parent)) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        if (files.has(path)) {
          throw new Error("OpenCookie initialization is already running.");
        }
        files.set(path, "");
        lockDepth += 1;
        try {
          return await operation();
        } finally {
          lockDepth -= 1;
          files.delete(path);
        }
      },
      writeFile: (path, content) => {
        if (lockDepth === 0) state.wroteOutsideLock = true;
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (parent !== "" && !directories.has(parent)) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        if (files.has(path)) {
          throw new Error(`EEXIST: file already exists, open '${path}'`);
        }
        files.set(path, content);
        return Promise.resolve();
      },
    },
    files,
    wroteOutsideLock: false,
  };
  return state;
}

async function seededStore(): Promise<MemoryStore> {
  const store = memoryStore();
  const first = await publishPolicyToStore(store.fileSystem, {
    path: STORE,
    publicationId: "pub-1",
    snapshot: fixtureSnapshot("Measure site use", "version-one"),
  });
  if (!first.ok) throw new Error("seed publication must succeed");
  const second = await publishPolicyToStore(store.fileSystem, {
    path: STORE,
    publicationId: "pub-2",
    snapshot: fixtureSnapshot("Measure site use and reach", "version-two"),
  });
  if (!second.ok) throw new Error("seed publication must succeed");
  return store;
}

describe("policy store", () => {
  it("reports an empty log when no policy has been published", async () => {
    const store = memoryStore();

    const result = await readPolicyPublicationLog(store.fileSystem, STORE);

    if (!result.ok) throw new Error("absent store must read as empty");
    expect(result.log.publications).toStrictEqual([]);
  });

  it("publishes into an absent store and records it as current", async () => {
    const store = memoryStore();

    const result = await publishPolicyToStore(store.fileSystem, {
      path: STORE,
      publicationId: "pub-1",
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });

    if (!result.ok)
      throw new Error(`publish must succeed: ${result.issue.kind}`);
    expect(result.publication.publicationId).toBe("pub-1");
    expect(store.files.has(STORE)).toBe(true);
  });

  it("appends a second publication inside the lock", async () => {
    const store = await seededStore();

    const result = await readPolicyPublicationLog(store.fileSystem, STORE);

    if (!result.ok) throw new Error("store must read back");
    expect(result.log.publications).toHaveLength(2);
    expect(result.log.publications[1]?.supersedes).toBe("pub-1");
    expect(store.wroteOutsideLock).toBe(false);
  });

  // Contract item 4: a corrupted store must not be silently replaced.
  it("refuses to publish over a store that fails its integrity check", async () => {
    const store = await seededStore();
    const document = store.files.get(STORE);
    if (document === undefined) throw new Error("store must exist");
    store.files.set(STORE, document.replace("Measure site use", "Widened"));
    const corrupted = store.files.get(STORE);

    const result = await publishPolicyToStore(store.fileSystem, {
      path: STORE,
      publicationId: "pub-3",
      snapshot: fixtureSnapshot("Something else", "version-three"),
    });

    expect(result).toStrictEqual({
      issue: { kind: "unreadable-store" },
      ok: false,
    });
    expect(store.files.get(STORE)).toBe(corrupted);
  });

  it("rolls back to an earlier publication", async () => {
    const store = await seededStore();

    const result = await rollbackPolicyInStore(store.fileSystem, {
      path: STORE,
      publicationId: "pub-3",
      restoreFrom: "pub-1",
    });

    if (!result.ok)
      throw new Error(`rollback must succeed: ${result.issue.kind}`);
    expect(result.publication.restoredFrom).toBe("pub-1");
    const reread = await readPolicyPublicationLog(store.fileSystem, STORE);
    if (!reread.ok) throw new Error("store must read back");
    expect(reread.log.publications).toHaveLength(3);
  });
});
