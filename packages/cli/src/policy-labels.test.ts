import { describe, expect, it } from "vitest";

import {
  buildPolicyDeclaration,
  runPolicyCommand,
  type FileSystemPort,
} from "./index.js";
import {
  createPolicySnapshot,
  definePolicy,
} from "@opencookie-dev/core/domain";

// A category's heading is its label in the policy, in every language the site
// shows, and a purpose carries its text in each further language. The CLI
// previews and declares them, and refuses a term that tries to name a category.

const ENGLISH = {
  disclosure: "Measures page use.",
  label: "Statistics",
  locale: "en",
};

function document(
  options: {
    readonly english?: typeof ENGLISH;
    readonly terms?: Readonly<Record<string, { readonly label: string }>>;
    readonly version?: string;
  } = {},
) {
  const english = options.english ?? ENGLISH;
  return JSON.stringify({
    catalogueRevision: "catalogue-1",
    policy: {
      categories: [
        {
          id: "statistics",
          label: "Statistik",
          purposeIds: ["analytics"],
          translations: [{ label: english.label, locale: "en" }],
        },
      ],
      dataCategories: [{ id: "usage-data" }],
      operations: [{ id: "processing" }],
      presentationRootCategoryIds: ["statistics"],
      providers: [{ id: "site-operator" }],
      purposes: [
        {
          dataCategoryIds: ["usage-data"],
          disclosure: "Misst die Nutzung der Seiten.",
          id: "analytics",
          label: "Statistik",
          operationIds: ["processing"],
          providerIds: ["site-operator"],
          recipientIds: ["site-operator"],
          retentionIds: ["thirteen-months"],
          translations: [english],
        },
      ],
      recipients: [{ id: "site-operator" }],
      retentions: [{ id: "thirteen-months" }],
    },
    policyVersion: options.version ?? "version-one",
    ...(options.terms === undefined ? {} : { terms: options.terms }),
  });
}

function harness(files: Map<string, string>) {
  const lines: string[] = [];
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
  return {
    lines,
    ports: { fileSystem, writeLine: (line: string) => lines.push(line) },
  };
}

describe("category labels and translations in the CLI", () => {
  it("refuses a term for a category and points to its label", async () => {
    const test = harness(
      new Map([
        [
          "policy.json",
          document({
            terms: {
              analytics: { label: "Statistik" },
              "site-operator": { label: "Wir" },
              statistics: { label: "Statistik" },
              "thirteen-months": { label: "13 Monate" },
              processing: { label: "Verarbeitung" },
              "usage-data": { label: "Nutzungsdaten" },
            },
          }),
        ],
      ]),
    );

    const result = await runPolicyCommand(test.ports, [
      "preview",
      "--policy",
      "policy.json",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /"statistics" is a category.*categories\[0\]\.label/u,
    );
  });

  it("previews each category's heading and every language", async () => {
    const test = harness(new Map([["policy.json", document()]]));

    const result = await runPolicyCommand(test.ports, [
      "preview",
      "--policy",
      "policy.json",
    ]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("Statistik");
    expect(output).toMatch(/en: Statistics\b/u);
    expect(output).toContain("Measures page use.");
  });

  it("counts a reworded translation as a change a visitor sees", async () => {
    const files = new Map([["policy.json", document()]]);
    const test = harness(files);
    await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);
    files.set(
      "next.json",
      document({
        english: { ...ENGLISH, disclosure: "Measures how pages are used." },
        version: "version-two",
      }),
    );
    test.lines.length = 0;

    await runPolicyCommand(test.ports, ["preview", "--policy", "next.json"]);

    expect(test.lines.join("\n")).toMatch(/changes\b[\s\S]*analytics/u);
  });

  it("declares each category's label and each purpose's translations", () => {
    const parsed = JSON.parse(document()) as {
      policy: Parameters<typeof definePolicy>[0];
    };
    const defined = definePolicy(parsed.policy);
    if (!defined.ok) throw new Error("The test policy must be valid.");

    const declaration = buildPolicyDeclaration({
      publicationId: "pub-1",
      snapshot: createPolicySnapshot({
        catalogueRevision: "catalogue-1",
        policy: defined.policy,
        policyVersion: "version-one",
      }),
    });

    expect(declaration.sections[0]).toMatchObject({
      categoryId: "statistics",
      categoryLabel: "Statistik",
      categoryTranslations: [{ label: "Statistics", locale: "en" }],
    });
    expect(declaration.sections[0]?.purposes[0]?.translations).toEqual([
      ENGLISH,
    ]);
  });

  it("labels the starter's categories", async () => {
    const files = new Map<string, string>();
    const test = harness(files);
    await runPolicyCommand(test.ports, ["starter"]);

    const starter = JSON.parse(files.get("opencookie/policy.json") ?? "{}") as {
      policy: { categories: { label?: string }[] };
    };
    expect(starter.policy.categories.length).toBeGreaterThan(0);
    for (const category of starter.policy.categories) {
      expect(category.label).toBeTruthy();
    }
  });
});
