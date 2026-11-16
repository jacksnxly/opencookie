import { describe, expect, it } from "vitest";

import {
  buildPolicyDeclaration,
  runPolicyCommand,
  type FileSystemPort,
  definePolicyLawfulBases,
  publishPolicy,
  emptyPolicyPublicationLog,
  parsePolicyPublicationLog,
  serializePolicyPublicationLog,
} from "./index.js";
import {
  createPolicySnapshot,
  definePolicy,
} from "@opencookie-dev/core/domain";

function snapshot(version: string) {
  const defined = definePolicy({
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
  });
  if (!defined.ok) throw new Error("fixture policy must be valid");
  return createPolicySnapshot({
    catalogueRevision: `catalogue-${version}`,
    policy: defined.policy,
    policyVersion: version,
  });
}

function publicationWith(bases: Readonly<Record<string, string>> | undefined) {
  const result = publishPolicy(emptyPolicyPublicationLog(), {
    publicationId: "pub-1",
    snapshot: snapshot("1.0.0"),
    ...(bases === undefined ? {} : { lawfulBases: bases }),
  });
  if (!result.ok) throw new Error("fixture publication must succeed");
  return result.publication;
}

// @covers PP-27 REQ-LEGAL-SEPARATION / TEST-DOMAIN-LEGAL-SEPARATION: the
// library carries a lawful basis as operator metadata and never derives one,
// and the basis provably does not alter what is enforced.
describe("TEST-DOMAIN-LEGAL-SEPARATION", () => {
  it("accepts a lawful basis only for a purpose that exists", () => {
    const accepted = definePolicyLawfulBases(snapshot("1.0.0"), {
      analytics: "consent",
    });
    expect(accepted.ok).toBe(true);

    const unknown = definePolicyLawfulBases(snapshot("1.0.0"), {
      advertising: "consent",
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.issue.kind).toBe("unknown-purpose-basis");
  });

  it("refuses a blank basis instead of recording an empty legal claim", () => {
    const blank = definePolicyLawfulBases(snapshot("1.0.0"), {
      analytics: "   ",
    });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.issue.kind).toBe("blank-lawful-basis");
  });

  it("carries the operator's basis into the declaration verbatim", () => {
    const declaration = buildPolicyDeclaration(
      publicationWith({ analytics: "legitimate-interest" }),
    );
    const purpose = declaration.sections
      .flatMap((section) => section.purposes)
      .find(({ id }) => id === "analytics");
    expect(purpose?.lawfulBasis).toBe("legitimate-interest");
  });

  it("never invents a basis when the operator declared none", () => {
    const declaration = buildPolicyDeclaration(publicationWith(undefined));
    const purpose = declaration.sections
      .flatMap((section) => section.purposes)
      .find(({ id }) => id === "analytics");
    expect(purpose?.lawfulBasis).toBeUndefined();
  });

  it("does not let a lawful basis change what is enforced", () => {
    const withoutBasis = publicationWith(undefined);
    const withConsent = publicationWith({ analytics: "consent" });
    const withInterest = publicationWith({
      analytics: "legitimate-interest",
    });

    // The enforced surface and the catalogue identity are untouched by the
    // legal claim. A basis is published to readers, never applied as a rule.
    for (const other of [withConsent, withInterest]) {
      expect(other.snapshot.decisionSurfaceDigest).toBe(
        withoutBasis.snapshot.decisionSurfaceDigest,
      );
      expect(other.snapshot.catalogueDigest).toBe(
        withoutBasis.snapshot.catalogueDigest,
      );
    }
  });

  it("survives storage without the basis becoming part of the policy", () => {
    const publication = publicationWith({ analytics: "legitimate-interest" });
    const parsed = parsePolicyPublicationLog(
      serializePolicyPublicationLog({ publications: [publication] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = parsed.log.publications[0];
    expect(restored?.lawfulBases?.["analytics"]).toBe("legitimate-interest");
    expect(restored?.snapshot.decisionSurfaceDigest).toBe(
      publication.snapshot.decisionSurfaceDigest,
    );
  });
});

function commandHarness(files: Map<string, string>) {
  const lines: string[] = [];
  const fileSystem: FileSystemPort = {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing file: ${path}`);
      return Promise.resolve(value);
    },
    replaceFile: (path, previous, content) => {
      if (files.get(path) !== previous) throw new Error("stale");
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
    ports: { fileSystem, writeLine: (l: string) => lines.push(l) },
  };
}

function documentWith(bases: unknown): string {
  return JSON.stringify({
    catalogueRevision: "catalogue-1.0.0",
    lawfulBases: bases,
    policy: {
      dataCategories: [{ id: "usage-data" }],
      operations: [{ id: "processing" }],
      providers: [{ id: "site-operator" }],
      purposes: [
        {
          dataCategoryIds: ["usage-data"],
          disclosure: "Measures usage.",
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
    policyVersion: "1.0.0",
  });
}

describe("TEST-DOMAIN-LEGAL-SEPARATION operator feedback", () => {
  it("names the undefined purpose instead of blaming the whole document", async () => {
    const test = commandHarness(
      new Map([["policy.json", documentWith({ advertising: "consent" })]]),
    );

    const result = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("advertising");
    expect(result.message).not.toContain("is not a readable policy document");
  });

  it("still reports a genuinely unreadable document as unreadable", async () => {
    const test = commandHarness(new Map([["policy.json", "{not json"]]));

    const result = await runPolicyCommand(test.ports, [
      "publish",
      "--id",
      "pub-1",
      "--policy",
      "policy.json",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("is not a readable policy document");
  });
});
