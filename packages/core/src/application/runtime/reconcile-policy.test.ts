import { describe, expect, it } from "vitest";

import {
  CONSENT_RECORD_SCHEMA_VERSION,
  type ConsentRecord,
} from "../../domain/consent-decisioning/index.js";
import {
  canonicalizePolicy,
  createPolicySnapshot,
  definePolicy,
  type PolicyPurposeDefinition,
  type PolicySnapshot,
} from "../../domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../../testing/policy-test-fixtures.test-helper.js";
import {
  createPolicyReconciler,
  type ConsentPolicyReconciliationInput,
} from "../../reconciliation.js";

type Purpose = Readonly<
  Pick<PolicyPurposeDefinition, "id"> &
    Partial<Omit<PolicyPurposeDefinition, "id">>
>;

const reconciler = createPolicyReconciler();

function reconcileConsentPolicy(input: ConsentPolicyReconciliationInput) {
  return reconciler.reconcile(input);
}

function policySnapshot(
  policyVersion: string,
  purposes: readonly Purpose[],
  catalogueRevision = `catalogue-${policyVersion}`,
): PolicySnapshot {
  const policy = definePolicy(completeTestPolicyDefinition({ purposes }));
  if (!policy.ok) throw new Error("Test policy must be valid.");
  return createPolicySnapshot({
    catalogueRevision,
    policy: policy.policy,
    policyVersion,
  });
}

function consentRecord(
  snapshot: PolicySnapshot,
  decisions: Readonly<Record<string, "denied" | "granted">>,
  overrides: Partial<ConsentRecord> = {},
): ConsentRecord {
  return {
    decidedAt: 1_000,
    decisions: Object.entries(decisions).map(([purposeId, value]) => ({
      purposeId,
      value,
    })),
    expiresAt: 10_000,
    method: "granular",
    policy: {
      catalogueDigest: snapshot.catalogueDigest,
      decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
      policyVersion: snapshot.policyVersion,
    },
    recordId: "record-1",
    revision: 1,
    schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
    ...overrides,
  } as ConsentRecord;
}

