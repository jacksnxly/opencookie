import { describe, expect, it } from "vitest";

import { diffEffectiveAccess } from "./index.js";

describe("effective-access plan diff", () => {
  it("orders non-ASCII changes by code unit and detects service-only changes", () => {
    const previous = {
      resources: [
        {
          access: "blocked" as const,
          blockReasons: ["denied" as const],
          resourceId: "äther",
          serviceId: "old-service",
        },
        {
          access: "blocked" as const,
          blockReasons: ["denied" as const],
          resourceId: "zeta",
          serviceId: "old-service",
        },
      ],
    };
    const current = {
      resources: previous.resources.map((resource) => ({
        ...resource,
        serviceId: "new-service",
      })),
    };

    expect(
      diffEffectiveAccess({ current, previous }).changes.map(
        ({ lifecycle, resourceId }) => ({ lifecycle, resourceId }),
      ),
    ).toEqual([
      { lifecycle: "none", resourceId: "zeta" },
      { lifecycle: "none", resourceId: "äther" },
    ]);
  });

  it("recognizes unchanged blocked resources and rejects equal-size different sets", () => {
    const blocked = {
      access: "blocked" as const,
      blockReasons: ["denied" as const],
      resourceId: "same",
      serviceId: "service",
    };
    expect(
      diffEffectiveAccess({
        current: { resources: [{ ...blocked }] },
        previous: { resources: [blocked] },
      }),
    ).toEqual({ changes: [] });

    expect(() =>
      diffEffectiveAccess({
        current: {
          resources: [{ ...blocked, resourceId: "current-only" }],
        },
        previous: {
          resources: [{ ...blocked, resourceId: "previous-only" }],
        },
      }),
    ).toThrow(/same complete resource set/i);
  });

  it("returns only changed resources in stable order without restart churn", () => {
    const previous = Object.freeze({
      resources: Object.freeze([
        Object.freeze({
          access: "allowed" as const,
          basis: "explicit-consent" as const,
          blockReasons: Object.freeze([] as []),
          resourceId: "b-stop",
          serviceId: "service-b",
        }),
        Object.freeze({
          access: "allowed" as const,
          basis: "declared-exception" as const,
          blockReasons: Object.freeze([] as []),
          resourceId: "d-unchanged",
          serviceId: "service-d",
        }),
        Object.freeze({
          access: "blocked" as const,
          blockReasons: Object.freeze(["first-visit" as const]),
          resourceId: "c-start",
          serviceId: "service-c",
        }),
        Object.freeze({
          access: "blocked" as const,
          blockReasons: Object.freeze(["denied" as const]),
          resourceId: "a-reason-only",
          serviceId: "service-a",
        }),
      ]),
    });
    const current = Object.freeze({
      resources: Object.freeze([
        Object.freeze({
          access: "blocked" as const,
          blockReasons: Object.freeze(["privacy-signal" as const]),
          resourceId: "a-reason-only",
          serviceId: "service-a",
        }),
        Object.freeze({
          access: "blocked" as const,
          blockReasons: Object.freeze(["service-preference" as const]),
          resourceId: "b-stop",
          serviceId: "service-b",
        }),
        Object.freeze({
          access: "allowed" as const,
          basis: "explicit-consent" as const,
          blockReasons: Object.freeze([] as []),
          resourceId: "c-start",
          serviceId: "service-c",
        }),
        Object.freeze({
          access: "allowed" as const,
          basis: "declared-exception" as const,
          blockReasons: Object.freeze([] as []),
          resourceId: "d-unchanged",
          serviceId: "service-d",
        }),
      ]),
    });

    const result = diffEffectiveAccess({ current, previous });

    expect(result).toEqual({
      changes: [
        {
          after: {
            access: "blocked",
            blockReasons: ["privacy-signal"],
            resourceId: "a-reason-only",
            serviceId: "service-a",
          },
          before: {
            access: "blocked",
            blockReasons: ["denied"],
            resourceId: "a-reason-only",
            serviceId: "service-a",
          },
          lifecycle: "none",
          resourceId: "a-reason-only",
        },
        {
          after: {
            access: "blocked",
            blockReasons: ["service-preference"],
            resourceId: "b-stop",
            serviceId: "service-b",
          },
          before: {
            access: "allowed",
            basis: "explicit-consent",
            blockReasons: [],
            resourceId: "b-stop",
            serviceId: "service-b",
          },
          lifecycle: "stop",
          resourceId: "b-stop",
        },
        {
          after: {
            access: "allowed",
            basis: "explicit-consent",
            blockReasons: [],
            resourceId: "c-start",
            serviceId: "service-c",
          },
          before: {
            access: "blocked",
            blockReasons: ["first-visit"],
            resourceId: "c-start",
            serviceId: "service-c",
          },
          lifecycle: "start",
          resourceId: "c-start",
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changes)).toBe(true);
    expect(Object.isFrozen(result.changes[0]?.before)).toBe(true);
    expect(previous.resources[0]?.access).toBe("allowed");

    expect(
      diffEffectiveAccess({
        current: { resources: [...current.resources].reverse() },
        previous: { resources: [...previous.resources].reverse() },
      }),
    ).toEqual(result);
  });

  it("returns no changes for equal complete plans", () => {
    const plan = {
      resources: [
        {
          access: "allowed" as const,
          basis: "explicit-consent" as const,
          blockReasons: [] as const,
          resourceId: "resource",
          serviceId: "service",
        },
      ],
    };

    expect(diffEffectiveAccess({ current: plan, previous: plan })).toEqual({
      changes: [],
    });
  });

  it("rejects plans that do not describe the same complete resource set", () => {
    expect(() =>
      diffEffectiveAccess({
        current: { resources: [] },
        previous: {
          resources: [
            {
              access: "blocked",
              blockReasons: ["first-visit"],
              resourceId: "missing",
              serviceId: "service",
            },
          ],
        },
      }),
    ).toThrow(/same complete resource set/i);
  });

  it("rejects duplicate resource identities in either complete plan", () => {
    const duplicate = {
      access: "blocked" as const,
      blockReasons: ["denied" as const],
      resourceId: "duplicate",
      serviceId: "service",
    };

    expect(() =>
      diffEffectiveAccess({
        current: { resources: [duplicate, duplicate] },
        previous: { resources: [duplicate] },
      }),
    ).toThrow(/without duplicates/i);
  });

  it("reports basis and reason changes without lifecycle churn", () => {
    const result = diffEffectiveAccess({
      current: {
        resources: [
          {
            access: "allowed",
            basis: "declared-exception",
            blockReasons: [],
            resourceId: "allowed",
            serviceId: "service-a",
          },
          {
            access: "blocked",
            blockReasons: ["denied", "privacy-signal"],
            resourceId: "blocked",
            serviceId: "service-b",
          },
        ],
      },
      previous: {
        resources: [
          {
            access: "allowed",
            basis: "explicit-consent",
            blockReasons: [],
            resourceId: "allowed",
            serviceId: "service-a",
          },
          {
            access: "blocked",
            blockReasons: ["denied"],
            resourceId: "blocked",
            serviceId: "service-b",
          },
        ],
      },
    });

    expect(
      result.changes.map(({ lifecycle, resourceId }) => ({
        lifecycle,
        resourceId,
      })),
    ).toEqual([
      { lifecycle: "none", resourceId: "allowed" },
      { lifecycle: "none", resourceId: "blocked" },
    ]);
  });
});
