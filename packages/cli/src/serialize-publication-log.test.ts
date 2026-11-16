import {
  createPolicySnapshot,
  definePolicy,
  type PolicySnapshot,
} from "@opencookie-dev/core/domain";
import { describe, expect, it } from "vitest";

import {
  emptyPolicyPublicationLog,
  publishPolicy,
  rollbackPolicyPublication,
  type PolicyPublicationLog,
} from "./publication-log.js";
import {
  parsePolicyPublicationLog,
  serializePolicyPublicationLog,
} from "./serialize-publication-log.js";

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

function publishedLog(): PolicyPublicationLog {
  const first = publishPolicy(emptyPolicyPublicationLog(), {
    publicationId: "pub-1",
    snapshot: fixtureSnapshot("Measure site use", "version-one"),
  });
  if (!first.ok) throw new Error("first publication must succeed");
  const second = publishPolicy(first.log, {
    publicationId: "pub-2",
    snapshot: fixtureSnapshot("Measure site use and reach", "version-two"),
  });
  if (!second.ok) throw new Error("second publication must succeed");
  const rolledBack = rollbackPolicyPublication(second.log, {
    publicationId: "pub-3",
    restoreFrom: "pub-1",
  });
  if (!rolledBack.ok) throw new Error("rollback must succeed");
  return rolledBack.log;
}

