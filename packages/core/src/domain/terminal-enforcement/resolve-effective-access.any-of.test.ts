import { describe, expect, it } from "vitest";

import {
  resolveEffectiveAccess,
  type AccessConsentStatus,
  type AccessDecisionValue,
  type AccessPolicyResource,
  type ResolveEffectiveAccessInput,
} from "./index.js";
import { resolveAllOfEffectiveAccess } from "./resolve-effective-access.js";

// A tag manager's container serves several purposes and loads when any one
// of them is permitted. Each purpose is judged as if the container served it
// alone, so a restriction on the container itself still blocks it outright.

const CONTAINER: AccessPolicyResource = {
  access: "optional",
  id: "container",
  purposeIds: ["advertising", "analytics"],
  purposeMatch: "any",
  serviceId: "tag-manager",
};

function access(
  decisions: Readonly<Record<string, AccessDecisionValue>>,
  options: {
    readonly resource?: AccessPolicyResource;
    readonly restrictions?: ResolveEffectiveAccessInput["privacyRestrictions"];
    readonly servicePreferences?: ResolveEffectiveAccessInput["servicePreferences"];
    readonly status?: AccessConsentStatus;
  } = {},
) {
  const plan = resolveEffectiveAccess({
    consent: {
      decisions: Object.entries(decisions).map(([purposeId, decision]) => ({
        decision,
        purposeId,
      })),
      status: options.status ?? "active",
    },
    policy: {
      purposes: [
        { dependsOn: ["analytics"], id: "advertising" },
        { dependsOn: [], id: "analytics" },
        { dependsOn: [], id: "personalization" },
      ],
      resources: [options.resource ?? CONTAINER],
      valid: true,
    },
    ...(options.restrictions === undefined
      ? {}
      : { privacyRestrictions: options.restrictions }),
    ...(options.servicePreferences === undefined
      ? {}
      : { servicePreferences: options.servicePreferences }),
  });
  const [resource] = plan.resources;
  return resource?.access === "allowed"
    ? "allowed"
    : resource?.blockReasons.join(",");
}

const NO_RESTRICTION = {
  purposeIds: [],
  resourceIds: [],
  serviceIds: [],
  source: "gpc",
} as const;

describe("a resource that matches any of its purposes", () => {
  it("is allowed when one purpose is permitted, and blocked when none is", () => {
    expect(access({ advertising: "denied", analytics: "granted" })).toBe(
      "allowed",
    );
    // Blocked, it carries the reasons of every purpose's route.
    expect(access({ advertising: "denied", analytics: "denied" })).toBe(
      "denied,purpose-dependency",
    );
  });

  it("stays blocked before a decision and after a withdrawal", () => {
    expect(access({}, { status: "first-visit" })).toBe(
      "first-visit,purpose-dependency",
    );
    expect(
      access(
        { advertising: "denied", analytics: "denied" },
        { status: "withdrawn" },
      ),
    ).toBe("withdrawn,denied,purpose-dependency");
  });

  it("judges each purpose with its own dependencies", () => {
    // Advertising depends on analytics, so it permits nothing alone.
    expect(access({ advertising: "granted", analytics: "denied" })).toBe(
      "denied,purpose-dependency",
    );
  });

  it("lets a privacy signal close only the purpose it restricts", () => {
    const granted = { advertising: "granted", analytics: "granted" } as const;

    expect(
      access(granted, {
        restrictions: { ...NO_RESTRICTION, purposeIds: ["advertising"] },
      }),
    ).toBe("allowed");
    expect(
      access(
        { advertising: "denied", analytics: "granted" },
        {
          restrictions: { ...NO_RESTRICTION, purposeIds: ["analytics"] },
        },
      ),
    ).toBe("denied,privacy-signal");
  });

  it("is blocked outright by a restriction on the resource or its service", () => {
    const granted = { advertising: "granted", analytics: "granted" } as const;

    expect(
      access(granted, {
        restrictions: { ...NO_RESTRICTION, resourceIds: ["container"] },
      }),
    ).toBe("privacy-signal");
    expect(
      access(granted, {
        servicePreferences: { restrictedServiceIds: ["tag-manager"] },
      }),
    ).toBe("service-preference");
  });

  it("is invalid without purposes, and an unknown match means all", () => {
    expect(access({}, { resource: { ...CONTAINER, purposeIds: [] } })).toBe(
      "invalid-policy",
    );
    const unknownMatch = {
      ...CONTAINER,
      purposeMatch: "some",
    } as unknown as AccessPolicyResource;
    expect(
      access(
        { advertising: "denied", analytics: "granted" },
        { resource: unknownMatch },
      ),
    ).toBe("denied");
  });

  it("leaves a resource without the match needing every purpose", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { purposeMatch: _, ...allOf } = CONTAINER;

    expect(
      access(
        { advertising: "denied", analytics: "granted" },
        { resource: allOf },
      ),
    ).toBe("denied");
  });

  // The compact auto product binds each resource to one purpose, so it
  // carries only the all-of rule.
  it("is judged as all by the compact rule, which is otherwise the same", () => {
    const input = (resource: AccessPolicyResource) =>
      ({
        consent: {
          decisions: [
            { decision: "denied", purposeId: "advertising" },
            { decision: "granted", purposeId: "analytics" },
          ],
          status: "active",
        },
        policy: {
          purposes: [
            { dependsOn: ["analytics"], id: "advertising" },
            { dependsOn: [], id: "analytics" },
          ],
          resources: [resource],
          valid: true,
        },
      }) as const;
    for (const purposeIds of [["analytics"], ["advertising"]]) {
      const single = { ...CONTAINER, purposeIds };
      expect(resolveAllOfEffectiveAccess(input(single))).toEqual(
        resolveEffectiveAccess(input(single)),
      );
    }
    expect(
      resolveAllOfEffectiveAccess(input(CONTAINER)).resources[0]?.access,
    ).toBe("blocked");
    expect(resolveEffectiveAccess(input(CONTAINER)).resources[0]?.access).toBe(
      "allowed",
    );
  });
});
