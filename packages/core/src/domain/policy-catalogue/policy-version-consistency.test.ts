import { describe, expect, it } from "vitest";

import {
  createPolicySnapshot,
  definePolicy,
  diffPolicies,
  type PolicySnapshot,
} from "./index.js";
import {
  completeTestPolicyDefinition,
  type TestPolicyDefinition,
} from "./policy-test-fixtures.test-helper.js";

function snapshot(
  definition: TestPolicyDefinition,
  catalogueRevision: string,
  policyVersion: string,
): PolicySnapshot {
  const result = definePolicy(completeTestPolicyDefinition(definition));
  if (!result.ok) throw new Error("fixture policy must be valid");

  return createPolicySnapshot({
    catalogueRevision,
    policy: result.policy,
    policyVersion,
  });
}

describe("policy-version consistency", () => {
  it("rejects a policy-version bump with no affected purpose", () => {
    const previous = snapshot(
      { purposes: [{ editorialNote: "Compact", id: "analytics" }] },
      "catalogue-before",
      "release-final",
    );
    const next = snapshot(
      { purposes: [{ editorialNote: "Expanded", id: "analytics" }] },
      "catalogue-after",
      "0000",
    );

    expect(diffPolicies(previous, next)).toEqual({
      issues: [
        {
          code: "policy-version-changed-without-affected-purpose",
          nextPolicyVersion: "0000",
          previousPolicyVersion: "release-final",
        },
      ],
      ok: false,
    });
  });

  it("rejects a material change without a policy-version change", () => {
    const previous = snapshot(
      { purposes: [{ disclosure: "Measure use", id: "analytics" }] },
      "catalogue-before",
      "opaque-same",
    );
    const next = snapshot(
      {
        purposes: [{ disclosure: "Measure and profile use", id: "analytics" }],
      },
      "catalogue-after",
      "opaque-same",
    );

    expect(diffPolicies(previous, next)).toEqual({
      issues: [
        {
          code: "policy-version-unchanged-with-affected-purpose",
          policyVersion: "opaque-same",
        },
      ],
      ok: false,
    });
  });

  it("treats policy versions as opaque identities without ordering them", () => {
    const previous = snapshot(
      { purposes: [{ disclosure: "Measure use", id: "analytics" }] },
      "catalogue-before",
      "release-final",
    );
    const next = snapshot(
      {
        purposes: [{ disclosure: "Measure and profile use", id: "analytics" }],
      },
      "catalogue-after",
      "0000",
    );

    const result = diffPolicies(previous, next);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("opaque version transition must be valid");
    expect(result.changeSet.nextIdentity.policyVersion).toBe("0000");
    expect(result.changeSet.previousIdentity.policyVersion).toBe(
      "release-final",
    );
  });
});
