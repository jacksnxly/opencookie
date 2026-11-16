import { describe, expect, it } from "vitest";

import { runPolicyCommand, type FileSystemPort } from "./index.js";

const POLICY_FILE = "policy.json";
const DEFAULT_DECLARATION = "opencookie/cookie-declaration.json";

function policyDocument(disclosure: string, version: string): string {
  return JSON.stringify({
    catalogueRevision: `catalogue-${version}`,
    policy: {
      categories: [
        { id: "measurement", purposeIds: ["analytics"] },
        { id: "essential", purposeIds: ["session"] },
      ],
      dataCategories: [{ id: "usage-data" }],
      operations: [{ id: "processing" }],
      presentationRootCategoryIds: ["essential", "measurement"],
      providers: [{ id: "site-operator" }],
      purposes: [
        {
          dataCategoryIds: ["usage-data"],
          disclosure,
          id: "analytics",
          label: "Analytics",
          operationIds: ["processing"],
          providerIds: ["site-operator"],
          recipientIds: ["site-operator"],
          retentionIds: ["thirteen-months"],
        },
        {
          dataCategoryIds: ["usage-data"],
          disclosure: "Keep you signed in",
          id: "session",
          label: "Session",
          operationIds: ["processing"],
          providerIds: ["site-operator"],
          recipientIds: ["site-operator"],
          retentionIds: ["session-only"],
        },
      ],
      recipients: [{ id: "site-operator" }],
      retentions: [{ id: "thirteen-months" }, { id: "session-only" }],
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
  const directories = new Set<string>();
  const lines: string[] = [];
  return {
    files,
    lines,
    ports: {
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
          if (files.get(path) !== expectedContent) {
            throw new Error(`Refusing to replace ${path}; it changed.`);
          }
          files.set(path, content);
          return Promise.resolve();
        },
        withLock: async (path, operation) => {
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (parent !== "" && !directories.has(parent)) {
            throw new Error(
              `ENOENT: no such file or directory, open '${path}'`,
            );
          }
          if (files.has(path)) throw new Error("Already running.");
          files.set(path, "");
          try {
            return await operation();
          } finally {
            files.delete(path);
          }
        },
        writeFile: (path, content) => {
          const parent = path.slice(0, path.lastIndexOf("/"));
          if (parent !== "" && !directories.has(parent)) {
            throw new Error(
              `ENOENT: no such file or directory, open '${path}'`,
            );
          }
          if (files.has(path)) {
            throw new Error(`EEXIST: file already exists, open '${path}'`);
          }
          files.set(path, content);
          return Promise.resolve();
        },
      },
      writeLine: (line) => lines.push(line),
    },
  };
}

async function published(): Promise<Harness> {
  const test = harness({
    [POLICY_FILE]: policyDocument("Measure site use", "version-one"),
  });
  const result = await runPolicyCommand(test.ports, [
    "publish",
    "--id",
    "pub-1",
    "--policy",
    POLICY_FILE,
  ]);
  if (!result.ok) throw new Error("seed publication must succeed");
  return test;
}

describe("cookie declaration", () => {
  it("refuses to render a declaration when nothing is published", async () => {
    const test = harness();

    const result = await runPolicyCommand(test.ports, ["declaration"]);

    expect(result.ok).toBe(false);
    expect(test.files.has(DEFAULT_DECLARATION)).toBe(false);
  });

  it("writes a declaration bound to the live publication", async () => {
    const test = await published();

    const result = await runPolicyCommand(test.ports, ["declaration"]);

    expect(result.ok).toBe(true);
    const written = test.files.get(DEFAULT_DECLARATION);
    if (written === undefined) throw new Error("declaration must be written");
    const document = JSON.parse(written) as {
      publicationId: string;
      policyVersion: string;
      catalogueDigest: string;
    };
    expect(document.publicationId).toBe("pub-1");
    expect(document.policyVersion).toBe("version-one");
    expect(document.catalogueDigest).toMatch(/.+/u);
  });

  it("groups purposes into their presentation sections with disclosures", async () => {
    const test = await published();

    await runPolicyCommand(test.ports, ["declaration"]);

    const written = test.files.get(DEFAULT_DECLARATION);
    if (written === undefined) throw new Error("declaration must be written");
    const document = JSON.parse(written) as {
      sections: {
        categoryId: string | null;
        purposes: {
          disclosure: string;
          id: string;
          providerIds: string[];
          retentionIds: string[];
        }[];
      }[];
    };
    const essential = document.sections.find(
      (section) => section.categoryId === "essential",
    );
    const measurement = document.sections.find(
      (section) => section.categoryId === "measurement",
    );
    expect(essential?.purposes[0]?.id).toBe("session");
    expect(measurement?.purposes[0]?.disclosure).toBe("Measure site use");
    expect(measurement?.purposes[0]?.retentionIds).toStrictEqual([
      "thirteen-months",
    ]);
  });

  it("writes to a requested path", async () => {
    const test = await published();

    const result = await runPolicyCommand(test.ports, [
      "declaration",
      "--out",
      "public/cookies.json",
    ]);

    expect(result.ok).toBe(true);
    expect(test.files.has("public/cookies.json")).toBe(true);
  });

  it("refuses when the published history fails its integrity check", async () => {
    const test = await published();
    const stored = test.files.get("opencookie/policy-publications.json");
    if (stored === undefined) throw new Error("store must exist");
    test.files.set(
      "opencookie/policy-publications.json",
      stored.replace("Measure site use", "Widened"),
    );

    const result = await runPolicyCommand(test.ports, ["declaration"]);

    expect(result.ok).toBe(false);
    expect(test.files.has(DEFAULT_DECLARATION)).toBe(false);
  });
});
