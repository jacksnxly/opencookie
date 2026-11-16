import {
  comparePurposeId,
  freezeIdentity,
  sameDecisionSurface,
  sameIdentity,
  stableUnique,
  type ConsentPolicyAffectedPurposeInput,
  type ConsentPolicyChangeSetInput,
  type ConsentPolicyInput,
  type ConsentRecord,
  type PurposeDecisionState,
} from "./consent-record.js";

/** @public */
export interface ReconsentIssue {
  readonly code:
    | "policy-change-identity-mismatch"
    | "policy-change-set-incomplete"
    | "policy-change-set-missing";
  readonly path: string;
}

/** @public */
export interface ReconsentPlan {
  readonly affectedPurposes: readonly ConsentPolicyAffectedPurposeInput[];
  readonly decisions: readonly PurposeDecisionState[];
  readonly issues: readonly ReconsentIssue[];
  readonly policy: Readonly<
    Pick<
      ConsentPolicyInput,
      "catalogueDigest" | "decisionSurfaceDigest" | "policyVersion"
    >
  >;
  readonly prompt: boolean;
  readonly status: "current" | "invalid" | "requires-reconsent" | "withdrawn";
}

function freezeDecisions(
  decisions: readonly PurposeDecisionState[],
): readonly PurposeDecisionState[] {
  return Object.freeze(
    decisions
      .map((decision) => Object.freeze({ ...decision }))
      .sort(comparePurposeId),
  );
}

function freezeAffectedPurposes(
  affectedPurposes: readonly ConsentPolicyAffectedPurposeInput[],
): readonly ConsentPolicyAffectedPurposeInput[] {
  return Object.freeze(
    affectedPurposes
      .map((affected) =>
        Object.freeze({
          purposeId: affected.purposeId,
          reasonCodes: stableUnique(affected.reasonCodes),
        }),
      )
      .sort(comparePurposeId),
  );
}

function freezePlan(plan: ReconsentPlan): ReconsentPlan {
  return Object.freeze({
    affectedPurposes: freezeAffectedPurposes(plan.affectedPurposes),
    decisions: freezeDecisions(plan.decisions),
    issues: Object.freeze(
      plan.issues.map((issue) => Object.freeze({ ...issue })),
    ),
    policy: freezeIdentity(plan.policy),
    prompt: plan.prompt,
    status: plan.status,
  });
}

function identityIssue(
  record: ConsentRecord,
  policy: ConsentPolicyInput,
  changeSet: ConsentPolicyChangeSetInput | undefined,
): ReconsentIssue | undefined {
  if (!changeSet) {
    const recordedPurposeIds = stableUnique(
      record.decisions.map(({ purposeId }) => purposeId),
    );
    const currentPurposeIds = stableUnique(policy.optionalPurposeIds);
    const hasSamePurposeSet =
      recordedPurposeIds.length === currentPurposeIds.length &&
      recordedPurposeIds.every(
        (purposeId, index) => purposeId === currentPurposeIds[index],
      );
    const unexplainedPurposeChange =
      record.policy.catalogueDigest !== policy.catalogueDigest &&
      !hasSamePurposeSet;

    return sameDecisionSurface(record.policy, policy) &&
      !unexplainedPurposeChange
      ? undefined
      : { code: "policy-change-set-missing", path: "changeSet" };
  }

  if (!sameDecisionSurface(record.policy, changeSet.previousIdentity)) {
    return {
      code: "policy-change-identity-mismatch",
      path: "changeSet.previousIdentity",
    };
  }

  if (!sameIdentity(policy, changeSet.currentIdentity)) {
    return {
      code: "policy-change-identity-mismatch",
      path: "changeSet.currentIdentity",
    };
  }

  const recordedPurposeIds = stableUnique(
    record.decisions.map(({ purposeId }) => purposeId),
  );
  const currentPurposeIds = stableUnique(policy.optionalPurposeIds);
  const recordedPurposeIdSet = new Set(recordedPurposeIds);
  const currentPurposeIdSet = new Set(currentPurposeIds);
  const actualAddedPurposeIds = currentPurposeIds.filter(
    (purposeId) => !recordedPurposeIdSet.has(purposeId),
  );
  const actualRemovedPurposeIds = recordedPurposeIds.filter(
    (purposeId) => !currentPurposeIdSet.has(purposeId),
  );
  const declaredAddedPurposeIds = stableUnique(changeSet.addedPurposeIds);
  const declaredRemovedPurposeIds = stableUnique(changeSet.removedPurposeIds);
  if (
    declaredAddedPurposeIds.length !== actualAddedPurposeIds.length ||
    declaredAddedPurposeIds.some(
      (purposeId, index) => purposeId !== actualAddedPurposeIds[index],
    )
  ) {
    return {
      code: "policy-change-set-incomplete",
      path: "changeSet.addedPurposeIds",
    };
  }
  if (
    declaredRemovedPurposeIds.length !== actualRemovedPurposeIds.length ||
    declaredRemovedPurposeIds.some(
      (purposeId, index) => purposeId !== actualRemovedPurposeIds[index],
    )
  ) {
    return {
      code: "policy-change-set-incomplete",
      path: "changeSet.removedPurposeIds",
    };
  }
  if (
    changeSet.affectedPurposes.some(
      ({ purposeId }) => !currentPurposeIdSet.has(purposeId),
    )
  ) {
    return {
      code: "policy-change-set-incomplete",
      path: "changeSet.affectedPurposes",
    };
  }
  if (
    record.policy.decisionSurfaceDigest !== policy.decisionSurfaceDigest &&
    actualAddedPurposeIds.length === 0 &&
    actualRemovedPurposeIds.length === 0 &&
    changeSet.affectedPurposes.length === 0
  ) {
    return {
      code: "policy-change-set-incomplete",
      path: "changeSet.affectedPurposes",
    };
  }

  return undefined;
}