describe("policy publication log serialization", () => {
  // @covers PP-28 REQ-VERSIONED-POLICY-CATALOGUE: the published history survives storage.
  it("round-trips a published log including its rollback", () => {
    const log = publishedLog();

    const parsed = parsePolicyPublicationLog(
      serializePolicyPublicationLog(log),
    );

    if (!parsed.ok) throw new Error(`parse must succeed: ${parsed.issue.kind}`);
    expect(parsed.log).toStrictEqual(log);
  });

  it("rejects text that is not valid JSON", () => {
    const parsed = parsePolicyPublicationLog("{not json");

    expect(parsed).toStrictEqual({
      issue: { kind: "malformed-publication-document" },
      ok: false,
    });
  });

  it("rejects a document that is not a publication log", () => {
    const parsed = parsePolicyPublicationLog(
      JSON.stringify({ publications: "not-a-list" }),
    );

    expect(parsed).toStrictEqual({
      issue: { kind: "malformed-publication-document" },
      ok: false,
    });
  });

  // Contract item 4: a tampered or corrupted publication must never look valid.
  it("rejects a publication whose policy no longer matches its digest", () => {
    const document = JSON.parse(
      serializePolicyPublicationLog(publishedLog()),
    ) as {
      publications: {
        snapshot: { policy: { purposes: { disclosure: string }[] } };
      }[];
    };
    const tampered = document.publications[0]?.snapshot.policy.purposes[0];
    if (tampered === undefined)
      throw new Error("fixture must expose a purpose");
    tampered.disclosure = "Silently widened purpose";

    const parsed = parsePolicyPublicationLog(JSON.stringify(document));

    expect(parsed).toStrictEqual({
      issue: { kind: "publication-digest-mismatch", publicationId: "pub-1" },
      ok: false,
    });
  });

  it.each([
    ["a newline", "pub-9\nfetch('https://attacker.example')"],
    ["a line separator", "pub-9 fetch()"],
    ["a quote", 'pub-9"'],
  ])(
    "rejects a stored publication id containing %s",
    (_label, publicationId) => {
      const document = JSON.parse(
        serializePolicyPublicationLog(publishedLog()),
      ) as { publications: { publicationId: string }[] };
      const first = document.publications[0];
      if (first === undefined) throw new Error("fixture must expose an entry");
      first.publicationId = publicationId;

      expect(parsePolicyPublicationLog(JSON.stringify(document))).toStrictEqual(
        { issue: { kind: "malformed-publication-document" }, ok: false },
      );
    },
  );

  it("rejects duplicate publication ids", () => {
    const document = JSON.parse(
      serializePolicyPublicationLog(publishedLog()),
    ) as { publications: { publicationId: string }[] };
    const second = document.publications[1];
    if (second === undefined)
      throw new Error("fixture must expose two entries");
    second.publicationId = "pub-1";

    const parsed = parsePolicyPublicationLog(JSON.stringify(document));

    expect(parsed).toStrictEqual({
      issue: { kind: "duplicate-publication-id", publicationId: "pub-1" },
      ok: false,
    });
  });

  it("rejects a restoredFrom that names no publication", () => {
    const document = JSON.parse(
      serializePolicyPublicationLog(publishedLog()),
    ) as { publications: { restoredFrom?: string }[] };
    const restoring = document.publications[2];
    if (restoring === undefined)
      throw new Error("fixture must expose a rollback");
    restoring.restoredFrom = "pub-missing";

    const parsed = parsePolicyPublicationLog(JSON.stringify(document));

    expect(parsed).toStrictEqual({
      issue: { kind: "unknown-publication", publicationId: "pub-missing" },
      ok: false,
    });
  });

  // The store is the record of what was enforced. Every shape below is a store
  // that has been damaged or tampered with, and each is refused whole rather
  // than partly believed.
  it.each([
    ["nothing at all", "null"],
    ["a list", "[]"],
    [
      "a document of another version",
      JSON.stringify({ publications: [], version: 99 }),
    ],
    [
      "publications that are not a list",
      JSON.stringify({ publications: {}, version: 1 }),
    ],
  ])("refuses %s", (_label, document) => {
    expect(parsePolicyPublicationLog(document)).toStrictEqual({
      issue: { kind: "malformed-publication-document" },
      ok: false,
    });
  });

  it.each([
    ["an entry that is not an object", () => 7],
    [
      "an entry with no publication id",
      (entry: Record<string, unknown>) => ({
        ...entry,
        publicationId: undefined,
      }),
    ],
    [
      "an entry whose publication id is not text",
      (entry: Record<string, unknown>) => ({ ...entry, publicationId: 3 }),
    ],
    [
      "an entry with no snapshot",
      (entry: Record<string, unknown>) => ({ ...entry, snapshot: undefined }),
    ],
    [
      "a snapshot with no policy",
      (entry: Record<string, unknown>) => ({
        ...entry,
        snapshot: {
          ...(entry["snapshot"] as Record<string, unknown>),
          policy: undefined,
        },
      }),
    ],
    [
      "a snapshot with no catalogue revision",
      (entry: Record<string, unknown>) => ({
        ...entry,
        snapshot: {
          ...(entry["snapshot"] as Record<string, unknown>),
          catalogueRevision: undefined,
        },
      }),
    ],
    [
      "a policy the domain refuses",
      (entry: Record<string, unknown>) => ({
        ...entry,
        snapshot: {
          ...(entry["snapshot"] as Record<string, unknown>),
          policy: { purposes: [{ id: "" }] },
        },
      }),
    ],
    [
      "a rollback pointer that is not text",
      (entry: Record<string, unknown>) => ({ ...entry, restoredFrom: 5 }),
    ],
    [
      "a supersedes pointer that is not text",
      (entry: Record<string, unknown>) => ({ ...entry, supersedes: 5 }),
    ],
    [
      "lawful bases that are not an object",
      (entry: Record<string, unknown>) => ({
        ...entry,
        lawfulBases: "consent",
      }),
    ],
    [
      "a lawful basis that is not text",
      (entry: Record<string, unknown>) => ({
        ...entry,
        lawfulBases: { analytics: 7 },
      }),
    ],
    [
      "terms that are not an object",
      (entry: Record<string, unknown>) => ({ ...entry, terms: "analytics" }),
    ],
  ])("refuses a store carrying %s", (_label, damage) => {
    const document = JSON.parse(
      serializePolicyPublicationLog(publishedLog()),
    ) as { publications: Record<string, unknown>[] };
    document.publications[0] = damage(
      document.publications[0] as Record<string, unknown>,
    ) as Record<string, unknown>;

    const parsed = parsePolicyPublicationLog(JSON.stringify(document));

    expect(parsed.ok).toBe(false);
  });

  it("refuses a publication whose decision surface digest was edited", () => {
    const document = JSON.parse(
      serializePolicyPublicationLog(publishedLog()),
    ) as {
      publications: { snapshot: { decisionSurfaceDigest: string } }[];
    };
    const first = document.publications[0];
    if (first === undefined) throw new Error("fixture must publish");
    first.snapshot.decisionSurfaceDigest = "sha256-v1:edited";

    const parsed = parsePolicyPublicationLog(JSON.stringify(document));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issue.kind).toBe("publication-digest-mismatch");
  });
});
