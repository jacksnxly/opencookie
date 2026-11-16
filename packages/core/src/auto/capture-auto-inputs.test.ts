import { describe, expect, it } from "vitest";

import {
  createAutoOpenCookieFactory,
  type AutoOpenCookiePersistenceInput,
} from "../auto.js";
import {
  captureAutoOpenCookieDefinition,
  captureAutoOpenCookieRuntimeOptions,
} from "./capture-auto-inputs.js";
import { createSequentialIdGenerator } from "./auto-product-test-fixtures.test-helper.js";

type AutoFactory = ReturnType<typeof createAutoOpenCookieFactory>;

function validDefinition(): Record<string, unknown> {
  return { consentDurationMs: 60_000 };
}

function validRuntimeOptions(): Record<string, unknown> {
  return {
    idGenerator: createSequentialIdGenerator(),
    now: () => 1_000,
    persistence: { kind: "unavailable" },
  };
}

function validController() {
  return {
    block: () => Promise.resolve({ irreversibleEffects: [] }),
    cleanup: () => Promise.resolve({ irreversibleEffects: [] }),
    discover: () => Promise.resolve("dormant" as const),
    start: () => Promise.resolve({ irreversibleEffects: [] }),
    stop: () => Promise.resolve(),
  };
}

const invalidCookieCases: readonly (readonly [
  label: string,
  persistence: AutoOpenCookiePersistenceInput,
  expected: string | RegExp | ErrorConstructor,
])[] = [
  [
    "invalid cookie names",
    {
      hostname: "example.com",
      key: "invalid;name",
      kind: "cookie",
      read: (): string => "",
      secure: true,
      write: (): void => undefined,
    },
    /cookie name/i,
  ],
  [
    "malformed hosts",
    {
      hostname: "https://example.com",
      kind: "cookie",
      read: (): string => "",
      secure: true,
      write: (): void => undefined,
    },
    TypeError,
  ],
  [
    "unrelated shared domains",
    {
      domain: "other.test",
      hostname: "app.example.com",
      kind: "cookie",
      read: (): string => "",
      registrableDomain: "example.com",
      secure: true,
      write: (): void => undefined,
    },
    /parent domain/i,
  ],
  [
    "domains above the registrable boundary",
    {
      domain: "co.uk",
      hostname: "app.example.co.uk",
      kind: "cookie",
      read: (): string => "",
      registrableDomain: "example.co.uk",
      secure: true,
      write: (): void => undefined,
    },
    /registrable domain boundary/i,
  ],
];

