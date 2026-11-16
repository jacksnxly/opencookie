import { describe, expect, it } from "vitest";

import { resolveEffectiveAccess } from "./index.js";

describe("effective terminal access", () => {
  it("blocks an optional resource that declares no purpose", () => {
    const plan = resolveEffectiveAccess({
      consent: { decisions: [], status: "active" },
      policy: {
        purposes: [{ dependsOn: [], id: "analytics" }],
        resources: [
          {
            access: "optional",
            id: "ghost",
            purposeIds: [],
            serviceId: "service-a",
          },
        ],
        valid: true,
      },
    });

    expect(plan.resources[0]?.access).toBe("blocked");
    expect(plan.resources[0]?.blockReasons).toContain("invalid-policy");
  });

  it("allows a fully granted dependency closure and orders resources by code unit", () => {
    const plan = resolveEffectiveAccess({
      consent: {
        decisions: [
          { decision: "granted", purposeId: "root" },
          { decision: "granted", purposeId: "middle" },
          { decision: "granted", purposeId: "leaf" },
        ],
        status: "active",
      },
      policy: {
        purposes: [
          { dependsOn: ["middle"], id: "root" },
          { dependsOn: ["leaf"], id: "middle" },
          { dependsOn: [], id: "leaf" },
        ],
        resources: [
          {
            access: "optional",
            id: "äther",
            purposeIds: ["root"],
            serviceId: "service-a",
          },
          {
            access: "declared-exception",
            exceptionReason: "Required for the session.",
            id: "zeta",
            purposeIds: [],
            serviceId: "service-z",
          },
        ],
        valid: true,
      },
    });

    expect(
      plan.resources.map(({ access, resourceId }) => ({
        access,
        resourceId,
      })),
    ).toEqual([
      { access: "allowed", resourceId: "zeta" },
      { access: "allowed", resourceId: "äther" },
    ]);
  });

  it("blocks missing active decisions and transitive GPC dependency restrictions", () => {
    const plan = resolveEffectiveAccess({
      consent: {
        decisions: [
          { decision: "granted", purposeId: "root" },
          { decision: "granted", purposeId: "middle" },
          { decision: "granted", purposeId: "leaf" },
        ],
        status: "active",
      },
      policy: {
        purposes: [
          { dependsOn: ["middle"], id: "root" },
          { dependsOn: ["leaf"], id: "middle" },
          { dependsOn: [], id: "leaf" },
          { dependsOn: [], id: "missing-decision" },
        ],
        resources: [
          {
            access: "optional",
            id: "missing",
            purposeIds: ["missing-decision"],
            serviceId: "missing-service",
          },
          {
            access: "optional",
            id: "transitive",
            purposeIds: ["root"],
            serviceId: "root-service",
          },
        ],
        valid: true,
      },
      privacyRestrictions: {
        purposeIds: ["leaf"],
        resourceIds: [],
        serviceIds: [],
        source: "gpc",
      },
    });

    expect(plan.resources).toEqual([
      {
        access: "blocked",
        blockReasons: ["policy-change"],
        resourceId: "missing",
        serviceId: "missing-service",
      },
      {
        access: "blocked",
        blockReasons: ["privacy-signal"],
        resourceId: "transitive",
        serviceId: "root-service",
      },
    ]);
  });

  it("blocks optional resources on first visit and permits only declared exceptions", () => {
    const decisions = Object.freeze([]);
    const consent = Object.freeze({
      decisions,
      status: "first-visit" as const,
    });
    const policy = Object.freeze({
      purposes: Object.freeze([
        Object.freeze({ dependsOn: Object.freeze([]), id: "analytics" }),
      ]),
      resources: Object.freeze([
        Object.freeze({
          access: "declared-exception" as const,
          exceptionReason: "Required for the session.",
          id: "session-cookie",
          purposeIds: Object.freeze([]),
          serviceId: "session",
        }),
        Object.freeze({
          access: "optional" as const,
          id: "analytics-script",
          purposeIds: Object.freeze(["analytics"]),
          serviceId: "analytics",
        }),
      ]),
      valid: true,
    });

    const plan = resolveEffectiveAccess({ consent, policy });

    expect(plan).toEqual({
      resources: [
        {
          access: "blocked",
          blockReasons: ["first-visit"],
          resourceId: "analytics-script",
          serviceId: "analytics",
        },
        {
          access: "allowed",
          basis: "declared-exception",
          blockReasons: [],
          resourceId: "session-cookie",
          serviceId: "session",
        },
      ],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.resources)).toBe(true);
    expect(Object.isFrozen(plan.resources[0]?.blockReasons)).toBe(true);
    expect(consent.decisions).toBe(decisions);
    expect(consent.decisions).toEqual([]);
  });

  it("blocks every resource when policy validity is unconfirmed", () => {
    expect(
      resolveEffectiveAccess({
        consent: { decisions: [], status: "first-visit" },
        policy: {
          purposes: [],
          resources: [
            {
              access: "declared-exception",
              exceptionReason: "Required for the session.",
              id: "session-cookie",
              purposeIds: [],
              serviceId: "session",
            },
            {
              access: "optional",
              id: "analytics-script",
              purposeIds: ["analytics"],
              serviceId: "analytics",
            },
          ],
          valid: false,
        },
      }),
    ).toEqual({
      resources: [
        {
          access: "blocked",
          blockReasons: ["invalid-policy", "first-visit"],
          resourceId: "analytics-script",
          serviceId: "analytics",
        },
        {
          access: "blocked",
          blockReasons: ["invalid-policy"],
          resourceId: "session-cookie",
          serviceId: "session",
        },
      ],
    });
  });

  it("fails closed for malformed declared exception reasons", () => {
    const malformedResources: readonly Record<string, unknown>[] = [
      {
        access: "declared-exception",
        id: "missing-reason",
        purposeIds: [],
        serviceId: "session",
      },
      {
        access: "declared-exception",
        exceptionReason: 42,
        id: "non-string-reason",
        purposeIds: [],
        serviceId: "session",
      },
      {
        access: "declared-exception",
        exceptionReason: "",
        id: "empty-reason",
        purposeIds: [],
        serviceId: "session",
      },
      {
        access: "declared-exception",
        exceptionReason: " \t\n ",
        id: "blank-reason",
        purposeIds: [],
        serviceId: "session",
      },
    ];

    for (const resource of malformedResources) {
      const plan = resolveEffectiveAccess({
        consent: { decisions: [], status: "first-visit" },
        policy: {
          purposes: [],
          resources: [resource],
          valid: true,
        } as unknown as Parameters<typeof resolveEffectiveAccess>[0]["policy"],
      });

      expect(plan.resources).toEqual([
        {
          access: "blocked",
          blockReasons: ["invalid-policy"],
          resourceId: resource["id"],
          serviceId: "session",
        },
      ]);
    }
  });

  it("keeps a stored grant blocked while a transitive purpose dependency is denied", () => {
    const consent = Object.freeze({
      decisions: Object.freeze([
        Object.freeze({ decision: "granted" as const, purposeId: "ads" }),
        Object.freeze({
          decision: "granted" as const,
          purposeId: "personalization",
        }),
        Object.freeze({
          decision: "denied" as const,
          purposeId: "analytics",
        }),
      ]),
      status: "active" as const,
    });
    const before = JSON.stringify(consent);

    expect(
      resolveEffectiveAccess({
        consent,
        policy: {
          purposes: [
            { dependsOn: ["personalization"], id: "ads" },
            { dependsOn: ["analytics"], id: "personalization" },
            { dependsOn: [], id: "analytics" },
          ],
          resources: [
            {
              access: "optional",
              id: "ad-script",
              purposeIds: ["ads"],
              serviceId: "ads",
            },
          ],
          valid: true,
        },
      }),
    ).toEqual({
      resources: [
        {
          access: "blocked",
          blockReasons: ["purpose-dependency"],
          resourceId: "ad-script",
          serviceId: "ads",
        },
      ],
    });
    expect(JSON.stringify(consent)).toBe(before);
    expect(consent.decisions[0]?.decision).toBe("granted");
  });

  it("applies and removes a service preference without changing consent", () => {
    const consent = Object.freeze({
      decisions: Object.freeze([
        Object.freeze({ decision: "granted" as const, purposeId: "analytics" }),
      ]),
      status: "active" as const,
    });
    const policy = {
      purposes: [{ dependsOn: [], id: "analytics" }],
      resources: [
        {
          access: "optional" as const,
          id: "analytics-script",
          purposeIds: ["analytics"],
          serviceId: "analytics-service",
        },
      ],
      valid: true,
    };
    const before = JSON.stringify(consent);

    expect(
      resolveEffectiveAccess({
        consent,
        policy,
        servicePreferences: {
          restrictedServiceIds: ["analytics-service"],
        },
      }).resources[0],
    ).toEqual({
      access: "blocked",
      blockReasons: ["service-preference"],
      resourceId: "analytics-script",
      serviceId: "analytics-service",
    });
    expect(resolveEffectiveAccess({ consent, policy }).resources[0]).toEqual({
      access: "allowed",
      basis: "explicit-consent",
      blockReasons: [],
      resourceId: "analytics-script",
      serviceId: "analytics-service",
    });
    expect(JSON.stringify(consent)).toBe(before);
  });

  it("applies privacy restrictions by purpose, resource, and service without allowing denial", () => {
    const consent = Object.freeze({
      decisions: Object.freeze([
        Object.freeze({ decision: "granted" as const, purposeId: "analytics" }),
        Object.freeze({ decision: "granted" as const, purposeId: "ads" }),
        Object.freeze({
          decision: "granted" as const,
          purposeId: "personalization",
        }),
        Object.freeze({ decision: "denied" as const, purposeId: "sale" }),
      ]),
      status: "active" as const,
    });
    const policy = {
      purposes: ["analytics", "ads", "personalization", "sale"].map((id) => ({
        dependsOn: [],
        id,
      })),
      resources: [
        {
          access: "optional" as const,
          id: "purpose-match",
          purposeIds: ["analytics"],
          serviceId: "purpose-service",
        },
        {
          access: "optional" as const,
          id: "resource-match",
          purposeIds: ["ads"],
          serviceId: "resource-service",
        },
        {
          access: "optional" as const,
          id: "service-match",
          purposeIds: ["personalization"],
          serviceId: "target-service",
        },
        {
          access: "optional" as const,
          id: "still-denied",
          purposeIds: ["sale"],
          serviceId: "sale-service",
        },
      ],
      valid: true,
    };
    const restricted = resolveEffectiveAccess({
      consent,
      policy,
      privacyRestrictions: {
        purposeIds: ["analytics"],
        resourceIds: ["resource-match"],
        serviceIds: ["target-service"],
        source: "gpc",
      },
    });

    expect(restricted.resources).toEqual([
      {
        access: "blocked",
        blockReasons: ["privacy-signal"],
        resourceId: "purpose-match",
        serviceId: "purpose-service",
      },
      {
        access: "blocked",
        blockReasons: ["privacy-signal"],
        resourceId: "resource-match",
        serviceId: "resource-service",
      },
      {
        access: "blocked",
        blockReasons: ["privacy-signal"],
        resourceId: "service-match",
        serviceId: "target-service",
      },
      {
        access: "blocked",
        blockReasons: ["denied"],
        resourceId: "still-denied",
        serviceId: "sale-service",
      },
    ]);
    expect(
      resolveEffectiveAccess({ consent, policy }).resources.map(
        (resource) => resource.access,
      ),
    ).toEqual(["allowed", "allowed", "allowed", "blocked"]);
    expect(consent.decisions[3]?.decision).toBe("denied");
  });

  it("blocks only resources directly or transitively affected by selective reconsent", () => {
    const plan = resolveEffectiveAccess({
      consent: {
        decisions: [
          { decision: "unresolved", purposeId: "affected" },
          { decision: "granted", purposeId: "dependent" },
          { decision: "granted", purposeId: "unaffected" },
        ],
        status: "requires-reconsent",
      },
      policy: {
        purposes: [
          { dependsOn: [], id: "affected" },
          { dependsOn: ["affected"], id: "dependent" },
          { dependsOn: [], id: "unaffected" },
        ],
        resources: [
          {
            access: "optional",
            id: "unaffected-resource",
            purposeIds: ["unaffected"],
            serviceId: "unaffected-service",
          },
          {
            access: "optional",
            id: "transitive-resource",
            purposeIds: ["dependent"],
            serviceId: "dependent-service",
          },
          {
            access: "optional",
            id: "multi-purpose-resource",
            purposeIds: ["unaffected", "affected"],
            serviceId: "multi-purpose-service",
          },
          {
            access: "optional",
            id: "affected-resource",
            purposeIds: ["affected"],
            serviceId: "affected-service",
          },
        ],
        valid: true,
      },
    });

    expect(plan.resources).toEqual([
      {
        access: "blocked",
        blockReasons: ["policy-change"],
        resourceId: "affected-resource",
        serviceId: "affected-service",
      },
      {
        access: "blocked",
        blockReasons: ["policy-change"],
        resourceId: "multi-purpose-resource",
        serviceId: "multi-purpose-service",
      },
      {
        access: "blocked",
        blockReasons: ["policy-change", "purpose-dependency"],
        resourceId: "transitive-resource",
        serviceId: "dependent-service",
      },
      {
        access: "allowed",
        basis: "explicit-consent",
        blockReasons: [],
        resourceId: "unaffected-resource",
        serviceId: "unaffected-service",
      },
    ]);
  });

  it("returns every applicable block reason in its documented order", () => {
    const resource = resolveEffectiveAccess({
      consent: {
        decisions: [
          { decision: "unresolved", purposeId: "changed" },
          { decision: "denied", purposeId: "denied" },
          { decision: "granted", purposeId: "dependent" },
          { decision: "denied", purposeId: "prerequisite" },
        ],
        status: "expired",
      },
      policy: {
        purposes: [
          { dependsOn: [], id: "changed" },
          { dependsOn: [], id: "denied" },
          { dependsOn: ["prerequisite"], id: "dependent" },
          { dependsOn: [], id: "prerequisite" },
        ],
        resources: [
          {
            access: "optional",
            id: "fully-blocked",
            purposeIds: ["changed", "denied", "dependent"],
            serviceId: "blocked-service",
          },
        ],
        valid: false,
      },
      privacyRestrictions: {
        purposeIds: [],
        resourceIds: ["fully-blocked"],
        serviceIds: [],
        source: "gpc",
      },
      servicePreferences: {
        restrictedServiceIds: ["blocked-service"],
      },
    }).resources[0];

    expect(resource).toEqual({
      access: "blocked",
      blockReasons: [
        "invalid-policy",
        "policy-change",
        "expired",
        "denied",
        "purpose-dependency",
        "service-preference",
        "privacy-signal",
      ],
      resourceId: "fully-blocked",
      serviceId: "blocked-service",
    });
  });

  it("retains withdrawn denial and narrows a declared exception", () => {
    const plan = resolveEffectiveAccess({
      consent: {
        decisions: [{ decision: "denied", purposeId: "analytics" }],
        status: "withdrawn",
      },
      policy: {
        purposes: [{ dependsOn: [], id: "analytics" }],
        resources: [
          {
            access: "optional",
            id: "analytics-script",
            purposeIds: ["analytics"],
            serviceId: "analytics-service",
          },
          {
            access: "declared-exception",
            exceptionReason: "Required for the session.",
            id: "session-cookie",
            purposeIds: [],
            serviceId: "session-service",
          },
        ],
        valid: true,
      },
      privacyRestrictions: {
        purposeIds: [],
        resourceIds: ["session-cookie"],
        serviceIds: [],
        source: "gpc",
      },
      servicePreferences: {
        restrictedServiceIds: ["session-service"],
      },
    });

    expect(plan.resources).toEqual([
      {
        access: "blocked",
        blockReasons: ["withdrawn", "denied"],
        resourceId: "analytics-script",
        serviceId: "analytics-service",
      },
      {
        access: "blocked",
        blockReasons: ["service-preference", "privacy-signal"],
        resourceId: "session-cookie",
        serviceId: "session-service",
      },
    ]);
  });

  it("terminates malformed cycles and unknown dependency paths fail closed", () => {
    const plan = resolveEffectiveAccess({
      consent: {
        decisions: [
          { decision: "granted", purposeId: "cycle-a" },
          { decision: "granted", purposeId: "cycle-b" },
          { decision: "granted", purposeId: "missing-dependency" },
          { decision: "granted", purposeId: "unknown-parent" },
        ],
        status: "active",
      },
      policy: {
        purposes: [
          { dependsOn: ["cycle-b"], id: "cycle-a" },
          { dependsOn: ["cycle-a"], id: "cycle-b" },
          { dependsOn: ["missing-dependency"], id: "unknown-parent" },
        ],
        resources: [
          {
            access: "optional",
            id: "cycle-resource",
            purposeIds: ["cycle-a"],
            serviceId: "cycle-service",
          },
          {
            access: "optional",
            id: "missing-dependency-resource",
            purposeIds: ["unknown-parent"],
            serviceId: "unknown-service",
          },
          {
            access: "optional",
            id: "unknown-purpose-resource",
            purposeIds: ["not-in-policy"],
            serviceId: "unknown-purpose-service",
          },
        ],
        valid: false,
      },
    });

    expect(plan.resources).toEqual([
      {
        access: "blocked",
        blockReasons: ["invalid-policy", "purpose-dependency"],
        resourceId: "cycle-resource",
        serviceId: "cycle-service",
      },
      {
        access: "blocked",
        blockReasons: ["invalid-policy", "purpose-dependency"],
        resourceId: "missing-dependency-resource",
        serviceId: "unknown-service",
      },
      {
        access: "blocked",
        blockReasons: ["invalid-policy"],
        resourceId: "unknown-purpose-resource",
        serviceId: "unknown-purpose-service",
      },
    ]);
  });

  it("reports first visit instead of reconsent for an unresolved dependency", () => {
    const resource = resolveEffectiveAccess({
      consent: {
        decisions: [{ decision: "granted", purposeId: "analytics" }],
        status: "first-visit",
      },
      policy: {
        purposes: [{ dependsOn: ["missing"], id: "analytics" }],
        resources: [
          {
            access: "optional",
            id: "analytics-script",
            purposeIds: ["analytics"],
            serviceId: "analytics-service",
          },
        ],
        valid: false,
      },
      privacyRestrictions: {
        purposeIds: ["unrelated"],
        resourceIds: [],
        serviceIds: [],
        source: "gpc",
      },
    }).resources[0];

    expect(resource).toEqual({
      access: "blocked",
      blockReasons: ["invalid-policy", "first-visit", "purpose-dependency"],
      resourceId: "analytics-script",
      serviceId: "analytics-service",
    });
  });
});