/**
 * Projects an existing explicit decision record onto the current policy without
 * importing Policy Catalogue internals or inventing a new visitor choice.
 *
 * @public
 */
export function planReconsent(
  record: ConsentRecord,
  policy: ConsentPolicyInput,
  changeSet?: ConsentPolicyChangeSetInput,
): ReconsentPlan {
  const currentPurposeIds = stableUnique(policy.optionalPurposeIds);
  const currentPurposeIdSet = new Set(currentPurposeIds);
  const decisionsByPurpose = new Map(
    record.decisions.map((decision) => [decision.purposeId, decision.value]),
  );
  const issue = identityIssue(record, policy, changeSet);
  const isWithdrawn = record.method === "withdrawal";

  if (issue) {
    const decisions = currentPurposeIds.map((purposeId) => {
      const previous = decisionsByPurpose.get(purposeId);
      return {
        purposeId,
        value:
          previous === undefined
            ? "unresolved"
            : previous === "denied" || isWithdrawn
              ? "denied"
              : "unresolved",
      } satisfies PurposeDecisionState;
    });
    const affectedPurposes = decisions
      .filter(({ value }) => value === "unresolved")
      .map(({ purposeId }) => ({
        purposeId,
        reasonCodes: ["identity-unverified"],
      }));

    return freezePlan({
      affectedPurposes,
      decisions,
      issues: [issue],
      policy,
      prompt: !isWithdrawn,
      status: isWithdrawn ? "withdrawn" : "invalid",
    });
  }

  if (!changeSet) {
    const decisions = currentPurposeIds.map(
      (purposeId) =>
        ({
          purposeId,
          value: decisionsByPurpose.get(purposeId) ?? "unresolved",
        }) satisfies PurposeDecisionState,
    );
    const requiresReconsent = decisions.some(
      ({ value }) => value === "unresolved",
    );

    return freezePlan({
      affectedPurposes: [],
      decisions,
      issues: [],
      policy,
      prompt: !isWithdrawn && requiresReconsent,
      status: isWithdrawn
        ? "withdrawn"
        : requiresReconsent
          ? "requires-reconsent"
          : "current",
    });
  }

  const addedPurposeIds = new Set(changeSet.addedPurposeIds);
  const affectedByPurpose = new Map(
    changeSet.affectedPurposes.map((affected) => [
      affected.purposeId,
      affected.reasonCodes,
    ]),
  );
  const decisions = currentPurposeIds.map((purposeId) => {
    const previous = decisionsByPurpose.get(purposeId);
    const isAdded = addedPurposeIds.has(purposeId) || previous === undefined;
    const isAffected = affectedByPurpose.has(purposeId);

    if (isWithdrawn) {
      return {
        purposeId,
        value: isAdded ? "unresolved" : "denied",
      } satisfies PurposeDecisionState;
    }

    return {
      purposeId,
      value:
        isAdded || (isAffected && previous === "granted")
          ? "unresolved"
          : previous,
    } satisfies PurposeDecisionState;
  });
  const affectedPurposes = [
    ...changeSet.affectedPurposes.filter(({ purposeId }) =>
      currentPurposeIdSet.has(purposeId),
    ),
    ...changeSet.addedPurposeIds
      .filter((purposeId) => currentPurposeIdSet.has(purposeId))
      .map((purposeId) => ({ purposeId, reasonCodes: ["purpose-added"] })),
  ];
  const requiresReconsent = decisions.some(
    ({ value }) => value === "unresolved",
  );

  return freezePlan({
    affectedPurposes,
    decisions,
    issues: [],
    policy,
    prompt: !isWithdrawn && requiresReconsent,
    status: isWithdrawn
      ? "withdrawn"
      : requiresReconsent
        ? "requires-reconsent"
        : "current",
  });
}
