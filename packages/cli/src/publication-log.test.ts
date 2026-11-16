import {
  createPolicySnapshot,
  definePolicy,
  type PolicySnapshot,
} from "@opencookie-dev/core/domain";
import { describe, expect, it } from "vitest";

import {
  currentPolicyPublication,
  emptyPolicyPublicationLog,
  publishPolicy,
  rollbackPolicyPublication,
  type PolicyPublicationLog,
} from "./publication-log.js";

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

function publishOrThrow(
  log: PolicyPublicationLog,
  publicationId: string,
  snapshot: PolicySnapshot,
): PolicyPublicationLog {
  const result = publishPolicy(log, { publicationId, snapshot });
  if (!result.ok)
    throw new Error(`publication must succeed: ${result.issue.kind}`);
  return result.log;
}

describe("policy publication log", () => {
  // @covers PP-28 REQ-VERSIONED-POLICY-CATALOGUE: an operator can tell what is live now.
  it("reports the first published policy as current", () => {
    const snapshot = fixtureSnapshot("Measure site use", "version-one");
    const log = publishOrThrow(emptyPolicyPublicationLog(), "pub-1", snapshot);

    const current = currentPolicyPublication(log);

    expect(current?.publicationId).toBe("pub-1");
    expect(current?.snapshot).toStrictEqual(snapshot);
    expect(current?.supersedes).toBeUndefined();
  });

  // @covers PP-13 REQ-POLICY-SUPERSESSION: history is append-only, never rewritten.
  it("appends without rewriting earlier publications", () => {
    const first = fixtureSnapshot("Measure site use", "version-one");
    const second = fixtureSnapshot("Measure site use and reach", "version-two");
    const afterFirst = publishOrThrow(
      emptyPolicyPublicationLog(),
      "pub-1",
      first,
    );
    const afterSecond = publishOrThrow(afterFirst, "pub-2", second);

    expect(afterFirst.publications).toHaveLength(1);
    expect(afterSecond.publications).toHaveLength(2);
    expect(afterSecond.publications[0]?.snapshot).toStrictEqual(first);
    expect(currentPolicyPublication(afterSecond)?.supersedes).toBe("pub-1");
  });

  it("rejects a duplicate publication id", () => {
    const first = fixtureSnapshot("Measure site use", "version-one");
    const second = fixtureSnapshot("Measure site use and reach", "version-two");
    const log = publishOrThrow(emptyPolicyPublicationLog(), "pub-1", first);

    const result = publishPolicy(log, {
      publicationId: "pub-1",
      snapshot: second,
    });

    expect(result).toStrictEqual({
      issue: { kind: "duplicate-publication-id", publicationId: "pub-1" },
      ok: false,
    });
  });

  // Contract item 4: nothing may look published before it is true.
  it("rejects republishing the policy that is already current", () => {
    const snapshot = fixtureSnapshot("Measure site use", "version-one");
    const log = publishOrThrow(emptyPolicyPublicationLog(), "pub-1", snapshot);

    const result = publishPolicy(log, { publicationId: "pub-2", snapshot });

    expect(result).toStrictEqual({
      issue: { kind: "unchanged-current-policy", publicationId: "pub-1" },
      ok: false,
    });
  });

  it("rolls back by appending a restoring publication", () => {
    const first = fixtureSnapshot("Measure site use", "version-one");
    const second = fixtureSnapshot("Measure site use and reach", "version-two");
    const log = publishOrThrow(
      publishOrThrow(emptyPolicyPublicationLog(), "pub-1", first),
      "pub-2",
      second,
    );

    const result = rollbackPolicyPublication(log, {
      publicationId: "pub-3",
      restoreFrom: "pub-1",
    });

    if (!result.ok)
      throw new Error(`rollback must succeed: ${result.issue.kind}`);
    expect(result.log.publications).toHaveLength(3);
    expect(result.publication.snapshot).toStrictEqual(first);
    expect(result.publication.restoredFrom).toBe("pub-1");
    expect(result.publication.supersedes).toBe("pub-2");
    expect(result.log.publications[1]?.snapshot).toStrictEqual(second);
  });

  // What a declaration shows beside the policy is part of what was live. A
  // rollback that dropped it would show visitors bare identifiers, and the
  // operator could not publish it back under an unchanged policy.
  it("restores the terms and lawful bases the restored publication carried", () => {
    const first = fixtureSnapshot("Measure site use", "version-one");
    const second = fixtureSnapshot("Measure site use and reach", "version-two");
    const terms = { analytics: { label: "Statistics" } };
    const lawfulBases = { analytics: "consent" };
    const published = publishPolicy(emptyPolicyPublicationLog(), {
      lawfulBases,
      publicationId: "pub-1",
      snapshot: first,
      terms,
    });
    if (!published.ok) throw new Error("publication must succeed");
    const log = publishOrThrow(published.log, "pub-2", second);

    const result = rollbackPolicyPublication(log, {
      publicationId: "pub-3",
      restoreFrom: "pub-1",
    });

    if (!result.ok)
      throw new Error(`rollback must succeed: ${result.issue.kind}`);
    expect(result.publication.terms).toStrictEqual(terms);
    expect(result.publication.lawfulBases).toStrictEqual(lawfulBases);
  });

  it("rejects a rollback to an unknown publication", () => {
    const snapshot = fixtureSnapshot("Measure site use", "version-one");
    const log = publishOrThrow(emptyPolicyPublicationLog(), "pub-1", snapshot);

    const result = rollbackPolicyPublication(log, {
      publicationId: "pub-2",
      restoreFrom: "pub-missing",
    });

    expect(result).toStrictEqual({
      issue: { kind: "unknown-publication", publicationId: "pub-missing" },
      ok: false,
    });
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "   "],
  ])("refuses to publish under an id that is %s", (_label, publicationId) => {
    const result = publishPolicy(emptyPolicyPublicationLog(), {
      publicationId,
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("blank-publication-id");
  });

  // The id is written into generated source, so only a plain identifier may
  // enter the history: a line terminator would turn the rest into code.
  it.each([
    ["a newline", "pub-9\nfetch('https://attacker.example')"],
    ["a carriage return", "pub-9\rx"],
    ["a line separator", "pub-9 x"],
    ["a paragraph separator", "pub-9 x"],
    ["a quote", 'pub-9"x'],
    ["a space", "pub 9"],
    ["a slash", "pub/9"],
    ["a leading hyphen, which reads as a flag", "-pub-9"],
    ["more than 128 characters", `p${"x".repeat(128)}`],
  ])(
    "refuses to publish under an id containing %s",
    (_label, publicationId) => {
      const result = publishPolicy(emptyPolicyPublicationLog(), {
        publicationId,
        snapshot: fixtureSnapshot("Measure site use", "version-one"),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issue.kind).toBe("invalid-publication-id");
    },
  );

  it.each(["pub-1", "2026-09-a", "2026-03-release", "v1.0.0", "Release_2"])(
    "publishes under the plain id %s",
    (publicationId) => {
      const result = publishPolicy(emptyPolicyPublicationLog(), {
        publicationId,
        snapshot: fixtureSnapshot("Measure site use", "version-one"),
      });

      expect(result.ok).toBe(true);
    },
  );

  it("refuses to roll back under an unsafe id", () => {
    const first = publishPolicy(emptyPolicyPublicationLog(), {
      publicationId: "pub-1",
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });
    if (!first.ok) throw new Error("fixture must publish");

    const result = rollbackPolicyPublication(first.log, {
      publicationId: "pub-2\nfetch()",
      restoreFrom: "pub-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("invalid-publication-id");
  });

  it("refuses to roll back under an id that is blank", () => {
    const first = publishPolicy(emptyPolicyPublicationLog(), {
      publicationId: "pub-1",
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });
    if (!first.ok) throw new Error("fixture must publish");

    const result = rollbackPolicyPublication(first.log, {
      publicationId: "  ",
      restoreFrom: "pub-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("blank-publication-id");
  });

  it("refuses a rollback whose new id is already in the history", () => {
    const first = publishPolicy(emptyPolicyPublicationLog(), {
      publicationId: "pub-1",
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });
    if (!first.ok) throw new Error("fixture must publish");
    const second = publishPolicy(first.log, {
      publicationId: "pub-2",
      snapshot: fixtureSnapshot("Measure site use and reach", "version-two"),
    });
    if (!second.ok) throw new Error("fixture must publish twice");

    const result = rollbackPolicyPublication(second.log, {
      publicationId: "pub-1",
      restoreFrom: "pub-1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("duplicate-publication-id");
  });

  // "Already current" is decided on the identity a visitor is bound by, so a
  // change to any part of it is a real change, never refused as unchanged. A
  // change under the live version is refused for its own reason: a material
  // change requires a new version (Pass B's M-E on 0.2.0).
  it("refuses changed wording under the live version as needing a new version", () => {
    const first = publishPolicy(emptyPolicyPublicationLog(), {
      publicationId: "pub-1",
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });
    if (!first.ok) throw new Error("fixture must publish");

    const result = publishPolicy(first.log, {
      publicationId: "pub-2",
      snapshot: fixtureSnapshot("Measure reach", "version-one"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("changed-policy-same-version");
  });

  it.each([
    ["its wording and version", "Measure reach", "version-two"],
    ["its version", "Measure site use", "version-two"],
  ])("publishes a policy that differs in %s", (_label, disclosure, version) => {
    const first = publishPolicy(emptyPolicyPublicationLog(), {
      publicationId: "pub-1",
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });
    if (!first.ok) throw new Error("fixture must publish");

    const result = publishPolicy(first.log, {
      publicationId: "pub-2",
      snapshot: fixtureSnapshot(disclosure, version),
    });

    expect(result.ok).toBe(true);
  });

  it("records which publication a new one supersedes", () => {
    const first = publishPolicy(emptyPolicyPublicationLog(), {
      publicationId: "pub-1",
      snapshot: fixtureSnapshot("Measure site use", "version-one"),
    });
    if (!first.ok) throw new Error("fixture must publish");

    const second = publishPolicy(first.log, {
      publicationId: "pub-2",
      snapshot: fixtureSnapshot("Measure site use and reach", "version-two"),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.publication.supersedes).toBe("pub-1");
    expect(currentPolicyPublication(first.log)?.supersedes).toBeUndefined();
  });
});
