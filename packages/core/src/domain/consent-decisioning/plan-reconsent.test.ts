import { describe, expect, it } from "vitest";

import {
  planReconsent,
  type ConsentPolicyChangeSetInput,
  type ConsentPolicyInput,
  type ConsentRecord,
} from "./index.js";

const previousPolicy = Object.freeze({
  catalogueDigest: "catalogue-v1",
  decisionSurfaceDigest: "surface-v1",
  policyVersion: "policy-v1",
});

const currentPolicy = Object.freeze({
  catalogueDigest: "catalogue-v2",
  decisionSurfaceDigest: "surface-v2",
  optionalPurposeIds: Object.freeze([
    "marketing",
    "functional",
    "advertising",
    "analytics",
  ]),
  policyVersion: "policy-v2",
}) satisfies ConsentPolicyInput;

const changeSet = Object.freeze({
  addedPurposeIds: Object.freeze(["marketing"]),
  affectedPurposes: Object.freeze([
    Object.freeze({
      purposeId: "analytics",
      reasonCodes: Object.freeze(["provider-changed"]),
    }),
    Object.freeze({
      purposeId: "advertising",
      reasonCodes: Object.freeze(["retention-changed"]),
    }),
  ]),
  currentIdentity: Object.freeze({
    catalogueDigest: "catalogue-v2",
    decisionSurfaceDigest: "surface-v2",
    policyVersion: "policy-v2",
  }),
  previousIdentity: previousPolicy,
  removedPurposeIds: Object.freeze(["legacy"]),
}) satisfies ConsentPolicyChangeSetInput;

const record = Object.freeze({
  decidedAt: 1_000,
  decisions: Object.freeze([
    Object.freeze({ purposeId: "legacy", value: "granted" as const }),
    Object.freeze({ purposeId: "functional", value: "granted" as const }),
    Object.freeze({ purposeId: "advertising", value: "denied" as const }),
    Object.freeze({ purposeId: "analytics", value: "granted" as const }),
  ]),
  expiresAt: 2_000,
  method: "granular" as const,
  policy: previousPolicy,
  recordId: "record-1",
  revision: 3,
  schemaVersion: 1 as const,
}) satisfies ConsentRecord;

