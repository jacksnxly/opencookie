import { describe, expect, it } from "vitest";

import {
  recordConsentDecision,
  type ConsentPolicyInput,
  type RecordDecisionCommand,
} from "./index.js";

const policy = Object.freeze({
  catalogueDigest: "catalogue-v1",
  decisionSurfaceDigest: "surface-v1",
  optionalPurposeIds: Object.freeze(["marketing", "analytics", "functional"]),
  policyVersion: "policy-v1",
}) satisfies ConsentPolicyInput;

const baseCommand = {
  decidedAt: 1_000,
  expiresAt: 2_000,
  recordId: "record-1",
} as const;

function expectChanged(result: ReturnType<typeof recordConsentDecision>) {
  if (!result.ok || result.outcome !== "changed") {
    throw new Error("expected a changed consent record");
  }
  return result.record;
}

describe("recordConsentDecision", () => {
  it("orders non-ASCII purpose identifiers by runtime-independent code units", () => {
    const ordered = expectChanged(
      recordConsentDecision(
        undefined,
        {
          ...policy,
          optionalPurposeIds: ["äther", "zeta"],
        },
        { ...baseCommand, method: "accept-all" },
      ),
    );

    expect(ordered.decisions.map(({ purposeId }) => purposeId)).toEqual([
      "zeta",
      "äther",
    ]);
  });

  it("TEST-ACCEPT-ALL-PURPOSE-SET covers the same complete set for accept and reject", () => {
    const accept = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    const reject = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "reject-all",
      }),
    );

    expect(accept.decisions).toEqual([
      { purposeId: "analytics", value: "granted" },
      { purposeId: "functional", value: "granted" },
      { purposeId: "marketing", value: "granted" },
    ]);
    expect(reject.decisions).toEqual([
      { purposeId: "analytics", value: "denied" },
      { purposeId: "functional", value: "denied" },
      { purposeId: "marketing", value: "denied" },
    ]);
    expect(accept.decisions.map(({ purposeId }) => purposeId)).toEqual(
      reject.decisions.map(({ purposeId }) => purposeId),
    );
    expect(accept.revision).toBe(1);
    expect(Object.isFrozen(accept)).toBe(true);
    expect(Object.isFrozen(accept.decisions)).toBe(true);
    expect(Object.isFrozen(accept.decisions[0])).toBe(true);
  });

  it("denies granular omissions without mutating the supplied selection", () => {
    const grantedPurposeIds = ["marketing", "analytics"];
    const before = structuredClone(grantedPurposeIds);
    const result = recordConsentDecision(undefined, policy, {
      ...baseCommand,
      grantedPurposeIds,
      method: "granular",
    });

    expect(expectChanged(result).decisions).toEqual([
      { purposeId: "analytics", value: "granted" },
      { purposeId: "functional", value: "denied" },
      { purposeId: "marketing", value: "granted" },
    ]);
    expect(grantedPurposeIds).toEqual(before);
  });

  it("rejects unknown granular purpose identifiers with stable paths", () => {
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        grantedPurposeIds: ["analytics", "unknown", "also-unknown"],
        method: "granular",
      }),
    ).toEqual({
      issues: [
        {
          code: "unknown-purpose-id",
          path: "grantedPurposeIds[1]",
          purposeId: "unknown",
        },
        {
          code: "unknown-purpose-id",
          path: "grantedPurposeIds[2]",
          purposeId: "also-unknown",
        },
      ],
      ok: false,
    });
  });

  it("returns unchanged when a command repeats the effective decisions", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    const mutableCurrent = structuredClone(current);

    const result = recordConsentDecision(mutableCurrent, policy, {
      ...baseCommand,
      decidedAt: 1_500,
      expiresAt: 9_999,
      grantedPurposeIds: ["functional", "analytics", "marketing"],
      method: "granular",
    });

    expect(result).toEqual({
      ok: true,
      outcome: "unchanged",
      record: current,
    });
    if (!result.ok) throw new Error("repeat must be accepted");
    expect(result.record).toEqual(current);
    expect(result.record).not.toBe(mutableCurrent);
    expect(result.record.revision).toBe(1);
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(Object.isFrozen(result.record.decisions)).toBe(true);
    expect(Object.isFrozen(result.record.decisions[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("canonicalizes unchanged records without retaining aliased foreign decision fields", () => {
    const created = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    const extra = { tag: "before" };
    const current = {
      ...created,
      decisions: created.decisions.map((decision) => ({ ...decision, extra })),
    };

    const result = recordConsentDecision(current, policy, {
      ...baseCommand,
      decidedAt: 1_500,
      method: "accept-all",
    });
    if (!result.ok) throw new Error("unchanged record must be accepted");
    extra.tag = "after";

    expect(result.outcome).toBe("unchanged");
    expect(result.record.decisions[0]).toEqual({
      purposeId: "analytics",
      value: "granted",
    });
    expect(result.record.decisions[0]).not.toHaveProperty("extra");
  });

  it("creates a new explicit revision when repeated choices are no longer effective", () => {
    const expired = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    expect(
      recordConsentDecision(expired, policy, {
        decidedAt: expired.expiresAt,
        expiresAt: 3_000,
        method: "accept-all",
      }),
    ).toMatchObject({
      outcome: "changed",
      record: { decidedAt: 2_000, revision: 2 },
    });

    const withdrawn = {
      ...expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "reject-all",
        }),
      ),
      method: "withdrawal" as const,
      revision: 2,
      withdrawnAt: 1_500,
    };
    expect(
      recordConsentDecision(withdrawn, policy, {
        decidedAt: 1_700,
        expiresAt: 2_700,
        method: "reject-all",
      }),
    ).toMatchObject({
      outcome: "changed",
      record: { method: "reject-all", revision: 3 },
    });
  });

  it("rejects a decision before the current aggregate transition", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    expect(
      recordConsentDecision(current, policy, {
        decidedAt: current.decidedAt - 1,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [
        { code: "decision-before-current-transition", path: "decidedAt" },
      ],
      ok: false,
    });

    const withdrawn = {
      ...current,
      decisions: current.decisions.map(({ purposeId }) => ({
        purposeId,
        value: "denied" as const,
      })),
      method: "withdrawal" as const,
      revision: 2,
      withdrawnAt: 1_500,
    };
    expect(
      recordConsentDecision(withdrawn, policy, {
        decidedAt: 1_499,
        expiresAt: 3_000,
        method: "accept-all",
      }),
    ).toEqual({
      issues: [
        { code: "decision-before-current-transition", path: "decidedAt" },
      ],
      ok: false,
    });
  });

  it("rejects a current aggregate whose revision or transition time cannot advance", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "reject-all",
      }),
    );

    expect(
      recordConsentDecision(
        { ...current, revision: Number.MAX_SAFE_INTEGER },
        policy,
        {
          decidedAt: 1_500,
          expiresAt: 3_000,
          method: "accept-all",
        },
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.revision" }],
      ok: false,
    });

    expect(
      recordConsentDecision(
        {
          ...current,
          method: "withdrawal",
          revision: 2,
          withdrawnAt: Number.NaN,
        },
        policy,
        {
          decidedAt: current.decidedAt - 1,
          expiresAt: 3_000,
          method: "accept-all",
        },
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.withdrawnAt" }],
      ok: false,
    });
  });

  it("rejects an accessor-backed revision before it can overflow", () => {
    const created = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    let revisionReads = 0;
    const current = { ...created };
    Object.defineProperty(current, "revision", {
      enumerable: true,
      get: () => {
        revisionReads += 1;
        return revisionReads <= 2
          ? Number.MAX_SAFE_INTEGER - 1
          : Number.MAX_SAFE_INTEGER;
      },
    });

    expect(
      recordConsentDecision(current, policy, {
        decidedAt: 1_500,
        expiresAt: 2_500,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.revision" }],
      ok: false,
    });
    expect(revisionReads).toBe(0);
  });

  it.each([
    ["current.decidedAt", 1_000.5],
    ["current.decidedAt", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("rejects an unsafe %s timestamp: %s", (path, decidedAt) => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );

    expect(
      recordConsentDecision({ ...current, decidedAt }, policy, {
        decidedAt: 1_500,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path }],
      ok: false,
    });
  });

  it.each([2_000.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe current.expiresAt timestamp: %s",
    (expiresAt) => {
      const current = expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "accept-all",
        }),
      );

      expect(
        recordConsentDecision({ ...current, expiresAt }, policy, {
          decidedAt: 1_500,
          expiresAt: 3_000,
          method: "reject-all",
        }),
      ).toEqual({
        issues: [{ code: "invalid-current-record", path: "current.expiresAt" }],
        ok: false,
      });
    },
  );

  it("rejects a current aggregate without a positive decision interval", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );

    expect(
      recordConsentDecision(
        { ...current, expiresAt: current.decidedAt },
        policy,
        {
          decidedAt: 1_500,
          expiresAt: 3_000,
          method: "reject-all",
        },
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.expiresAt" }],
      ok: false,
    });
  });

  it.each([1_500.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe current.withdrawnAt timestamp: %s",
    (withdrawnAt) => {
      const current = expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "reject-all",
        }),
      );

      expect(
        recordConsentDecision(
          {
            ...current,
            method: "withdrawal",
            revision: 2,
            withdrawnAt,
          },
          policy,
          {
            decidedAt: 2_000,
            expiresAt: 3_000,
            method: "accept-all",
          },
        ),
      ).toEqual({
        issues: [
          { code: "invalid-current-record", path: "current.withdrawnAt" },
        ],
        ok: false,
      });
    },
  );

  it("rejects a current withdrawal aggregate containing a grant", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );

    expect(
      recordConsentDecision(
        {
          ...current,
          decisions: current.decisions.map((decision, index) => ({
            ...decision,
            value: index === 0 ? ("denied" as const) : decision.value,
          })),
          method: "withdrawal",
          revision: 2,
          withdrawnAt: 1_500,
        },
        policy,
        {
          decidedAt: 1_700,
          expiresAt: 3_000,
          method: "reject-all",
        },
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.decisions" }],
      ok: false,
    });
  });

  it.each([
    ["schema version", { schemaVersion: 2 }, "current.schemaVersion"],
    ["method", { method: "forged" }, "current.method"],
    ["decision collection", { decisions: null }, "current.decisions"],
    [
      "sparse decision collection",
      {
        decisions: Object.assign(new Array(3), {
          0: { purposeId: "analytics", value: "granted" },
          2: { purposeId: "marketing", value: "denied" },
        }),
      },
      "current.decisions",
    ],
    ["decision entry", { decisions: [null] }, "current.decisions"],
    [
      "duplicate purpose",
      {
        decisions: [
          { purposeId: "analytics", value: "granted" },
          { purposeId: "analytics", value: "denied" },
        ],
      },
      "current.decisions",
    ],
    [
      "blank purpose",
      { decisions: [{ purposeId: " ", value: "granted" }] },
      "current.decisions",
    ],
    [
      "decision value",
      { decisions: [{ purposeId: "analytics", value: "forged" }] },
      "current.decisions",
    ],
    ["policy identity", { policy: null }, "current.policy"],
    [
      "policy identity field",
      {
        policy: {
          catalogueDigest: "catalogue-v1",
          decisionSurfaceDigest: "surface-v1",
          policyVersion: 2,
        },
      },
      "current.policy",
    ],
    ["record identifier", { recordId: " " }, "current.recordId"],
    ["consent identifier", { consentId: " " }, "current.consentId"],
    ["locale", { locale: 42 }, "current.locale"],
  ] as const)(
    "rejects a malformed current %s without throwing",
    (_case, overrides, path) => {
      const current = expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "accept-all",
        }),
      );

      expect(
        recordConsentDecision(
          { ...current, ...overrides } as unknown as typeof current,
          policy,
          {
            decidedAt: 1_500,
            expiresAt: 3_000,
            method: "reject-all",
          },
        ),
      ).toEqual({
        issues: [{ code: "invalid-current-record", path }],
        ok: false,
      });
    },
  );

  it("creates the final safe revision from an advanceable current record", () => {
    const current = {
      ...expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "accept-all",
        }),
      ),
      revision: Number.MAX_SAFE_INTEGER - 1,
    };

    expect(
      recordConsentDecision(current, policy, {
        decidedAt: 1_500,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).toMatchObject({
      ok: true,
      outcome: "changed",
      record: { revision: Number.MAX_SAFE_INTEGER },
    });
  });

  it("rejects a symbolic current decision count without throwing", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    const decisions = new Proxy([...current.decisions], {
      getOwnPropertyDescriptor: (target, property) =>
        property === "length"
          ? {
              configurable: false,
              enumerable: false,
              value: Symbol("hostile-length"),
              writable: true,
            }
          : Reflect.getOwnPropertyDescriptor(target, property),
    });

    expect(() =>
      recordConsentDecision({ ...current, decisions }, policy, {
        decidedAt: 1_500,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).not.toThrow();
    expect(
      recordConsentDecision({ ...current, decisions }, policy, {
        decidedAt: 1_500,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.decisions" }],
      ok: false,
    });
  });

  it("rejects a huge current decision count before reading indexed entries", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    let indexedReads = 0;
    const decisions = new Proxy([...current.decisions], {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "length") {
          return {
            configurable: false,
            enumerable: false,
            value: 1_000_000_000,
            writable: true,
          };
        }
        if (typeof property === "string" && /^\d+$/.test(property)) {
          indexedReads += 1;
          return {
            configurable: true,
            enumerable: true,
            value: current.decisions[0],
            writable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(
      recordConsentDecision({ ...current, decisions }, policy, {
        decidedAt: 1_500,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.decisions" }],
      ok: false,
    });
    expect(indexedReads).toBe(0);
  });

  it.each([null, [], 42] as const)(
    "rejects a non-record current aggregate %s",
    (current) => {
      expect(
        recordConsentDecision(
          current as unknown as Parameters<typeof recordConsentDecision>[0],
          policy,
          {
            decidedAt: 1_500,
            expiresAt: 3_000,
            method: "reject-all",
          },
        ),
      ).toEqual({
        issues: [{ code: "invalid-current-record", path: "current" }],
        ok: false,
      });
    },
  );

  it.each([-1, 1.5])(
    "rejects an invalid current decision count %s",
    (length) => {
      const current = expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "accept-all",
        }),
      );
      const decisions = new Proxy([...current.decisions], {
        getOwnPropertyDescriptor: (target, property) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          return property === "length" && descriptor !== undefined
            ? { ...descriptor, value: length }
            : descriptor;
        },
      });

      expect(
        recordConsentDecision({ ...current, decisions }, policy, {
          decidedAt: 1_500,
          expiresAt: 3_000,
          method: "reject-all",
        }),
      ).toEqual({
        issues: [{ code: "invalid-current-record", path: "current.decisions" }],
        ok: false,
      });
    },
  );

  it("accepts an empty current decision collection as structurally valid", () => {
    const current = {
      ...expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "accept-all",
        }),
      ),
      decisions: [],
    };

    expect(
      recordConsentDecision(current, policy, {
        decidedAt: 1_500,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).toMatchObject({ ok: true, outcome: "changed" });
  });

  it.each([
    "catalogueDigest",
    "decisionSurfaceDigest",
    "policyVersion",
  ] as const)("rejects a blank current policy %s", (field) => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );

    expect(
      recordConsentDecision(
        { ...current, policy: { ...current.policy, [field]: " " } },
        policy,
        {
          decidedAt: 1_500,
          expiresAt: 3_000,
          method: "reject-all",
        },
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.policy" }],
      ok: false,
    });
  });

  it.each(["purposeId", "value"] as const)(
    "rejects an accessor-backed current decision %s without invoking it",
    (field) => {
      const current = expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "accept-all",
        }),
      );
      let reads = 0;
      const currentDecision = current.decisions[0];
      if (currentDecision === undefined) {
        throw new Error("Current decision fixture must be complete.");
      }
      const decision = { ...currentDecision };
      Object.defineProperty(decision, field, {
        get: () => {
          reads += 1;
          return currentDecision[field];
        },
      });

      expect(
        recordConsentDecision({ ...current, decisions: [decision] }, policy, {
          decidedAt: 1_500,
          expiresAt: 3_000,
          method: "reject-all",
        }),
      ).toEqual({
        issues: [{ code: "invalid-current-record", path: "current.decisions" }],
        ok: false,
      });
      expect(reads).toBe(0);
    },
  );

  it("rejects throwing current aggregate and decision descriptors", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    const throwingRoot = new Proxy(current, {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "schemaVersion") throw new Error("root trap");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const throwingDecisions = new Proxy([...current.decisions], {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "0") throw new Error("entry trap");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(
      recordConsentDecision(throwingRoot, policy, {
        decidedAt: 1_500,
        expiresAt: 3_000,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [
        { code: "invalid-current-record", path: "current.schemaVersion" },
      ],
      ok: false,
    });
    expect(
      recordConsentDecision(
        { ...current, decisions: throwingDecisions },
        policy,
        {
          decidedAt: 1_500,
          expiresAt: 3_000,
          method: "reject-all",
        },
      ),
    ).toEqual({
      issues: [{ code: "invalid-current-record", path: "current.decisions" }],
      ok: false,
    });
  });

  it("preserves explicit metadata and changes under a new policy identity", () => {
    const first = recordConsentDecision(undefined, policy, {
      ...baseCommand,
      consentId: "consent-1",
      locale: "en",
      method: "accept-all",
    });
    const current = expectChanged(first);
    const nextPolicy = { ...policy, policyVersion: "policy-v2" };
    const result = recordConsentDecision(current, nextPolicy, {
      decidedAt: 1_500,
      expiresAt: 2_500,
      method: "accept-all",
    });
    const changed = expectChanged(result);

    expect(changed).toMatchObject({
      consentId: "consent-1",
      locale: "en",
      policy: { policyVersion: "policy-v2" },
      revision: 2,
    });
  });

  it("does not create decision churn for an editorial-only catalogue revision", () => {
    const current = expectChanged(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    );
    const editorialPolicy = {
      ...policy,
      catalogueDigest: "catalogue-editorial-v2",
    };

    expect(
      recordConsentDecision(current, editorialPolicy, {
        ...baseCommand,
        decidedAt: 1_500,
        method: "accept-all",
      }),
    ).toMatchObject({
      outcome: "unchanged",
      record: { revision: 1 },
    });
  });

  it("changes an incomplete current record instead of treating it as equal", () => {
    const current = {
      ...expectChanged(
        recordConsentDecision(undefined, policy, {
          ...baseCommand,
          method: "accept-all",
        }),
      ),
      decisions: [{ purposeId: "analytics", value: "granted" as const }],
    };

    expect(
      recordConsentDecision(current, policy, {
        ...baseCommand,
        method: "accept-all",
      }),
    ).toMatchObject({ ok: true, outcome: "changed" });
  });

  it.each([undefined, "", "   "])(
    "rejects a missing record identifier %s",
    (recordId) => {
      expect(
        recordConsentDecision(undefined, policy, {
          decidedAt: 1_000,
          expiresAt: 2_000,
          method: "reject-all",
          ...(recordId === undefined ? {} : { recordId }),
        }),
      ).toEqual({
        issues: [{ code: "missing-record-id", path: "recordId" }],
        ok: false,
      });
    },
  );

  it("rejects unsafe timestamps and non-positive decision intervals", () => {
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        decidedAt: Number.NaN,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-timestamp", path: "decidedAt" }],
      ok: false,
    });
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        expiresAt: Number.POSITIVE_INFINITY,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-timestamp", path: "expiresAt" }],
      ok: false,
    });
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        decidedAt: 2_000,
        expiresAt: 2_000,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-decision-interval", path: "expiresAt" }],
      ok: false,
    });
  });

  it.each([
    [
      "decidedAt",
      [1_000, 1_000.5],
      { code: "invalid-timestamp", path: "decidedAt" },
    ],
    [
      "expiresAt",
      [2_000, 1_000],
      { code: "invalid-timestamp", path: "expiresAt" },
    ],
    [
      "method",
      ["accept-all", "forged"],
      { code: "invalid-decision-method", path: "method" },
    ],
  ] as const)(
    "rejects an accessor-backed %s without invoking or rereading it",
    (field, values, issue) => {
      let reads = 0;
      const command = { ...baseCommand, method: "accept-all" as const };
      Object.defineProperty(command, field, {
        enumerable: true,
        get: () => values[Math.min(reads++, values.length - 1)],
      });

      expect(
        recordConsentDecision(
          undefined,
          policy,
          command as RecordDecisionCommand,
        ),
      ).toEqual({ issues: [issue], ok: false });
      expect(reads).toBe(0);
    },
  );

  it("rejects an inherited decision method without invoking it", () => {
    let methodReads = 0;
    const prototype = {};
    Object.defineProperty(prototype, "method", {
      get: () => {
        methodReads += 1;
        return "accept-all";
      },
    });
    const command = Object.assign(Object.create(prototype) as object, {
      ...baseCommand,
    });

    expect(
      recordConsentDecision(
        undefined,
        policy,
        command as RecordDecisionCommand,
      ),
    ).toEqual({
      issues: [{ code: "invalid-decision-method", path: "method" }],
      ok: false,
    });
    expect(methodReads).toBe(0);
  });

  it("captures granular purpose entries without caller methods or iterators", () => {
    const grantedPurposeIds = ["unknown"];
    let flatMapCalls = 0;
    let iteratorCalls = 0;
    Object.defineProperties(grantedPurposeIds, {
      flatMap: {
        value: () => {
          flatMapCalls += 1;
          return [];
        },
      },
      [Symbol.iterator]: {
        value: function* () {
          iteratorCalls += 1;
          yield "analytics";
        },
      },
    });

    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        grantedPurposeIds,
        method: "granular",
      }),
    ).toEqual({
      issues: [
        {
          code: "unknown-purpose-id",
          path: "grantedPurposeIds[0]",
          purposeId: "unknown",
        },
      ],
      ok: false,
    });
    expect({ flatMapCalls, iteratorCalls }).toEqual({
      flatMapCalls: 0,
      iteratorCalls: 0,
    });
  });

  it.each([
    "catalogueDigest",
    "decisionSurfaceDigest",
    "policyVersion",
    "optionalPurposeIds",
  ] as const)(
    "rejects an accessor-backed policy %s without invoking it",
    (field) => {
      let reads = 0;
      const candidate = { ...policy };
      Object.defineProperty(candidate, field, {
        enumerable: true,
        get: () => {
          reads += 1;
          return policy[field];
        },
      });

      expect(
        recordConsentDecision(undefined, candidate, {
          ...baseCommand,
          method: "accept-all",
        }),
      ).toEqual({
        issues: [
          {
            code: "invalid-consent-policy",
            path: `policy.${field}`,
          },
        ],
        ok: false,
      });
      expect(reads).toBe(0);
    },
  );

  it("rejects an inherited policy identity without invoking it", () => {
    let digestReads = 0;
    const prototype = {};
    Object.defineProperty(prototype, "catalogueDigest", {
      get: () => {
        digestReads += 1;
        return policy.catalogueDigest;
      },
    });
    const candidate = Object.assign(Object.create(prototype) as object, {
      decisionSurfaceDigest: policy.decisionSurfaceDigest,
      optionalPurposeIds: policy.optionalPurposeIds,
      policyVersion: policy.policyVersion,
    });

    expect(
      recordConsentDecision(undefined, candidate as ConsentPolicyInput, {
        ...baseCommand,
        method: "accept-all",
      }),
    ).toEqual({
      issues: [
        {
          code: "invalid-consent-policy",
          path: "policy.catalogueDigest",
        },
      ],
      ok: false,
    });
    expect(digestReads).toBe(0);
  });

  it("captures policy purpose entries without caller iterators", () => {
    const optionalPurposeIds = ["actual"];
    let iteratorCalls = 0;
    Object.defineProperty(optionalPurposeIds, Symbol.iterator, {
      value: function* () {
        iteratorCalls += 1;
        yield "iterated";
      },
    });

    const result = recordConsentDecision(
      undefined,
      { ...policy, optionalPurposeIds },
      { ...baseCommand, method: "accept-all" },
    );

    expect(expectChanged(result).decisions).toEqual([
      { purposeId: "actual", value: "granted" },
    ]);
    expect(iteratorCalls).toBe(0);
  });

  it.each([
    ["blank identity", { catalogueDigest: " " }, "policy.catalogueDigest"],
    [
      "sparse purpose collection",
      { optionalPurposeIds: new Array<string>(1) },
      "policy.optionalPurposeIds",
    ],
  ] as const)("rejects a %s", (_case, override, path) => {
    expect(
      recordConsentDecision(
        undefined,
        { ...policy, ...override },
        { ...baseCommand, method: "accept-all" },
      ),
    ).toEqual({
      issues: [{ code: "invalid-consent-policy", path }],
      ok: false,
    });
  });

  it.each([
    ["null", null, "policy"],
    ["array", [], "policy"],
    ["number", 42, "policy"],
    [
      "blank decision surface",
      { ...policy, decisionSurfaceDigest: " " },
      "policy.decisionSurfaceDigest",
    ],
    [
      "blank policy version",
      { ...policy, policyVersion: " " },
      "policy.policyVersion",
    ],
    [
      "non-array purposes",
      { ...policy, optionalPurposeIds: null },
      "policy.optionalPurposeIds",
    ],
  ] as const)(
    "rejects a structurally invalid %s policy",
    (_case, value, path) => {
      expect(
        recordConsentDecision(
          undefined,
          value as unknown as ConsentPolicyInput,
          { ...baseCommand, method: "accept-all" },
        ),
      ).toEqual({
        issues: [{ code: "invalid-consent-policy", path }],
        ok: false,
      });
    },
  );

  it.each([Symbol("length"), -1, 1.5, 10_001])(
    "rejects an invalid policy purpose count %s",
    (length) => {
      const optionalPurposeIds = new Proxy(["analytics"], {
        getOwnPropertyDescriptor: (target, property) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          return property === "length" && descriptor !== undefined
            ? { ...descriptor, value: length }
            : descriptor;
        },
      });

      expect(
        recordConsentDecision(
          undefined,
          { ...policy, optionalPurposeIds },
          { ...baseCommand, method: "accept-all" },
        ),
      ).toEqual({
        issues: [
          {
            code: "invalid-consent-policy",
            path: "policy.optionalPurposeIds",
          },
        ],
        ok: false,
      });
    },
  );

  it("rejects revoked and throwing policy purpose collections", () => {
    const revoked = Proxy.revocable<string[]>([], {});
    revoked.revoke();
    const throwingLength = new Proxy(["analytics"], {
      getOwnPropertyDescriptor: (_target, property) => {
        if (property === "length") throw new Error("length trap");
        return undefined;
      },
    });
    const throwingEntry = new Proxy(["analytics"], {
      getOwnPropertyDescriptor: (target, property) => {
        if (property === "0") throw new Error("entry trap");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    for (const optionalPurposeIds of [
      revoked.proxy,
      throwingLength,
      throwingEntry,
    ]) {
      expect(
        recordConsentDecision(
          undefined,
          { ...policy, optionalPurposeIds },
          { ...baseCommand, method: "accept-all" },
        ),
      ).toEqual({
        issues: [
          {
            code: "invalid-consent-policy",
            path: "policy.optionalPurposeIds",
          },
        ],
        ok: false,
      });
    }
  });

  it("rejects an accessor-backed policy purpose without invoking it", () => {
    const optionalPurposeIds = ["analytics"];
    let reads = 0;
    Object.defineProperty(optionalPurposeIds, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return "analytics";
      },
    });

    expect(
      recordConsentDecision(
        undefined,
        { ...policy, optionalPurposeIds },
        { ...baseCommand, method: "accept-all" },
      ),
    ).toEqual({
      issues: [
        {
          code: "invalid-consent-policy",
          path: "policy.optionalPurposeIds",
        },
      ],
      ok: false,
    });
    expect(reads).toBe(0);
  });

  it("accepts an empty policy purpose collection", () => {
    expect(
      expectChanged(
        recordConsentDecision(
          undefined,
          { ...policy, optionalPurposeIds: [] },
          { ...baseCommand, method: "accept-all" },
        ),
      ).decisions,
    ).toEqual([]);
  });

  it.each([
    ["decidedAt", 1_000.5],
    ["decidedAt", Number.MIN_SAFE_INTEGER - 1],
    ["expiresAt", 2_000.5],
    ["expiresAt", Number.MAX_SAFE_INTEGER + 1],
  ] as const)("rejects an unsafe %s command timestamp: %s", (path, value) => {
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        [path]: value,
        method: "reject-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-timestamp", path }],
      ok: false,
    });
  });

  it("rejects malformed decision commands without throwing or creating invalid records", () => {
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "bogus",
      } as unknown as RecordDecisionCommand),
    ).toEqual({
      issues: [{ code: "invalid-decision-method", path: "method" }],
      ok: false,
    });
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        consentId: 42,
        method: "accept-all",
      } as unknown as RecordDecisionCommand),
    ).toEqual({
      issues: [{ code: "invalid-consent-id", path: "consentId" }],
      ok: false,
    });
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        consentId: "   ",
        method: "accept-all",
      }),
    ).toEqual({
      issues: [{ code: "invalid-consent-id", path: "consentId" }],
      ok: false,
    });
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        locale: 42,
        method: "accept-all",
      } as unknown as RecordDecisionCommand),
    ).toEqual({
      issues: [{ code: "invalid-locale", path: "locale" }],
      ok: false,
    });
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "reject-all",
        recordId: 42,
      } as unknown as RecordDecisionCommand),
    ).toEqual({
      issues: [{ code: "invalid-record-id", path: "recordId" }],
      ok: false,
    });
    expect(
      recordConsentDecision(undefined, policy, {
        ...baseCommand,
        method: "granular",
      } as unknown as RecordDecisionCommand),
    ).toEqual({
      issues: [
        { code: "invalid-granted-purpose-set", path: "grantedPurposeIds" },
      ],
      ok: false,
    });
  });

  it("orders purpose identifiers by locale-independent code units", () => {
    const unicodePolicy = {
      ...policy,
      optionalPurposeIds: ["ä", "z", "A"],
    } satisfies ConsentPolicyInput;

    expect(
      expectChanged(
        recordConsentDecision(undefined, unicodePolicy, {
          ...baseCommand,
          method: "reject-all",
        }),
      ).decisions.map(({ purposeId }) => purposeId),
    ).toEqual(["A", "z", "ä"]);
  });
});