describe("reconcileConsentPolicy", () => {
  it("derives the complete retained change set and carries unaffected choices", () => {
    const previous = policySnapshot("policy-1", [
      { disclosure: "Old A", id: "a" },
      { disclosure: "Old B", id: "b" },
      { id: "denied" },
      { id: "unaffected" },
      { id: "removed" },
    ]);
    const current = policySnapshot("policy-2", [
      { disclosure: "New A", id: "a" },
      { disclosure: "New B", id: "b" },
      { id: "added" },
      { id: "denied" },
      { id: "unaffected" },
    ]);

    const result = reconcileConsentPolicy({
      currentPolicy: current,
      now: 2_000,
      policyHistory: [previous],
      record: consentRecord(previous, {
        a: "granted",
        b: "granted",
        denied: "denied",
        removed: "granted",
        unaffected: "granted",
      }),
    });

    expect(result.status).toBe("requires-reconsent");
    expect(result.issues).toEqual([]);
    expect(result.decisions).toEqual([
      { purposeId: "a", value: "unresolved" },
      { purposeId: "added", value: "unresolved" },
      { purposeId: "b", value: "unresolved" },
      { purposeId: "denied", value: "denied" },
      { purposeId: "unaffected", value: "granted" },
    ]);
    expect(result.affectedPurposes.map(({ purposeId }) => purposeId)).toEqual([
      "a",
      "added",
      "b",
    ]);
    expect(result.affectedPurposes).toEqual(
      expect.arrayContaining([
        { purposeId: "a", reasonCodes: ["free-text"] },
        { purposeId: "b", reasonCodes: ["free-text"] },
        { purposeId: "added", reasonCodes: ["purpose-added"] },
      ]),
    );
  });

  it("keeps an affected denial denied", () => {
    const previous = policySnapshot("policy-1", [
      { disclosure: "Old", id: "analytics" },
    ]);
    const current = policySnapshot("policy-2", [
      { disclosure: "New", id: "analytics" },
    ]);

    expect(
      reconcileConsentPolicy({
        currentPolicy: current,
        now: 2_000,
        policyHistory: [previous],
        record: consentRecord(previous, { analytics: "denied" }),
      }).decisions,
    ).toEqual([{ purposeId: "analytics", value: "denied" }]);
  });

  it("finds an older matching policy when the visitor skipped releases", () => {
    const first = policySnapshot("policy-1", [
      { disclosure: "First", id: "analytics" },
      { id: "functional" },
    ]);
    const second = policySnapshot("policy-2", [
      { disclosure: "Second", id: "analytics" },
      { id: "functional" },
    ]);
    const current = policySnapshot("policy-3", [
      { disclosure: "Current", id: "analytics" },
      { id: "functional" },
    ]);

    const result = reconcileConsentPolicy({
      currentPolicy: current,
      now: 2_000,
      policyHistory: [second, first],
      record: consentRecord(first, {
        analytics: "granted",
        functional: "granted",
      }),
    });

    expect(result.status).toBe("requires-reconsent");
    expect(result.decisions).toEqual([
      { purposeId: "analytics", value: "unresolved" },
      { purposeId: "functional", value: "granted" },
    ]);
  });

  it("accepts an editorial-only catalogue change from verified history", () => {
    const previous = policySnapshot("policy-1", [
      { editorialNote: "old", id: "analytics" },
    ]);
    const current = policySnapshot(
      "policy-1",
      [{ editorialNote: "new", id: "analytics" }],
      "catalogue-editorial",
    );

    const result = reconcileConsentPolicy({
      currentPolicy: current,
      now: 2_000,
      policyHistory: [previous],
      record: consentRecord(previous, { analytics: "granted" }),
    });

    expect(result.status).toBe("current");
    expect(result.decisions).toEqual([
      { purposeId: "analytics", value: "granted" },
    ]);
  });

  it("fails closed when matching history is missing or duplicated", () => {
    const previous = policySnapshot("policy-1", [
      { id: "analytics" },
      { id: "personalization" },
    ]);
    const current = policySnapshot("policy-2", [
      { disclosure: "Changed", id: "analytics" },
      { id: "personalization" },
    ]);
    const record = consentRecord(previous, {
      analytics: "granted",
      personalization: "denied",
    });

    for (const policyHistory of [[], [previous, previous]]) {
      const result = reconcileConsentPolicy({
        currentPolicy: current,
        now: 2_000,
        policyHistory,
        record,
      });
      expect(result.status).toBe("invalid");
      expect(result.decisions).toEqual([
        { purposeId: "analytics", value: "unresolved" },
        { purposeId: "personalization", value: "denied" },
      ]);
      expect(result.issues[0]?.code).toMatch(
        /^policy-history-(missing|duplicate)$/u,
      );
    }
  });

  it("fails closed when the derived diff and policy version are inconsistent", () => {
    const previous = policySnapshot("policy-1", [
      { disclosure: "Old", id: "analytics" },
    ]);
    const inconsistent = policySnapshot("policy-1", [
      { disclosure: "New", id: "analytics" },
    ]);

    const result = reconcileConsentPolicy({
      currentPolicy: inconsistent,
      now: 2_000,
      policyHistory: [previous],
      record: consentRecord(previous, { analytics: "granted" }),
    });

    expect(result.status).toBe("invalid");
    expect(result.issues).toEqual([
      {
        code: "policy-diff-inconsistent",
        detail: "policy-version-unchanged-with-affected-purpose",
        path: "policyHistory",
      },
    ]);
    expect(result.decisions).toEqual([
      { purposeId: "analytics", value: "unresolved" },
    ]);
  });

  it("never carries a grant from an expired or malformed record", () => {
    const snapshot = policySnapshot("policy-1", [
      { id: "analytics" },
      { id: "personalization" },
    ]);
    const record = consentRecord(snapshot, {
      analytics: "granted",
      personalization: "denied",
    });

    const expired = reconcileConsentPolicy({
      currentPolicy: snapshot,
      now: record.expiresAt,
      policyHistory: [],
      record,
    });
    expect(expired.status).toBe("expired");
    expect(expired.decisions).toEqual([
      { purposeId: "analytics", value: "unresolved" },
      { purposeId: "personalization", value: "denied" },
    ]);

    const malformed = reconcileConsentPolicy({
      currentPolicy: snapshot,
      now: 2_000,
      policyHistory: [],
      record: { ...record, decisions: [{ purposeId: "analytics" }] } as never,
    });
    expect(malformed.status).toBe("invalid");
    expect(malformed.decisions.every(({ value }) => value !== "granted")).toBe(
      true,
    );
    expect(malformed.issues[0]).toEqual({
      code: "invalid-consent-record",
      path: "current.decisions",
    });

    const future = reconcileConsentPolicy({
      currentPolicy: snapshot,
      now: 500,
      policyHistory: [],
      record,
    });
    expect(future.status).toBe("invalid");
    expect(future.issues[0]).toEqual({
      code: "invalid-consent-record",
      path: "decidedAt",
    });
  });

  it("rejects accessor, revoked-proxy, sparse, and oversized history", () => {
    const previous = policySnapshot("policy-1", [{ id: "analytics" }]);
    const current = policySnapshot("policy-2", [
      { disclosure: "Changed", id: "analytics" },
    ]);
    const record = consentRecord(previous, { analytics: "granted" });
    let accessorReads = 0;
    const accessorInput = { currentPolicy: current, now: 2_000, record };
    Object.defineProperty(accessorInput, "policyHistory", {
      get() {
        accessorReads += 1;
        return [previous];
      },
    });
    const { proxy, revoke } = Proxy.revocable(previous, {});
    revoke();

    for (const input of [
      accessorInput,
      {
        currentPolicy: current,
        now: 2_000,
        policyHistory: [proxy],
        record,
      },
      {
        currentPolicy: current,
        now: 2_000,
        policyHistory: new Array(1),
        record,
      },
      {
        currentPolicy: current,
        now: 2_000,
        policyHistory: Array.from({ length: 33 }, () => previous),
        record,
      },
    ]) {
      const result = reconcileConsentPolicy(input as never);
      expect(result.status).toBe("invalid");
      expect(result.issues[0]?.code).toBe("invalid-policy-history");
      expect(result.decisions.every(({ value }) => value !== "granted")).toBe(
        true,
      );
    }
    expect(accessorReads).toBe(0);
  });

  it("returns a stable deeply frozen invalid result for malformed current policy", () => {
    const genuine = policySnapshot("policy-1", [{ id: "analytics" }]);
    const record = consentRecord(genuine, { analytics: "granted" });
    let accessorReads = 0;
    const accessorSnapshot = {};
    Object.defineProperties(accessorSnapshot, {
      catalogueDigest: {
        get() {
          accessorReads += 1;
          throw new Error("current policy getter must not run");
        },
      },
      policy: {
        get() {
          accessorReads += 1;
          throw new Error("current policy getter must not run");
        },
      },
    });
    const { proxy, revoke } = Proxy.revocable(genuine, {});
    revoke();

    const results = [{}, accessorSnapshot, proxy].map((currentPolicy) =>
      reconcileConsentPolicy({
        currentPolicy,
        now: 2_000,
        policyHistory: [],
        record,
      } as never),
    );

    expect(accessorReads).toBe(0);
    for (const result of results) {
      expect(result).toMatchObject({
        affectedPurposes: [],
        decisions: [],
        issues: [{ code: "invalid-policy-snapshot", path: "currentPolicy" }],
        policy: {
          catalogueDigest: "invalid-policy-snapshot",
          decisionSurfaceDigest: "invalid-policy-snapshot",
          policyVersion: "invalid-policy-snapshot",
        },
        prompt: true,
        status: "invalid",
      });
      expect(result.decisions.some(({ value }) => value === "granted")).toBe(
        false,
      );
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.affectedPurposes)).toBe(true);
      expect(Object.isFrozen(result.decisions)).toBe(true);
      expect(Object.isFrozen(result.issues)).toBe(true);
      expect(Object.isFrozen(result.issues[0])).toBe(true);
      expect(Object.isFrozen(result.policy)).toBe(true);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("rejects policy bodies that do not match their claimed identities", () => {
    const previous = policySnapshot("policy-1", [
      { disclosure: "Old A", id: "a" },
      { disclosure: "Old B", id: "b" },
    ]);
    const current = policySnapshot("policy-2", [
      { disclosure: "New A", id: "a" },
      { disclosure: "New B", id: "b" },
    ]);
    const forgedCurrent = {
      ...current,
      catalogueDigest: previous.catalogueDigest,
      catalogueRevision: previous.catalogueRevision,
      decisionSurfaceDigest: previous.decisionSurfaceDigest,
      policyVersion: previous.policyVersion,
    };
    const hybridPolicy = definePolicy(
      completeTestPolicyDefinition({
        purposes: [
          { disclosure: "Old A", id: "a" },
          { disclosure: "New B", id: "b" },
        ],
      }),
    );
    if (!hybridPolicy.ok) throw new Error("Hybrid policy must be valid.");
    const forgedHistory = {
      ...previous,
      policy: hybridPolicy.policy,
    };
    const record = consentRecord(previous, { a: "granted", b: "granted" });

    for (const input of [
      {
        currentPolicy: forgedCurrent,
        policyHistory: [],
      },
      {
        currentPolicy: current,
        policyHistory: [forgedHistory],
      },
      {
        currentPolicy: current,
        policyHistory: [new Proxy(forgedHistory, {})],
      },
    ]) {
      const result = reconcileConsentPolicy({
        ...input,
        now: 2_000,
        record,
      });
      expect(result.status).not.toBe("current");
      expect(result.issues[0]?.code).toBe("invalid-policy-snapshot");
      expect(result.decisions.some(({ value }) => value === "granted")).toBe(
        false,
      );
    }
  });

  it.each([
    ["missing", []],
    ["malformed", {}],
    ["duplicate", undefined],
    ["accessor-backed", undefined],
    ["hostile", undefined],
  ])(
    "keeps a withdrawal prompting when policy history is %s",
    (variant, suppliedHistory) => {
      const previous = policySnapshot("policy-1", [{ id: "analytics" }]);
      const current = policySnapshot("policy-2", [
        { disclosure: "Changed", id: "analytics" },
        { id: "added" },
      ]);
      const { proxy, revoke } = Proxy.revocable(previous, {});
      revoke();
      const policyHistory =
        variant === "duplicate"
          ? [previous, previous]
          : variant === "hostile"
            ? [proxy]
            : suppliedHistory;
      let historyAccessorReads = 0;
      const input: Record<string, unknown> = {
        currentPolicy: current,
        now: 2_000,
        record: consentRecord(
          previous,
          { analytics: "denied" },
          { method: "withdrawal", withdrawnAt: 1_500 },
        ),
      };
      if (variant === "accessor-backed") {
        Object.defineProperty(input, "policyHistory", {
          enumerable: true,
          get() {
            historyAccessorReads += 1;
            return [previous];
          },
        });
      } else {
        input["policyHistory"] = policyHistory;
      }
      const result = reconcileConsentPolicy(input as never);

      expect(historyAccessorReads).toBe(0);
      expect(result.status).toBe("invalid");
      expect(result.prompt).toBe(true);
      expect(result.decisions).toEqual([
        { purposeId: "added", value: "unresolved" },
        { purposeId: "analytics", value: "denied" },
      ]);
      expect(result.issues[0]?.code).toMatch(
        /^(?:invalid-policy-history|policy-history-(?:duplicate|missing))$/u,
      );
    },
  );

  it.each([
    "arbitrary junk",
    "legacy raw-canonical identities",
    "unsupported catalogue version with a supported decision version",
    "supported catalogue version with an unsupported decision version",
    "uppercase sha256-v1 hex",
    "short sha256-v1 digest",
    "catalogue identity with leading junk",
    "catalogue identity with a trailing hex digit",
    "decision identity with leading junk",
    "decision identity with a trailing hex digit",
  ] as const)(
    "rejects %s for a withdrawal without exact history",
    (variant) => {
      const previous = policySnapshot("policy-1", [
        { id: "analytics" },
        { id: "personalization" },
      ]);
      const current = policySnapshot("policy-2", [
        { disclosure: "Changed", id: "analytics" },
        { id: "personalization" },
      ]);
      const legacy = canonicalizePolicy(previous.policy);
      let catalogueDigest = previous.catalogueDigest;
      let decisionSurfaceDigest = previous.decisionSurfaceDigest;
      switch (variant) {
        case "arbitrary junk":
          catalogueDigest = "arbitrary-catalogue-junk";
          decisionSurfaceDigest = "arbitrary-decision-junk";
          break;
        case "legacy raw-canonical identities":
          catalogueDigest = legacy.catalogue;
          decisionSurfaceDigest = legacy.decisionSurface;
          break;
        case "unsupported catalogue version with a supported decision version":
          catalogueDigest = `sha256-v2:${"a".repeat(64)}`;
          break;
        case "supported catalogue version with an unsupported decision version":
          decisionSurfaceDigest = `sha256-v2:${"b".repeat(64)}`;
          break;
        case "uppercase sha256-v1 hex":
          catalogueDigest = `sha256-v1:${"A".repeat(64)}`;
          decisionSurfaceDigest = `sha256-v1:${"B".repeat(64)}`;
          break;
        case "short sha256-v1 digest":
          catalogueDigest = `sha256-v1:${"c".repeat(63)}`;
          break;
        case "catalogue identity with leading junk":
          catalogueDigest = `junk-${previous.catalogueDigest}`;
          break;
        case "catalogue identity with a trailing hex digit":
          catalogueDigest = `${previous.catalogueDigest}a`;
          break;
        case "decision identity with leading junk":
          decisionSurfaceDigest = `junk-${previous.decisionSurfaceDigest}`;
          break;
        case "decision identity with a trailing hex digit":
          decisionSurfaceDigest = `${previous.decisionSurfaceDigest}a`;
          break;
      }

      const result = reconcileConsentPolicy({
        currentPolicy: current,
        now: 2_000,
        policyHistory: [],
        record: consentRecord(
          previous,
          { analytics: "denied", personalization: "denied" },
          {
            method: "withdrawal",
            policy: {
              catalogueDigest,
              decisionSurfaceDigest,
              policyVersion: previous.policyVersion,
            },
            withdrawnAt: 1_500,
          },
        ),
      });

      expect(result.status).toBe("invalid");
      expect(result.status).not.toBe("withdrawn");
      expect(result.prompt).toBe(true);
      expect(result.issues).toEqual([
        { code: "policy-history-missing", path: "policyHistory" },
      ]);
      expect(result.decisions.some(({ value }) => value === "granted")).toBe(
        false,
      );
    },
  );

  it("keeps a semantically valid sha256-v1 withdrawal non-prompting without exact history", () => {
    const previous = policySnapshot("policy-1", [
      { id: "analytics" },
      { id: "personalization" },
    ]);
    const current = policySnapshot("policy-2", [
      { disclosure: "Changed", id: "analytics" },
      { id: "personalization" },
    ]);
    expect(previous.catalogueDigest).toMatch(/^sha256-v1:[0-9a-f]{64}$/u);
    expect(previous.decisionSurfaceDigest).toMatch(/^sha256-v1:[0-9a-f]{64}$/u);

    const supported = reconcileConsentPolicy({
      currentPolicy: current,
      now: 2_000,
      policyHistory: [],
      record: consentRecord(
        previous,
        { analytics: "denied", personalization: "denied" },
        { method: "withdrawal", withdrawnAt: 1_500 },
      ),
    });

    expect(supported.status).toBe("withdrawn");
    expect(supported.prompt).toBe(false);
    expect(supported.decisions.some(({ value }) => value === "granted")).toBe(
      false,
    );
  });

  it.each([
    [
      "future withdrawal time",
      { withdrawnAt: 2_500 },
      (previous: PolicySnapshot) => [previous],
      "withdrawnAt",
    ],
    [
      "incomplete decision set with exact history",
      { decisions: [{ purposeId: "analytics", value: "denied" }] },
      (previous: PolicySnapshot) => [previous],
      "decisions",
    ],
    [
      "granted withdrawal decision",
      {
        decisions: [
          { purposeId: "analytics", value: "granted" },
          { purposeId: "personalization", value: "denied" },
        ],
      },
      () => [],
      "current.decisions",
    ],
    ["blank record identity", { recordId: " " }, () => [], "current.recordId"],
    [
      "duplicate withdrawal decision",
      {
        decisions: [
          { purposeId: "analytics", value: "denied" },
          { purposeId: "analytics", value: "denied" },
        ],
      },
      () => [],
      "current.decisions",
    ],
  ] as const)(
    "keeps an invalid withdrawal prompting for %s",
    (_label, overrides, history, expectedPath) => {
      const previous = policySnapshot("policy-1", [
        { id: "analytics" },
        { id: "personalization" },
      ]);
      const current = policySnapshot("policy-2", [
        { disclosure: "Changed", id: "analytics" },
        { id: "personalization" },
      ]);
      const record = consentRecord(
        previous,
        { analytics: "denied", personalization: "denied" },
        {
          method: "withdrawal",
          withdrawnAt: 1_500,
          ...overrides,
        } as never,
      );

      const result = reconcileConsentPolicy({
        currentPolicy: current,
        now: 2_000,
        policyHistory: history(previous),
        record,
      });

      expect(result.status).toBe("invalid");
      expect(result.prompt).toBe(true);
      expect(result.decisions.some(({ value }) => value === "granted")).toBe(
        false,
      );
      expect(result.issues[0]).toMatchObject({
        code: "invalid-consent-record",
        path: expectedPath,
      });
    },
  );

  it("captures history once and returns a deeply immutable plan", () => {
    const previous = policySnapshot("policy-1", [
      { disclosure: "Old", id: "analytics" },
    ]);
    const current = policySnapshot("policy-2", [
      { disclosure: "New", id: "analytics" },
    ]);
    const mutableHistory = [structuredClone(previous)];

    const result = reconcileConsentPolicy({
      currentPolicy: structuredClone(current),
      now: 2_000,
      policyHistory: mutableHistory,
      record: structuredClone(
        consentRecord(previous, { analytics: "granted" }),
      ),
    });
    mutableHistory.length = 0;

    expect(result.decisions).toEqual([
      { purposeId: "analytics", value: "unresolved" },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Object.isFrozen(result.decisions[0])).toBe(true);
    expect(Object.isFrozen(result.affectedPurposes)).toBe(true);
  });

  it("requires identity-matched history before carrying an active grant", () => {
    const current = policySnapshot("policy-1", [{ id: "analytics" }]);
    const record = consentRecord(current, { analytics: "granted" });

    const missing = reconcileConsentPolicy({
      currentPolicy: current,
      now: 2_000,
      policyHistory: [],
      record,
    });
    expect(missing.status).toBe("invalid");
    expect(missing.issues).toEqual([
      { code: "policy-history-missing", path: "policyHistory" },
    ]);
    expect(missing.decisions).toEqual([
      { purposeId: "analytics", value: "unresolved" },
    ]);

    const verified = reconcileConsentPolicy({
      currentPolicy: current,
      now: 2_000,
      policyHistory: [current],
      record,
    });
    expect(verified.status).toBe("current");
    expect(verified.decisions).toEqual([
      { purposeId: "analytics", value: "granted" },
    ]);
    expect(verified.issues).toEqual([]);
  });

  it.each(["malformed-record", "invalid-time"] as const)(
    "verifies a forged current policy before returning for %s",
    (variant) => {
      const genuine = policySnapshot("policy-1", [{ id: "analytics" }]);
      const forged = {
        ...genuine,
        catalogueDigest: "forged-catalogue",
        decisionSurfaceDigest: "forged-decision-surface",
      };
      const validRecord = consentRecord(genuine, { analytics: "granted" });

      const result = reconcileConsentPolicy({
        currentPolicy: forged,
        now: variant === "invalid-time" ? Number.NaN : 2_000,
        policyHistory: [],
        record:
          variant === "malformed-record"
            ? { ...validRecord, decisions: [{ purposeId: "analytics" }] }
            : validRecord,
      } as never);

      expect(result.issues[0]).toEqual({
        code: "invalid-policy-snapshot",
        path: "currentPolicy",
      });
      expect(result.policy).toMatchObject({
        catalogueDigest: genuine.catalogueDigest,
        decisionSurfaceDigest: genuine.decisionSurfaceDigest,
      });
      expect(result.decisions.some(({ value }) => value === "granted")).toBe(
        false,
      );
    },
  );

  it("verifies every captured history identity before malformed-record exits", () => {
    const previous = policySnapshot("policy-1", [{ id: "analytics" }]);
    const current = policySnapshot("policy-2", [
      { disclosure: "Changed", id: "analytics" },
    ]);
    const forgedHistory = {
      ...previous,
      catalogueDigest: "forged-catalogue",
    };
    const record = consentRecord(previous, { analytics: "granted" });

    const result = reconcileConsentPolicy({
      currentPolicy: current,
      now: 2_000,
      policyHistory: [forgedHistory, previous],
      record: { ...record, decisions: [{ purposeId: "analytics" }] },
    } as never);

    expect(result.issues[0]).toEqual({
      code: "invalid-policy-snapshot",
      path: "policyHistory",
    });
    expect(result.decisions.some(({ value }) => value === "granted")).toBe(
      false,
    );
  });

  it("rejects a forged same-length identity without caller assertions", () => {
    const previous = policySnapshot("policy-1", [
      { disclosure: "old", id: "analytics" },
    ]);
    const current = policySnapshot("policy-1", [
      { disclosure: "new", id: "analytics" },
    ]);
    expect(current.catalogueDigest.length).toBe(
      previous.catalogueDigest.length,
    );
    const forgedCurrent = {
      ...current,
      catalogueDigest: previous.catalogueDigest,
      decisionSurfaceDigest: previous.decisionSurfaceDigest,
    };

    const result = reconcileConsentPolicy({
      currentPolicy: forgedCurrent,
      now: 2_000,
      policyHistory: [],
      record: consentRecord(previous, { analytics: "granted" }),
    });

    expect(result.status).toBe("invalid");
    expect(result.prompt).toBe(true);
    expect(result.issues).toEqual([
      { code: "invalid-policy-snapshot", path: "currentPolicy" },
    ]);
    expect(result.decisions.some(({ value }) => value === "granted")).toBe(
      false,
    );
  });

  it("does not read verifier-shaped reconciliation data", () => {
    const current = policySnapshot("policy-1", [{ id: "analytics" }]);
    const input = {
      currentPolicy: current,
      now: 2_000,
      policyHistory: [current],
      record: consentRecord(current, { analytics: "granted" }),
    };
    let verifierReads = 0;
    Object.defineProperty(input, "verifier", {
      get() {
        verifierReads += 1;
        throw new Error("verifier data must stay outside the boundary");
      },
    });

    expect(reconcileConsentPolicy(input).status).toBe("current");
    expect(verifierReads).toBe(0);
  });

  it("creates independent frozen reconciliation boundaries", () => {
    const first = createPolicyReconciler();
    const second = createPolicyReconciler();
    const current = policySnapshot("policy-1", [{ id: "analytics" }]);
    const input = {
      currentPolicy: current,
      now: 2_000,
      policyHistory: [current],
      record: consentRecord(current, { analytics: "granted" }),
    };

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    expect(first.reconcile(input)).toEqual(
      second.reconcile(structuredClone(input)),
    );
  });

  it("publishes only the bound reconciler factory", async () => {
    const application = await import("../index.js");
    const publicDomain = await import("../../domain.js");
    const publicReconciliation = await import("../../reconciliation.js");
    const publicRoot = await import("../../index.js");

    expect(Reflect.has(application, "createPolicyReconciler")).toBe(false);
    expect(Reflect.get(publicReconciliation, "createPolicyReconciler")).toBe(
      createPolicyReconciler,
    );
    expect(
      Reflect.has(publicReconciliation, "createPolicySnapshotVerifier"),
    ).toBe(false);
    expect(Reflect.has(publicReconciliation, "reconcileConsentPolicy")).toBe(
      false,
    );
    expect(Reflect.has(publicDomain, "isSupportedPolicyIdentity")).toBe(false);
    expect(Reflect.has(publicDomain, "planReconsent")).toBe(false);
    expect(Reflect.has(publicRoot, "createPolicyReconciler")).toBe(false);
    expect(Reflect.has(publicRoot, "isSupportedPolicyIdentity")).toBe(false);
  });
});