describe("planReconsent", () => {
  it("carries safe decisions and selectively unresolves changed grants", () => {
    const before = structuredClone(record);
    const result = planReconsent(record, currentPolicy, changeSet);

    expect(result).toEqual({
      affectedPurposes: [
        { purposeId: "advertising", reasonCodes: ["retention-changed"] },
        { purposeId: "analytics", reasonCodes: ["provider-changed"] },
        { purposeId: "marketing", reasonCodes: ["purpose-added"] },
      ],
      decisions: [
        { purposeId: "advertising", value: "denied" },
        { purposeId: "analytics", value: "unresolved" },
        { purposeId: "functional", value: "granted" },
        { purposeId: "marketing", value: "unresolved" },
      ],
      issues: [],
      policy: {
        catalogueDigest: "catalogue-v2",
        decisionSurfaceDigest: "surface-v2",
        policyVersion: "policy-v2",
      },
      prompt: true,
      status: "requires-reconsent",
    });
    expect(record).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Object.isFrozen(result.decisions[0])).toBe(true);
    expect(Object.isFrozen(result.affectedPurposes[0]?.reasonCodes)).toBe(true);
  });

  it("fails closed when the change-set identities do not match", () => {
    const mismatchedChangeSet = {
      ...changeSet,
      currentIdentity: {
        ...changeSet.currentIdentity,
        decisionSurfaceDigest: "wrong-surface",
      },
    } satisfies ConsentPolicyChangeSetInput;

    expect(planReconsent(record, currentPolicy, mismatchedChangeSet)).toEqual({
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["identity-unverified"] },
        { purposeId: "functional", reasonCodes: ["identity-unverified"] },
        { purposeId: "marketing", reasonCodes: ["identity-unverified"] },
      ],
      decisions: [
        { purposeId: "advertising", value: "denied" },
        { purposeId: "analytics", value: "unresolved" },
        { purposeId: "functional", value: "unresolved" },
        { purposeId: "marketing", value: "unresolved" },
      ],
      issues: [
        {
          code: "policy-change-identity-mismatch",
          path: "changeSet.currentIdentity",
        },
      ],
      policy: {
        catalogueDigest: "catalogue-v2",
        decisionSurfaceDigest: "surface-v2",
        policyVersion: "policy-v2",
      },
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed when a change set omits an actual purpose addition", () => {
    const incomplete = {
      ...changeSet,
      addedPurposeIds: [],
    } satisfies ConsentPolicyChangeSetInput;

    expect(planReconsent(record, currentPolicy, incomplete)).toMatchObject({
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["identity-unverified"] },
        { purposeId: "functional", reasonCodes: ["identity-unverified"] },
        { purposeId: "marketing", reasonCodes: ["identity-unverified"] },
      ],
      issues: [
        {
          code: "policy-change-set-incomplete",
          path: "changeSet.addedPurposeIds",
        },
      ],
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed when a change set omits an actual purpose removal", () => {
    const incomplete = {
      ...changeSet,
      removedPurposeIds: [],
    } satisfies ConsentPolicyChangeSetInput;

    expect(planReconsent(record, currentPolicy, incomplete)).toMatchObject({
      issues: [
        {
          code: "policy-change-set-incomplete",
          path: "changeSet.removedPurposeIds",
        },
      ],
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed when a changed decision surface declares no affected purpose", () => {
    const singlePurposeRecord = {
      ...record,
      decisions: [{ purposeId: "analytics", value: "granted" as const }],
    } satisfies ConsentRecord;
    const changedPolicy = {
      catalogueDigest: "catalogue-v2",
      decisionSurfaceDigest: "surface-v2",
      optionalPurposeIds: ["analytics"],
      policyVersion: "policy-v2",
    } satisfies ConsentPolicyInput;
    const incomplete = {
      addedPurposeIds: [],
      affectedPurposes: [],
      currentIdentity: {
        catalogueDigest: changedPolicy.catalogueDigest,
        decisionSurfaceDigest: changedPolicy.decisionSurfaceDigest,
        policyVersion: changedPolicy.policyVersion,
      },
      previousIdentity: previousPolicy,
      removedPurposeIds: [],
    } satisfies ConsentPolicyChangeSetInput;

    expect(
      planReconsent(singlePurposeRecord, changedPolicy, incomplete),
    ).toEqual({
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["identity-unverified"] },
      ],
      decisions: [{ purposeId: "analytics", value: "unresolved" }],
      issues: [
        {
          code: "policy-change-set-incomplete",
          path: "changeSet.affectedPurposes",
        },
      ],
      policy: {
        catalogueDigest: "catalogue-v2",
        decisionSurfaceDigest: "surface-v2",
        policyVersion: "policy-v2",
      },
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed when a changed decision surface names only an unknown affected purpose", () => {
    const singlePurposeRecord = {
      ...record,
      decisions: [{ purposeId: "analytics", value: "granted" as const }],
    } satisfies ConsentRecord;
    const changedPolicy = {
      catalogueDigest: "catalogue-v2",
      decisionSurfaceDigest: "surface-v2",
      optionalPurposeIds: ["analytics"],
      policyVersion: "policy-v2",
    } satisfies ConsentPolicyInput;
    const incomplete = {
      addedPurposeIds: [],
      affectedPurposes: [
        { purposeId: "ghost", reasonCodes: ["provider-changed"] },
      ],
      currentIdentity: {
        catalogueDigest: changedPolicy.catalogueDigest,
        decisionSurfaceDigest: changedPolicy.decisionSurfaceDigest,
        policyVersion: changedPolicy.policyVersion,
      },
      previousIdentity: previousPolicy,
      removedPurposeIds: [],
    } satisfies ConsentPolicyChangeSetInput;

    expect(
      planReconsent(singlePurposeRecord, changedPolicy, incomplete),
    ).toEqual({
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["identity-unverified"] },
      ],
      decisions: [{ purposeId: "analytics", value: "unresolved" }],
      issues: [
        {
          code: "policy-change-set-incomplete",
          path: "changeSet.affectedPurposes",
        },
      ],
      policy: {
        catalogueDigest: "catalogue-v2",
        decisionSurfaceDigest: "surface-v2",
        policyVersion: "policy-v2",
      },
      prompt: true,
      status: "invalid",
    });
  });

  it("fails closed when affected purposes mix current and unknown identifiers", () => {
    const singlePurposeRecord = {
      ...record,
      decisions: [{ purposeId: "analytics", value: "granted" as const }],
    } satisfies ConsentRecord;
    const changedPolicy = {
      catalogueDigest: "catalogue-v2",
      decisionSurfaceDigest: "surface-v2",
      optionalPurposeIds: ["analytics"],
      policyVersion: "policy-v2",
    } satisfies ConsentPolicyInput;
    const incomplete = {
      addedPurposeIds: [],
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["meaning-changed"] },
        { purposeId: "ghost", reasonCodes: ["provider-changed"] },
      ],
      currentIdentity: {
        catalogueDigest: changedPolicy.catalogueDigest,
        decisionSurfaceDigest: changedPolicy.decisionSurfaceDigest,
        policyVersion: changedPolicy.policyVersion,
      },
      previousIdentity: previousPolicy,
      removedPurposeIds: [],
    } satisfies ConsentPolicyChangeSetInput;

    expect(
      planReconsent(singlePurposeRecord, changedPolicy, incomplete),
    ).toMatchObject({
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["identity-unverified"] },
      ],
      decisions: [{ purposeId: "analytics", value: "unresolved" }],
      issues: [
        {
          code: "policy-change-set-incomplete",
          path: "changeSet.affectedPurposes",
        },
      ],
      prompt: true,
      status: "invalid",
    });
  });

  it("accepts a complete affected-purpose declaration for an unchanged purpose set", () => {
    const singlePurposeRecord = {
      ...record,
      decisions: [{ purposeId: "analytics", value: "granted" as const }],
    } satisfies ConsentRecord;
    const changedPolicy = {
      catalogueDigest: "catalogue-v2",
      decisionSurfaceDigest: "surface-v2",
      optionalPurposeIds: ["analytics"],
      policyVersion: "policy-v2",
    } satisfies ConsentPolicyInput;

    expect(
      planReconsent(singlePurposeRecord, changedPolicy, {
        addedPurposeIds: [],
        affectedPurposes: [
          { purposeId: "analytics", reasonCodes: ["meaning-changed"] },
        ],
        currentIdentity: {
          catalogueDigest: changedPolicy.catalogueDigest,
          decisionSurfaceDigest: changedPolicy.decisionSurfaceDigest,
          policyVersion: changedPolicy.policyVersion,
        },
        previousIdentity: previousPolicy,
        removedPurposeIds: [],
      }),
    ).toMatchObject({
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["meaning-changed"] },
      ],
      decisions: [{ purposeId: "analytics", value: "unresolved" }],
      issues: [],
      prompt: true,
      status: "requires-reconsent",
    });
  });

  it("accepts an explicit editorial-only change set without affected purposes", () => {
    const editorialPolicy = {
      ...previousPolicy,
      catalogueDigest: "catalogue-editorial-v2",
      optionalPurposeIds: record.decisions.map(({ purposeId }) => purposeId),
    } satisfies ConsentPolicyInput;

    expect(
      planReconsent(record, editorialPolicy, {
        addedPurposeIds: [],
        affectedPurposes: [],
        currentIdentity: editorialPolicy,
        previousIdentity: previousPolicy,
        removedPurposeIds: [],
      }),
    ).toMatchObject({
      affectedPurposes: [],
      issues: [],
      prompt: false,
      status: "current",
    });
  });

  it("fails closed when an identity change has no verified change set", () => {
    const result = planReconsent(record, currentPolicy);

    expect(result.status).toBe("invalid");
    expect(result.issues).toEqual([
      { code: "policy-change-set-missing", path: "changeSet" },
    ]);
    expect(result.decisions).toEqual([
      { purposeId: "advertising", value: "denied" },
      { purposeId: "analytics", value: "unresolved" },
      { purposeId: "functional", value: "unresolved" },
      { purposeId: "marketing", value: "unresolved" },
    ]);
  });

  it("keeps a withdrawn record resolved without prompting for additions", () => {
    const withdrawn = {
      ...record,
      decisions: record.decisions.map((decision) => ({
        ...decision,
        value: "denied" as const,
      })),
      method: "withdrawal" as const,
      withdrawnAt: 1_500,
    } satisfies ConsentRecord;

    const result = planReconsent(withdrawn, currentPolicy, changeSet);

    expect(result.status).toBe("withdrawn");
    expect(result.prompt).toBe(false);
    expect(result.decisions).toEqual([
      { purposeId: "advertising", value: "denied" },
      { purposeId: "analytics", value: "denied" },
      { purposeId: "functional", value: "denied" },
      { purposeId: "marketing", value: "unresolved" },
    ]);
  });

  it("keeps a matching complete record current without a change set", () => {
    const currentRecord = {
      ...record,
      decisions: currentPolicy.optionalPurposeIds.map((purposeId) => ({
        purposeId,
        value: "denied" as const,
      })),
      policy: {
        catalogueDigest: currentPolicy.catalogueDigest,
        decisionSurfaceDigest: currentPolicy.decisionSurfaceDigest,
        policyVersion: currentPolicy.policyVersion,
      },
    } satisfies ConsentRecord;

    expect(planReconsent(currentRecord, currentPolicy)).toMatchObject({
      affectedPurposes: [],
      issues: [],
      prompt: false,
      status: "current",
    });
  });

  it("keeps decisions current across an editorial-only catalogue revision", () => {
    const editorialPolicy = {
      ...previousPolicy,
      catalogueDigest: "catalogue-editorial-v2",
      optionalPurposeIds: record.decisions.map(({ purposeId }) => purposeId),
    } satisfies ConsentPolicyInput;

    expect(planReconsent(record, editorialPolicy)).toMatchObject({
      affectedPurposes: [],
      issues: [],
      prompt: false,
      status: "current",
    });
  });

  it("accepts a material change after an intervening editorial revision", () => {
    const afterEditorialChangeSet = {
      ...changeSet,
      previousIdentity: {
        ...changeSet.previousIdentity,
        catalogueDigest: "catalogue-editorial-v2",
      },
    } satisfies ConsentPolicyChangeSetInput;

    expect(
      planReconsent(record, currentPolicy, afterEditorialChangeSet),
    ).toMatchObject({
      decisions: [
        { purposeId: "advertising", value: "denied" },
        { purposeId: "analytics", value: "unresolved" },
        { purposeId: "functional", value: "granted" },
        { purposeId: "marketing", value: "unresolved" },
      ],
      issues: [],
      prompt: true,
      status: "requires-reconsent",
    });
  });

  it("requires a change set when an editorial identity changes the purpose set", () => {
    const unexplainedPolicy = {
      ...previousPolicy,
      catalogueDigest: "catalogue-unexplained-v2",
      optionalPurposeIds: [
        ...record.decisions.map(({ purposeId }) => purposeId),
        "new-purpose",
      ],
    } satisfies ConsentPolicyInput;

    expect(planReconsent(record, unexplainedPolicy)).toMatchObject({
      affectedPurposes: [
        { purposeId: "analytics", reasonCodes: ["identity-unverified"] },
        { purposeId: "functional", reasonCodes: ["identity-unverified"] },
        { purposeId: "legacy", reasonCodes: ["identity-unverified"] },
        { purposeId: "new-purpose", reasonCodes: ["identity-unverified"] },
      ],
      issues: [{ code: "policy-change-set-missing", path: "changeSet" }],
      prompt: true,
      status: "invalid",
    });

    const withdrawn = {
      ...record,
      decisions: record.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      method: "withdrawal" as const,
      withdrawnAt: 1_500,
    } satisfies ConsentRecord;
    expect(planReconsent(withdrawn, unexplainedPolicy)).toMatchObject({
      affectedPurposes: [
        { purposeId: "new-purpose", reasonCodes: ["identity-unverified"] },
      ],
      decisions: [
        { purposeId: "advertising", value: "denied" },
        { purposeId: "analytics", value: "denied" },
        { purposeId: "functional", value: "denied" },
        { purposeId: "legacy", value: "denied" },
        { purposeId: "new-purpose", value: "unresolved" },
      ],
      issues: [{ code: "policy-change-set-missing", path: "changeSet" }],
      prompt: false,
      status: "withdrawn",
    });
  });

  it("requires reconsent when a matching policy contains an unresolved purpose", () => {
    const incompleteRecord = {
      ...record,
      decisions: [
        { purposeId: "advertising", value: "denied" as const },
        { purposeId: "analytics", value: "granted" as const },
        { purposeId: "functional", value: "granted" as const },
      ],
      policy: {
        catalogueDigest: currentPolicy.catalogueDigest,
        decisionSurfaceDigest: currentPolicy.decisionSurfaceDigest,
        policyVersion: currentPolicy.policyVersion,
      },
    } satisfies ConsentRecord;

    const result = planReconsent(incompleteRecord, currentPolicy);

    expect(result.decisions).toContainEqual({
      purposeId: "marketing",
      value: "unresolved",
    });
    expect(result.prompt).toBe(true);
    expect(result.status).toBe("requires-reconsent");
  });

  it("keeps affected denials current when no purpose needs a new grant", () => {
    const denialOnlyPolicy = {
      ...currentPolicy,
      optionalPurposeIds: ["functional", "advertising"],
    } satisfies ConsentPolicyInput;
    const denialOnlyChangeSet = {
      ...changeSet,
      addedPurposeIds: [],
      affectedPurposes: [
        { purposeId: "advertising", reasonCodes: ["retention-changed"] },
      ],
      removedPurposeIds: ["analytics", "legacy"],
    } satisfies ConsentPolicyChangeSetInput;

    expect(
      planReconsent(record, denialOnlyPolicy, denialOnlyChangeSet),
    ).toMatchObject({
      decisions: [
        { purposeId: "advertising", value: "denied" },
        { purposeId: "functional", value: "granted" },
      ],
      prompt: false,
      status: "current",
    });
  });

  it("orders reason codes by locale-independent code units", () => {
    const unicodeChangeSet = {
      ...changeSet,
      affectedPurposes: [
        {
          purposeId: "analytics",
          reasonCodes: ["ä", "z", "A"],
        },
      ],
    } satisfies ConsentPolicyChangeSetInput;

    expect(
      planReconsent(record, currentPolicy, unicodeChangeSet).affectedPurposes[0]
        ?.reasonCodes,
    ).toEqual(["A", "z", "ä"]);
  });

  it("fails closed on a mismatched previous identity without prompting a withdrawal", () => {
    const withdrawn = {
      ...record,
      decisions: record.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      method: "withdrawal" as const,
      withdrawnAt: 1_500,
    } satisfies ConsentRecord;
    const mismatched = {
      ...changeSet,
      previousIdentity: {
        ...changeSet.previousIdentity,
        policyVersion: "wrong-previous-version",
      },
    } satisfies ConsentPolicyChangeSetInput;

    expect(planReconsent(withdrawn, currentPolicy, mismatched)).toMatchObject({
      affectedPurposes: [
        { purposeId: "marketing", reasonCodes: ["identity-unverified"] },
      ],
      decisions: [
        { purposeId: "advertising", value: "denied" },
        { purposeId: "analytics", value: "denied" },
        { purposeId: "functional", value: "denied" },
        { purposeId: "marketing", value: "unresolved" },
      ],
      issues: [
        {
          code: "policy-change-identity-mismatch",
          path: "changeSet.previousIdentity",
        },
      ],
      prompt: false,
      status: "withdrawn",
    });
  });
});
