import { describe, expect, it } from "vitest";

import { resolveGpcSignal } from "./index.js";

describe("GPC signal resolution", () => {
  // @covers PP-25 REQ-GPC-POLICY: raw server and browser signals are preserved, never merged blindly.
  it("preserves server enabled and browser absent observations as a stable conflict", () => {
    const observations = Object.freeze([
      Object.freeze({
        navigationId: "previous-navigation",
        observedAtMs: 5,
        source: "browser" as const,
        value: "disabled" as const,
      }),
      Object.freeze({
        navigationId: "current-navigation",
        observedAtMs: 20,
        source: "browser" as const,
        value: "absent" as const,
      }),
      Object.freeze({
        navigationId: "current-navigation",
        observedAtMs: 10,
        source: "server" as const,
        value: "enabled" as const,
      }),
    ]);

    const resolution = resolveGpcSignal({
      navigationId: "current-navigation",
      observations,
    });

    expect(resolution).toEqual({
      conflict: {
        navigationId: "current-navigation",
        observations: [
          {
            navigationId: "current-navigation",
            observedAtMs: 10,
            source: "server",
            value: "enabled",
          },
          {
            navigationId: "current-navigation",
            observedAtMs: 20,
            source: "browser",
            value: "absent",
          },
        ],
        signal: "gpc",
        type: "privacy-signal-conflict-detected",
      },
      effectiveValue: "enabled",
      navigationId: "current-navigation",
      observations: [
        {
          navigationId: "current-navigation",
          observedAtMs: 10,
          source: "server",
          value: "enabled",
        },
        {
          navigationId: "current-navigation",
          observedAtMs: 20,
          source: "browser",
          value: "absent",
        },
      ],
    });
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(resolution.observations)).toBe(true);
    expect(Object.isFrozen(resolution.conflict)).toBe(true);
    expect(observations[0]?.navigationId).toBe("previous-navigation");

    expect(
      resolveGpcSignal({
        navigationId: "current-navigation",
        observations: [...observations].reverse(),
      }),
    ).toEqual(resolution);
  });

  it("resolves no current-navigation observation to absent without a conflict", () => {
    expect(
      resolveGpcSignal({
        navigationId: "current-navigation",
        observations: [
          {
            navigationId: "previous-navigation",
            observedAtMs: 1,
            source: "server",
            value: "enabled",
          },
        ],
      }),
    ).toEqual({
      conflict: null,
      effectiveValue: "absent",
      navigationId: "current-navigation",
      observations: [],
    });
  });

  it("uses timestamp then value ordering for observations from the same source", () => {
    const resolution = resolveGpcSignal({
      navigationId: "current-navigation",
      observations: [
        {
          navigationId: "current-navigation",
          observedAtMs: 20,
          source: "server",
          value: "absent",
        },
        {
          navigationId: "current-navigation",
          observedAtMs: 10,
          source: "server",
          value: "enabled",
        },
        {
          navigationId: "current-navigation",
          observedAtMs: 10,
          source: "server",
          value: "disabled",
        },
      ],
    });

    expect(resolution.observations.map(({ value }) => value)).toEqual([
      "disabled",
      "enabled",
      "absent",
    ]);
    expect(resolution.effectiveValue).toBe("enabled");
  });

  it("does not report a conflict when sources agree", () => {
    const resolution = resolveGpcSignal({
      navigationId: "current-navigation",
      observations: [
        {
          navigationId: "current-navigation",
          observedAtMs: 10,
          source: "browser",
          value: "disabled",
        },
        {
          navigationId: "current-navigation",
          observedAtMs: 10,
          source: "server",
          value: "disabled",
        },
      ],
    });

    expect(resolution.effectiveValue).toBe("disabled");
    expect(resolution.conflict).toBeNull();
  });

  it.each([1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe observation timestamp before resolving precedence: %s",
    (observedAtMs) => {
      expect(() =>
        resolveGpcSignal({
          navigationId: "current-navigation",
          observations: [
            {
              navigationId: "current-navigation",
              observedAtMs,
              source: "server",
              value: "enabled",
            },
          ],
        }),
      ).toThrow(new TypeError("observedAtMs must be a finite safe integer."));
    },
  );

  it("rejects an unsafe timestamp even on an observation from another navigation", () => {
    expect(() =>
      resolveGpcSignal({
        navigationId: "current-navigation",
        observations: [
          {
            navigationId: "previous-navigation",
            observedAtMs: 1.5,
            source: "browser",
            value: "absent",
          },
        ],
      }),
    ).toThrow(new TypeError("observedAtMs must be a finite safe integer."));
  });

  it("preserves the same observation timestamp that passed validation", () => {
    let observedAtReads = 0;
    const observation = Object.defineProperty(
      {
        navigationId: "current-navigation",
        observedAtMs: 10,
        source: "server" as const,
        value: "enabled" as const,
      },
      "observedAtMs",
      {
        enumerable: true,
        get: () => (++observedAtReads === 1 ? 10 : Number.MAX_SAFE_INTEGER + 1),
      },
    );

    expect(
      resolveGpcSignal({
        navigationId: "current-navigation",
        observations: [observation],
      }).observations[0]?.observedAtMs,
    ).toBe(10);
    expect(observedAtReads).toBe(1);
  });

  it("uses one captured navigation identifier for selection and output", () => {
    let navigationIdReads = 0;
    const input = Object.defineProperty(
      {
        navigationId: "current-navigation",
        observations: [
          {
            navigationId: "current-navigation",
            observedAtMs: 10,
            source: "server" as const,
            value: "enabled" as const,
          },
        ],
      },
      "navigationId",
      {
        enumerable: true,
        get: () =>
          ++navigationIdReads === 1
            ? "current-navigation"
            : "changed-navigation",
      },
    );

    expect(resolveGpcSignal(input)).toMatchObject({
      effectiveValue: "enabled",
      navigationId: "current-navigation",
      observations: [{ navigationId: "current-navigation" }],
    });
    expect(navigationIdReads).toBe(1);
  });

  it("does not let a caller-owned map method bypass observation capture", () => {
    let mapCalls = 0;
    const observations = [
      {
        navigationId: "current-navigation",
        observedAtMs: 10,
        source: "server" as const,
        value: "enabled" as const,
      },
    ];
    Object.defineProperty(observations, "map", {
      value: () => {
        mapCalls += 1;
        return [
          {
            navigationId: "current-navigation",
            observedAtMs: Number.MAX_SAFE_INTEGER + 1,
            source: "server" as const,
            value: "enabled" as const,
          },
        ];
      },
    });

    const resolution = resolveGpcSignal({
      navigationId: "current-navigation",
      observations,
    });

    expect(mapCalls).toBe(0);
    expect(resolution.observations[0]?.observedAtMs).toBe(10);
    expect(Object.isFrozen(resolution.observations[0])).toBe(true);
  });

  it("captures indexed observations without invoking a caller-owned iterator", () => {
    let iteratorCalls = 0;
    const observations = [
      {
        navigationId: "current-navigation",
        observedAtMs: Number.MAX_SAFE_INTEGER + 1,
        source: "server" as const,
        value: "enabled" as const,
      },
    ];
    Object.defineProperty(observations, Symbol.iterator, {
      value: function* () {
        iteratorCalls += 1;
        yield {
          navigationId: "current-navigation",
          observedAtMs: 10,
          source: "browser" as const,
          value: "absent" as const,
        };
      },
    });

    expect(() =>
      resolveGpcSignal({
        navigationId: "current-navigation",
        observations,
      }),
    ).toThrow(new TypeError("observedAtMs must be a finite safe integer."));
    expect(iteratorCalls).toBe(0);
  });

  it("fails closed above the shared 10,000-observation capture bound", () => {
    const observation = Object.freeze({
      navigationId: "current-navigation",
      observedAtMs: 10,
      source: "server" as const,
      value: "enabled" as const,
    });

    expect(
      resolveGpcSignal({
        navigationId: "current-navigation",
        observations: Array.from({ length: 10_000 }, () => observation),
      }).observations,
    ).toHaveLength(10_000);
    expect(() =>
      resolveGpcSignal({
        navigationId: "current-navigation",
        observations: Array.from({ length: 10_001 }, () => observation),
      }),
    ).toThrow(TypeError);
  });

  it("projects only the documented observation fields", () => {
    const privateField = Symbol("private-field");
    const observation = {
      navigationId: "current-navigation",
      observedAtMs: 10,
      source: "server" as const,
      value: "enabled" as const,
      ipAddress: "192.0.2.1",
      userAgent: "fixture-agent",
      [privateField]: "private-value",
    };

    const projected = resolveGpcSignal({
      navigationId: "current-navigation",
      observations: [observation],
    }).observations[0];

    expect(projected).toEqual({
      navigationId: "current-navigation",
      observedAtMs: 10,
      source: "server",
      value: "enabled",
    });
    expect(Reflect.ownKeys(projected ?? {})).toEqual([
      "navigationId",
      "observedAtMs",
      "source",
      "value",
    ]);
  });
});