describe("captureAutoOpenCookieDefinition", () => {
  it("validates the consent duration before observing any other field", () => {
    const observedDescriptors: PropertyKey[] = [];
    const observedGets: PropertyKey[] = [];
    let ownKeysReads = 0;
    const definition = new Proxy(
      { consentDurationMs: 0, purposeId: "analytics" },
      {
        get: (target, property, receiver) => {
          observedGets.push(property);
          return Reflect.get(target, property, receiver) as unknown;
        },
        getOwnPropertyDescriptor: (target, property) => {
          observedDescriptors.push(property);
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys: (target) => {
          ownKeysReads += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(() => captureAutoOpenCookieDefinition(definition)).toThrow(
      "Consent duration must be a positive safe integer.",
    );
    expect(observedDescriptors).toEqual(["consentDurationMs"]);
    expect(observedGets).toEqual([]);
    expect(ownKeysReads).toBe(0);
  });

  it("reads each definition field through its descriptor exactly once", () => {
    const reads = new Map<PropertyKey, number>();
    const definition = new Proxy(
      {
        catalogueRevision: "catalogue-9",
        consentDurationMs: 60_000,
        consentId: "consent-1",
        disclosure: "Understand aggregate site usage.",
        locale: "en-US",
        policyVersion: "policy-9",
        purposeId: "analytics",
        purposeLabel: "Analytics",
      },
      {
        getOwnPropertyDescriptor: (target, property) => {
          reads.set(property, (reads.get(property) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    const captured = captureAutoOpenCookieDefinition(definition);

    expect(captured).toEqual({
      catalogueRevision: "catalogue-9",
      consentDurationMs: 60_000,
      consentId: "consent-1",
      disclosure: "Understand aggregate site usage.",
      locale: "en-US",
      policyVersion: "policy-9",
      purposeId: "analytics",
      purposeLabel: "Analytics",
    });
    expect(Object.isFrozen(captured)).toBe(true);
    for (const [property, count] of reads) {
      expect({ count, property }).toEqual({ count: 1, property });
    }
  });

  it("applies the canonical single-purpose defaults", () => {
    expect(captureAutoOpenCookieDefinition(validDefinition())).toEqual({
      catalogueRevision: "catalogue-1",
      consentDurationMs: 60_000,
      disclosure: "Understand aggregate site usage.",
      policyVersion: "policy-1",
      purposeId: "analytics",
      purposeLabel: "Analytics",
    });
  });

  it("rejects unknown definition keys", () => {
    expect(() =>
      captureAutoOpenCookieDefinition({
        ...validDefinition(),
        unexpected: true,
      }),
    ).toThrow("Invalid auto consent definition.");
  });

  it("rejects symbol definition keys", () => {
    expect(() =>
      captureAutoOpenCookieDefinition({
        ...validDefinition(),
        [Symbol("hidden")]: true,
      }),
    ).toThrow("Invalid auto consent definition.");
  });

  it("rejects inherited definition fields", () => {
    const definition = Object.assign(
      Object.create({ purposeId: "analytics" }) as Record<string, unknown>,
      validDefinition(),
    );
    expect(() => captureAutoOpenCookieDefinition(definition)).toThrow(
      "Invalid auto consent definition.",
    );
  });

  it("rejects accessor-backed definition fields", () => {
    const definition = validDefinition();
    Object.defineProperty(definition, "purposeId", {
      enumerable: true,
      get: () => "analytics",
    });
    expect(() => captureAutoOpenCookieDefinition(definition)).toThrow(
      "Invalid auto consent definition.",
    );
  });

  it("rejects a revoked proxy definition", () => {
    const revocable = Proxy.revocable(validDefinition(), {});
    revocable.revoke();
    expect(() => captureAutoOpenCookieDefinition(revocable.proxy)).toThrow(
      "Invalid auto consent definition.",
    );
  });

  it("rejects non-object definitions", () => {
    expect(() => captureAutoOpenCookieDefinition(null)).toThrow(
      "Invalid auto consent definition.",
    );
    expect(() => captureAutoOpenCookieDefinition("definition")).toThrow(
      "Invalid auto consent definition.",
    );
  });
});

describe("captureAutoOpenCookieRuntimeOptions", () => {
  it("rejects unknown runtime option keys", () => {
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        unexpected: true,
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("rejects accessor-backed runtime fields", () => {
    const options = validRuntimeOptions();
    Object.defineProperty(options, "broadcast", {
      enumerable: true,
      get: () => () => Promise.resolve(),
    });
    expect(() => captureAutoOpenCookieRuntimeOptions(options)).toThrow(
      "Invalid auto consent runtime options.",
    );
  });

  it("rejects inherited runtime fields", () => {
    const options = Object.assign(
      Object.create({ reconcile: () => Promise.resolve() }) as Record<
        string,
        unknown
      >,
      validRuntimeOptions(),
    );
    expect(() => captureAutoOpenCookieRuntimeOptions(options)).toThrow(
      "Invalid auto consent runtime options.",
    );
  });

  it("rejects sparse resource arrays", () => {
    const resources: unknown[] = [
      { id: "analytics-script", serviceId: "analytics-service" },
    ];
    resources.length = 3;
    resources[2] = { id: "other-script", serviceId: "other-service" };
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        resources,
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("bounds resource capture", () => {
    const resources = Array.from({ length: 10_001 }, (_, index) => ({
      id: `resource-${String(index)}`,
      serviceId: `service-${String(index)}`,
    }));
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        resources,
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it.each([
    ["string", { unexpected: true }],
    ["symbol", { [Symbol("unexpected")]: true }],
  ])("rejects extra %s controller keys", (_label, extra) => {
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        controllers: {
          "analytics-script": Object.assign(validController(), extra),
        },
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("bounds controller registry capture", () => {
    const controller = validController();
    const controllers = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [
        `resource-${String(index)}`,
        controller,
      ]),
    );
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        controllers,
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("charges controller entries against the shared capture budget", () => {
    const controller = validController();
    const controllers = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `resource-${String(index)}`,
        controller,
      ]),
    );
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        controllers,
        resources: [{ id: "final-resource", serviceId: "final-service" }],
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("rejects duplicate normalized controller identifiers", () => {
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        controllers: {
          " Widget-Script ": validController(),
          "widget-script": validController(),
        },
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("rejects hidden controls embedded in controller identifiers", () => {
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        controllers: { "ana\u200Dlytics": validController() },
      }),
    ).toThrow(new TypeError("Invalid auto consent runtime options."));
  });

  it("canonicalizes every Google resource mapping identifier", () => {
    const captured = captureAutoOpenCookieRuntimeOptions({
      ...validRuntimeOptions(),
      google: {
        command: () => undefined,
        mapping: {
          adPersonalizationResourceIds: [" Ad-Personalization "],
          adStorageResourceIds: [" Ad-Storage "],
          adUserDataResourceIds: [" Ad-User-Data "],
          analyticsStorageResourceIds: [" Analytics-Storage "],
        },
        mode: "basic",
      },
    });

    expect(captured.google?.mapping).toEqual({
      adPersonalizationResourceIds: ["ad-personalization"],
      adStorageResourceIds: ["ad-storage"],
      adUserDataResourceIds: ["ad-user-data"],
      analyticsStorageResourceIds: ["analytics-storage"],
    });
  });

  it("rejects hidden controls in Google resource mappings", () => {
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        google: {
          command: () => undefined,
          mapping: { analyticsStorageResourceIds: ["ana\u200Blytics"] },
          mode: "basic",
        },
      }),
    ).toThrow(new TypeError("Invalid auto consent runtime options."));
  });

  it("canonicalizes Google resource mappings without changing list cardinality", () => {
    const captured = captureAutoOpenCookieRuntimeOptions({
      ...validRuntimeOptions(),
      google: {
        command: () => undefined,
        mapping: {
          analyticsStorageResourceIds: [
            " Analytics-Script ",
            "analytics-script",
          ],
        },
        mode: "basic",
      },
    });

    expect(captured.google?.mapping.analyticsStorageResourceIds).toEqual([
      "analytics-script",
      "analytics-script",
    ]);
  });

  it.each(["__proto__", "constructor"])(
    "preserves special controller identifier %s as an own frozen data property",
    (identifier) => {
      const captured = captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        controllers: Object.fromEntries([[identifier, validController()]]),
      });
      const controllers = captured.controllers;

      expect(controllers).toBeDefined();
      if (controllers === undefined) return;
      expect(Object.getPrototypeOf(controllers)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(controllers, identifier),
      ).toMatchObject({
        configurable: false,
        enumerable: true,
        writable: false,
      });
      expect(Object.isFrozen(controllers[identifier])).toBe(true);
    },
  );

  it("rejects malformed persistence configurations", () => {
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        persistence: "cookie",
      }),
    ).toThrow("Invalid auto consent runtime options.");
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        persistence: { kind: "cookie" },
      }),
    ).toThrow("Invalid auto consent runtime options.");
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        persistence: { kind: "unavailable", unexpected: true },
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("rejects malformed GPC observations", () => {
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        gpc: {
          navigationId: "https://example.com/",
          observations: [
            { observedAtMs: 500, source: "postal", value: "enabled" },
          ],
        },
      }),
    ).toThrow("Invalid auto consent runtime options.");
    expect(() =>
      captureAutoOpenCookieRuntimeOptions({
        ...validRuntimeOptions(),
        gpc: {
          navigationId: "https://example.com/",
          observations: [
            { observedAtMs: 0.5, source: "server", value: "enabled" },
          ],
        },
      }),
    ).toThrow("Invalid auto consent runtime options.");
  });

  it("preserves clock and identifier receivers with Reflect.apply", () => {
    const options = {
      idGenerator: function (this: unknown, kind: string) {
        expect(this).toBe(options);
        return `${kind}-1`;
      },
      now: function (this: unknown) {
        expect(this).toBe(options);
        return 1_000;
      },
      persistence: { kind: "unavailable" },
    };

    const captured = captureAutoOpenCookieRuntimeOptions(options);

    expect(captured.now()).toBe(1_000);
    expect(captured.idGenerator("record")).toBe("record-1");
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("captures own storage methods once and ignores later replacement", () => {
    const state = new Map<string, string>();
    const storage = {
      getItem: function (this: unknown, key: string) {
        expect(this).toBe(storage);
        return state.get(key) ?? null;
      },
      removeItem: function (this: unknown, key: string) {
        expect(this).toBe(storage);
        state.delete(key);
      },
      setItem: function (this: unknown, key: string, value: string) {
        expect(this).toBe(storage);
        state.set(key, value);
      },
    };
    const captured = captureAutoOpenCookieRuntimeOptions({
      ...validRuntimeOptions(),
      persistence: { kind: "local-storage", storage },
    });
    const persistence = captured.persistence;
    if (persistence.kind !== "local-storage") {
      throw new Error("Expected captured local-storage persistence.");
    }

    (storage as { setItem: unknown }).setItem = () => {
      throw new Error("replaced setItem must not run");
    };
    persistence.storage.setItem("opencookie.consent", "value");

    expect(state.get("opencookie.consent")).toBe("value");
    expect(persistence.storage.getItem("opencookie.consent")).toBe("value");
    expect(persistence.key).toBe("opencookie.consent");
  });

  it("accepts storage whose methods live on its prototype", () => {
    const storagePrototype = {
      getItem(this: { state: Map<string, string> }, key: string) {
        return this.state.get(key) ?? null;
      },
      removeItem(this: { state: Map<string, string> }, key: string) {
        this.state.delete(key);
      },
      setItem(
        this: { state: Map<string, string> },
        key: string,
        value: string,
      ) {
        this.state.set(key, value);
      },
    };
    const storage = Object.assign(
      Object.create(storagePrototype) as Record<string, unknown>,
      { state: new Map<string, string>() },
    );

    const captured = captureAutoOpenCookieRuntimeOptions({
      ...validRuntimeOptions(),
      persistence: { kind: "local-storage", storage },
    });
    const persistence = captured.persistence;
    if (persistence.kind !== "local-storage") {
      throw new Error("Expected captured local-storage persistence.");
    }

    persistence.storage.setItem("opencookie.consent", "value");
    expect(persistence.storage.getItem("opencookie.consent")).toBe("value");
  });

  it("captures cookie jar functions with their receiver", () => {
    const writes: string[] = [];
    const persistence = {
      hostname: "example.com",
      kind: "cookie",
      read: function (this: unknown) {
        expect(this).toBe(persistence);
        return "";
      },
      secure: true,
      write: function (this: unknown, serializedCookie: string) {
        expect(this).toBe(persistence);
        writes.push(serializedCookie);
      },
    };

    const captured = captureAutoOpenCookieRuntimeOptions({
      ...validRuntimeOptions(),
      persistence,
    });
    const capturedPersistence = captured.persistence;
    if (capturedPersistence.kind !== "cookie") {
      throw new Error("Expected captured cookie persistence.");
    }

    (persistence as { write: unknown }).write = () => {
      throw new Error("replaced write must not run");
    };
    capturedPersistence.write("opencookie-consent=value");

    expect(capturedPersistence.read()).toBe("");
    expect(writes).toEqual(["opencookie-consent=value"]);
    expect(capturedPersistence.key).toBe("opencookie-consent");
  });

  it("captures controller methods with their receiver", async () => {
    const operations: string[] = [];
    const controller = {
      block: function (this: unknown) {
        expect(this).toBe(controller);
        operations.push("block");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      cleanup: function (this: unknown) {
        expect(this).toBe(controller);
        operations.push("cleanup");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      discover: function (this: unknown) {
        expect(this).toBe(controller);
        operations.push("discover");
        return Promise.resolve("dormant" as const);
      },
      start: function (this: unknown) {
        expect(this).toBe(controller);
        operations.push("start");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      stop: function (this: unknown) {
        expect(this).toBe(controller);
        operations.push("stop");
        return Promise.resolve();
      },
    };

    const captured = captureAutoOpenCookieRuntimeOptions({
      ...validRuntimeOptions(),
      controllers: { "analytics-script": controller },
    });
    const capturedController = captured.controllers?.["analytics-script"];
    if (capturedController === undefined) {
      throw new Error("Expected a captured controller.");
    }

    await expect(capturedController.discover()).resolves.toBe("dormant");
    expect(operations).toEqual(["discover"]);
  });
});

describe("createAutoOpenCookieFactory immutability", () => {
  it("exposes the captured definition and domain-owned presentation", () => {
    const factory = createAutoOpenCookieFactory({
      consentDurationMs: 60_000,
      purposeId: "  Analytics  ",
    });
    expect(factory.purposeId).toBe("analytics");
    expect(factory.consentDurationMs).toBe(60_000);
    expect(factory.expandCategorySelection(["optional"])).toEqual([
      "analytics",
    ]);
    expect(factory.expandCategorySelection([" OPTIONAL "])).toEqual([
      "analytics",
    ]);
    expect(factory.expandCategorySelection(["unknown"])).toEqual([]);
    expect(factory.policySections).toEqual([
      { categoryId: "optional", purposeIds: ["analytics"] },
    ]);
    expect(Object.isFrozen(factory)).toBe(true);
    expect(Object.keys(factory).sort()).toEqual([
      "consentDurationMs",
      "create",
      "expandCategorySelection",
      "policySections",
      "purposeId",
    ]);
  });

  it.each(invalidCookieCases)(
    "retains auto validation for %s",
    (_label, persistence, expected) => {
      const factory = createAutoOpenCookieFactory({
        consentDurationMs: 60_000,
      });

      expect(() =>
        factory.create({
          idGenerator: createSequentialIdGenerator(),
          now: () => 1_000,
          persistence,
        }),
      ).toThrow(expected);
    },
  );

  it("ignores definition and option mutation after capture", async () => {
    const definition: Record<string, unknown> = {
      consentDurationMs: 60_000,
      purposeId: "analytics",
    };
    const factory = createAutoOpenCookieFactory(
      definition as unknown as Parameters<
        typeof createAutoOpenCookieFactory
      >[0],
    );
    definition["purposeId"] = "ads";
    definition["consentDurationMs"] = 1;

    const state = new Map<string, string>();
    const storage = {
      getItem: (key: string) => state.get(key) ?? null,
      removeItem: (key: string) => {
        state.delete(key);
      },
      setItem: (key: string, value: string) => {
        state.set(key, value);
      },
    };
    const resources = [
      { id: "analytics-script", serviceId: "analytics-service" },
    ];
    const options: Record<string, unknown> = {
      idGenerator: createSequentialIdGenerator(),
      now: () => 1_000,
      persistence: { kind: "local-storage", storage },
      resources,
    };
    const client = factory.create(
      options as unknown as Parameters<AutoFactory["create"]>[0],
    );
    options["now"] = () => {
      throw new Error("replaced clock must not run");
    };
    resources.push({ id: "late-script", serviceId: "late-service" });
    storage.setItem = () => {
      throw new Error("replaced setItem must not run");
    };

    await client.initialize();
    const result = await client.acceptAll();
    const snapshot = client.getSnapshot();

    expect(factory.purposeId).toBe("analytics");
    expect(result.outcome).toBe("committed");
    expect(snapshot.record).toMatchObject({ decidedAt: 1_000 });
    expect(snapshot.record?.expiresAt).toBe(61_000);
    expect(snapshot.runtime.accessPolicy.resources.map(({ id }) => id)).toEqual(
      ["analytics-script"],
    );
    expect(state.size).toBeGreaterThan(0);
  });

  it("canonicalizes controller keys with resource identifiers", async () => {
    const operations: string[] = [];
    const state = new Map<string, string>();
    const controller = {
      block: () => {
        operations.push("block");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      cleanup: () => {
        operations.push("cleanup");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      discover: () => {
        operations.push("discover");
        return Promise.resolve("dormant" as const);
      },
      start: () => {
        operations.push("start");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      stop: () => {
        operations.push("stop");
        return Promise.resolve();
      },
    };
    const factory = createAutoOpenCookieFactory({ consentDurationMs: 60_000 });
    const client = factory.create({
      controllers: { " Widget-Script ": controller },
      idGenerator: createSequentialIdGenerator(),
      now: () => 1_000,
      persistence: {
        kind: "local-storage",
        storage: {
          getItem: (key: string) => state.get(key) ?? null,
          removeItem: (key: string) => {
            state.delete(key);
          },
          setItem: (key: string, value: string) => {
            state.set(key, value);
          },
        },
      },
      resources: [{ id: " Widget-Script ", serviceId: " Widget-Service " }],
    } as unknown as Parameters<AutoFactory["create"]>[0]);

    await client.initialize();
    const result = await client.acceptAll();

    expect(result.outcome).toBe("committed");
    expect(operations).toEqual(["discover", "start"]);
    expect(client.getSnapshot().record?.decisions).toEqual([
      { purposeId: "analytics", value: "granted" },
    ]);
  });

  it("grants canonicalized duplicate Google resource mappings", async () => {
    const calls: unknown[][] = [];
    const state = new Map<string, string>();
    const factory = createAutoOpenCookieFactory({ consentDurationMs: 60_000 });
    const client = factory.create({
      google: {
        command: (...call) => calls.push(call),
        mapping: {
          analyticsStorageResourceIds: [
            " Analytics-Script ",
            "ANALYTICS-SCRIPT",
          ],
        },
        mode: "basic",
      },
      idGenerator: createSequentialIdGenerator(),
      now: () => 1_000,
      persistence: {
        kind: "local-storage",
        storage: {
          getItem: (key: string) => state.get(key) ?? null,
          removeItem: (key: string) => {
            state.delete(key);
          },
          setItem: (key: string, value: string) => {
            state.set(key, value);
          },
        },
      },
      resources: [
        { id: " Analytics-Script ", serviceId: " Analytics-Service " },
      ],
    });

    await client.initialize();
    await client.acceptAll();

    expect(calls.at(-1)).toEqual([
      "consent",
      "update",
      {
        ad_personalization: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        analytics_storage: "granted",
      },
    ]);
  });

  it("hands a frozen current-access enforcement closure to onEnforcementReady", async () => {
    const operations: string[] = [];
    const controller = {
      block: () => {
        operations.push("block");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      cleanup: () => {
        operations.push("cleanup");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      discover: () => {
        operations.push("discover");
        return Promise.resolve("dormant" as const);
      },
      start: () => {
        operations.push("start");
        return Promise.resolve({ irreversibleEffects: [] });
      },
      stop: () => {
        operations.push("stop");
        return Promise.resolve();
      },
    };
    const state = new Map<string, string>();
    let enforceCurrentAccess: (() => Promise<void>) | undefined;
    const factory = createAutoOpenCookieFactory({ consentDurationMs: 60_000 });
    const client = factory.create({
      controllers: { "analytics-script": controller },
      idGenerator: createSequentialIdGenerator(),
      now: () => 1_000,
      onEnforcementReady: (enforce: () => Promise<void>) => {
        enforceCurrentAccess = enforce;
      },
      persistence: {
        kind: "local-storage",
        storage: {
          getItem: (key: string) => state.get(key) ?? null,
          removeItem: (key: string) => {
            state.delete(key);
          },
          setItem: (key: string, value: string) => {
            state.set(key, value);
          },
        },
      },
      resources: [{ id: "analytics-script", serviceId: "analytics-service" }],
    } as unknown as Parameters<AutoFactory["create"]>[0]);

    expect(typeof enforceCurrentAccess).toBe("function");
    expect(Object.isFrozen(enforceCurrentAccess)).toBe(true);
    await client.initialize();
    const before = operations.length;
    await enforceCurrentAccess?.();
    expect(operations.length).toBeGreaterThan(before);
    expect(operations.slice(before)).toContain("discover");
  });

  it("hands a resolved enforcement closure without controllers", async () => {
    let enforceCurrentAccess: (() => Promise<void>) | undefined;
    const factory = createAutoOpenCookieFactory({ consentDurationMs: 60_000 });
    factory.create({
      idGenerator: createSequentialIdGenerator(),
      now: () => 1_000,
      onEnforcementReady: (enforce: () => Promise<void>) => {
        enforceCurrentAccess = enforce;
      },
      persistence: { kind: "unavailable" },
    } as unknown as Parameters<AutoFactory["create"]>[0]);

    expect(typeof enforceCurrentAccess).toBe("function");
    await expect(enforceCurrentAccess?.()).resolves.toBeUndefined();
  });

  it("exposes no public validation token from the auto barrel", async () => {
    const barrel = await import("../auto.js");
    expect(Object.keys(barrel).sort()).toEqual([
      "createAutoOpenCookieFactory",
      "establishAutoGoogleConsentDefaults",
    ]);
  });
});
