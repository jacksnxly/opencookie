import { readFileSync } from "node:fs";

import {
  CONSENT_RECORD_SCHEMA_VERSION,
  createLocalStorageDecisionStore,
  createOpenCookie,
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type ConsentReceipt,
  type ConsentRuntimeTransitionEffect,
  type OpenCookie,
  type OpenCookiePortContext,
  type PolicyResourceDefinition,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

const scriptControllerBoundary = vi.hoisted(() => ({
  controllerStarts: [] as Array<() => void>,
  discoverQueue: [] as Array<{
    readonly entered: () => void;
    readonly release: Promise<void>;
  }>,
  queue: [] as Array<{
    readonly cleaned: () => void;
    readonly entered: () => void;
    readonly release: Promise<void>;
  }>,
}));

vi.mock("./script-blocking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./script-blocking.js")>();
  return {
    ...actual,
    createBlockedScriptController: (
      options: Parameters<typeof actual.createBlockedScriptController>[0],
    ) => {
      const controller = actual.createBlockedScriptController(options);
      const observeUnderlyingStart =
        scriptControllerBoundary.controllerStarts.shift();
      let activeBoundary:
        (typeof scriptControllerBoundary.queue)[number] | undefined;
      let startCompleted = false;
      return {
        ...controller,
        async cleanup() {
          const result = await controller.cleanup();
          if (startCompleted) activeBoundary?.cleaned();
          return result;
        },
        async discover() {
          const result = await controller.discover();
          const boundary = scriptControllerBoundary.discoverQueue.shift();
          boundary?.entered();
          await boundary?.release;
          return result;
        },
        async start() {
          activeBoundary = scriptControllerBoundary.queue.shift();
          activeBoundary?.entered();
          await activeBoundary?.release;
          observeUnderlyingStart?.();
          const result = await controller.start();
          startCompleted = true;
          return result;
        },
      };
    },
  };
});

import {
  createOpenCookieBrowserBinding,
  type OpenCookieBrowserClientPorts,
  type OpenCookieBrowserReconcile,
  type OpenCookieBrowserStorage,
} from "./index.js";

const NOW = 1_700_000_000_000;

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface BindingFixture {
  readonly binding: ReturnType<typeof createOpenCookieBrowserBinding>;
  readonly client: OpenCookie;
  readonly factoryCalls: () => number;
  readonly ports: () => OpenCookieBrowserClientPorts;
}

function createBindingFixture(
  resources: readonly PolicyResourceDefinition[] = [
    {
      access: "optional",
      id: "analytics-script",
      purposeIds: ["analytics"],
      serviceId: "measurement-service",
    },
  ],
  options: {
    readonly beforeReconcile?: (
      effect: ConsentRuntimeTransitionEffect,
    ) => Promise<void>;
    readonly onReconcileError?: (
      effect: ConsentRuntimeTransitionEffect,
      error: unknown,
    ) => void;
    readonly onReconcile?: (effect: ConsentRuntimeTransitionEffect) => void;
    readonly receipt?: (receipt: ConsentReceipt) => Promise<void>;
    readonly wrapContext?: (
      context: OpenCookiePortContext | undefined,
    ) => OpenCookiePortContext | undefined;
  } = {},
): BindingFixture {
  const policy = definePolicy({
    dataCategories: [{ id: "usage-event" }],
    operations: [{ id: "aggregate-measurement" }],
    providers: [{ id: "site-operator" }],
    purposes: [
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Understand aggregate site usage.",
        id: "analytics",
        label: "Analytics",
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["session"],
      },
      {
        dataCategoryIds: ["usage-event"],
        disclosure: "Remember useful presentation choices.",
        id: "personalization",
        label: "Personalization",
        operationIds: ["aggregate-measurement"],
        providerIds: ["site-operator"],
        recipientIds: ["site-operator"],
        retentionIds: ["session"],
      },
    ],
    recipients: [{ id: "site-operator" }],
    retentions: [{ id: "session" }],
  });
  if (!policy.ok) throw new Error("Test policy must be valid.");
  const services = [
    ...new Set(resources.map((resource) => resource.serviceId)),
  ].map((id) => ({ id }));
  const resourcePolicy = defineResourcePolicy({
    policy: policy.policy,
    resources,
    services,
  });
  if (!resourcePolicy.ok) {
    throw new Error("Test resource policy must be valid.");
  }

  let factoryCalls = 0;
  let client: OpenCookie | undefined;
  let capturedPorts: OpenCookieBrowserClientPorts | undefined;
  const binding = createOpenCookieBrowserBinding({
    createClient: (ports) => {
      factoryCalls += 1;
      capturedPorts = ports;
      client = createOpenCookie({
        consentDurationMs: 86_400_000,
        idGenerator: ports.idGenerator,
        now: ports.now,
        policyHistory: [
          createPolicySnapshot({
            catalogueRevision: "catalogue-1",
            policy: policy.policy,
            policyVersion: "policy-1",
          }),
        ],
        policySnapshot: createPolicySnapshot({
          catalogueRevision: "catalogue-1",
          policy: policy.policy,
          policyVersion: "policy-1",
        }),
        reconcile: async (effect, context) => {
          options.onReconcile?.(effect);
          try {
            await options.beforeReconcile?.(effect);
            await ports.reconcile(
              effect,
              options.wrapContext?.(context) ?? context,
            );
          } catch (error) {
            options.onReconcileError?.(effect, error);
            throw error;
          }
        },
        ...(options.receipt === undefined ? {} : { receipt: options.receipt }),
        resourcePolicy: resourcePolicy.resourcePolicy,
        store: createLocalStorageDecisionStore({
          key: "opencookie.binding.test",
          schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
          storage: ports.storage,
        }),
      });
      return client;
    },
    now: () => NOW,
  });
  if (client === undefined) throw new Error("Client factory was not invoked.");

  return {
    binding,
    client,
    factoryCalls: () => factoryCalls,
    ports: () => {
      if (capturedPorts === undefined) {
        throw new Error("Browser client ports were not captured.");
      }
      return capturedPorts;
    },
  };
}

function transitionEffect(client: OpenCookie): ConsentRuntimeTransitionEffect {
  return {
    runtime: client.getServerSnapshot().runtime,
  } as ConsentRuntimeTransitionEffect;
}

function declaration(
  document: Document,
  resourceId: string,
  category: string,
): HTMLScriptElement {
  const script = document.createElement("script");
  script.type = "text/plain";
  script.dataset["ocCategory"] = category;
  script.dataset["ocResource"] = resourceId;
  script.textContent = "globalThis.__openCookieBindingTest = true";
  return script;
}

async function settleDom(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createOpenCookieBrowserBinding", () => {
  it("exports stable names for both public browser port types", () => {
    expectTypeOf<OpenCookieBrowserReconcile>().toEqualTypeOf<
      OpenCookieBrowserClientPorts["reconcile"]
    >();
    expectTypeOf<OpenCookieBrowserStorage>().toEqualTypeOf<
      OpenCookieBrowserClientPorts["storage"]
    >();
  });

  it("constructs one stable client without browser or storage access and fails closed before mount", async () => {
    expect(globalThis).not.toHaveProperty("window");
    expect(globalThis).not.toHaveProperty("document");
    const fixture = createBindingFixture();

    expect(fixture.binding.client).toBe(fixture.client);
    expect(fixture.factoryCalls()).toBe(1);
    expect(fixture.ports().storage.getItem("consent")).toBeNull();
    expect(() => {
      fixture.ports().storage.setItem("consent", "grant");
    }).toThrow("OpenCookie browser binding is not mounted.");
    expect(() => {
      fixture.ports().storage.removeItem("consent");
    }).toThrow("OpenCookie browser binding is not mounted.");
    expect(() => fixture.ports().idGenerator("record")).toThrow(
      "OpenCookie browser binding is not mounted.",
    );
    await expect(
      fixture.ports().reconcile(transitionEffect(fixture.client)),
    ).rejects.toThrow("OpenCookie browser binding is not mounted.");

    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const localStorage = browserWindow.localStorage;
    let storageGetterCalls = 0;
    Object.defineProperty(browserWindow, "localStorage", {
      configurable: true,
      get() {
        storageGetterCalls += 1;
        if (storageGetterCalls === 1) {
          throw new DOMException("Storage blocked", "SecurityError");
        }
        return localStorage;
      },
    });
    const mounted = fixture.binding.mount({
      document: browserWindow.document as unknown as Document,
    });
    await expect(mounted.ready).resolves.toBeUndefined();
    await expect(fixture.client.acceptAll()).resolves.toMatchObject({
      outcome: "committed",
    });
    expect(fixture.binding.client).toBe(fixture.client);
    expect(storageGetterCalls).toBeGreaterThanOrEqual(2);
    expect(localStorage.getItem("opencookie.binding.test")).not.toBeNull();
    expect(fixture.ports().idGenerator("transition")).toMatch(/^transition-/u);

    mounted.destroy();
    browserWindow.close();
  });

  it("owns one controller for every static optional resource, including dormant and multi-purpose resources", async () => {
    const fixture = createBindingFixture([
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics", "personalization"],
        serviceId: "measurement-service",
      },
      {
        access: "declared-exception",
        exceptionReason: "Required to retain the current checkout session.",
        id: "session-cookie",
        serviceId: "session-service",
      },
    ]);
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    const mounted = fixture.binding.mount({ document });
    await mounted.ready;

    expect(document.querySelector("[data-oc-active-resource]")).toBeNull();
    expect(document.querySelector(".oc-panel")?.childElementCount).toBe(0);
    const settings = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="settings"]',
    );
    expect(settings).not.toBeNull();
    settings?.click();
    expect(
      document.querySelector("[data-oc-exceptions]")?.textContent,
    ).toContain("session-cookie");
    await fixture.client.acceptAll();

    const lateDeclaration = declaration(
      document,
      "analytics-script",
      "personalization",
    );
    document.head.append(lateDeclaration);
    await settleDom();

    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);
    mounted.destroy();
    await settleDom();
    expect(document.querySelector("[data-oc-active-resource]")).toBeNull();
    browserWindow.close();
  });

  it("keeps one active controller when a static multi-purpose source changes category", async () => {
    const fixture = createBindingFixture([
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics", "personalization"],
        serviceId: "measurement-service",
      },
    ]);
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    const mounted = fixture.binding.mount({ document });
    await mounted.ready;
    await fixture.client.acceptAll();

    const source = declaration(document, "analytics-script", "personalization");
    document.head.append(source);
    await settleDom();
    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);

    source.remove();
    source.dataset["ocCategory"] = "analytics";
    document.head.append(source);
    await settleDom();

    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);

    mounted.destroy();
    browserWindow.close();
  });

  it.each([
    {
      category: "personalization",
      expected: "does not allow category personalization",
      resourceId: "analytics-script",
    },
    {
      category: "analytics",
      expected: "is not an optional resource",
      resourceId: "session-cookie",
    },
    {
      category: "analytics",
      expected: "is not present in the static resource policy",
      resourceId: "unknown-script",
    },
  ])(
    "rejects an initial $resourceId/$category declaration mismatch clearly",
    ({ category, expected, resourceId }) => {
      const fixture = createBindingFixture([
        {
          access: "optional",
          id: "analytics-script",
          purposeIds: ["analytics"],
          serviceId: "measurement-service",
        },
        {
          access: "declared-exception",
          exceptionReason: "Required to retain the current checkout session.",
          id: "session-cookie",
          serviceId: "session-service",
        },
      ]);
      const browserWindow = new Window({ url: "https://shop.example.test/" });
      const document = browserWindow.document as unknown as Document;
      document.head.append(declaration(document, resourceId, category));

      expect(() => fixture.binding.mount({ document })).toThrow(expected);

      browserWindow.close();
    },
  );

  it("reports a late category mismatch and keeps the declaration inert", async () => {
    const fixture = createBindingFixture();
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    const errors: unknown[] = [];
    const mounted = fixture.binding.mount({
      document,
      onError: (error) => errors.push(error),
    });
    await mounted.ready;
    await fixture.client.acceptAll();

    const mismatched = declaration(
      document,
      "analytics-script",
      "personalization",
    );
    document.head.append(mismatched);
    await settleDom();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    expect(String(errors[0])).toContain(
      "does not allow category personalization",
    );
    expect(mismatched.type).toBe("text/plain");
    expect(document.querySelector("[data-oc-active-resource]")).toBeNull();

    mounted.destroy();
    browserWindow.close();
  });

  it.each([
    {
      action: "reject" as const,
      category: "analytics",
      expected: "is not present in the static resource policy",
      resourceId: "unknown-script",
    },
    {
      action: "withdraw" as const,
      category: "personalization",
      expected: "does not allow category personalization",
      resourceId: "analytics-script",
    },
  ])(
    "fails closed an active resource when $action encounters a late $resourceId/$category declaration",
    async ({ action, category, expected, resourceId }) => {
      const fixture = createBindingFixture();
      const browserWindow = new Window({ url: "https://shop.example.test/" });
      const document = browserWindow.document as unknown as Document;
      const errors: unknown[] = [];
      document.head.append(
        declaration(document, "analytics-script", "analytics"),
      );
      const mounted = fixture.binding.mount({
        document,
        onError: (error) => errors.push(error),
      });
      await mounted.ready;
      await fixture.client.acceptAll();
      expect(
        document.querySelectorAll(
          '[data-oc-active-resource="analytics-script"]',
        ),
      ).toHaveLength(1);

      document.head.append(declaration(document, resourceId, category));
      const terminal = await (action === "reject"
        ? fixture.client.rejectAll()
        : fixture.client.withdrawConsent());
      await settleDom();

      expect(terminal.outcome).toBe("degraded");
      if (terminal.outcome !== "degraded") {
        throw new Error("Invalid markup must degrade the terminal result.");
      }
      expect(terminal.diagnostics).toContainEqual({
        code: "denial-reconcile-failed",
      });
      expect(
        document.querySelector('[data-oc-active-resource="analytics-script"]'),
      ).toBeNull();
      expect(errors.some((error) => String(error).includes(expected))).toBe(
        true,
      );

      mounted.destroy();
      browserWindow.close();
    },
  );

  // A withdrawal in another tab must stop this tab's optional resources too.
  // The page reloads to re-read the stored decision. Its own decisions reload it
  // only when they turn off a script it ran (withdrawal-teardown.test.ts).
  it("reloads when another tab rewrites the stored decision", async () => {
    const fixture = createBindingFixture();
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    const reload = vi
      .spyOn(browserWindow.location, "reload")
      .mockImplementation(() => undefined);
    const mounted = fixture.binding.mount({ document });
    await mounted.ready;
    await fixture.client.acceptAll();
    await settleDom();

    browserWindow.localStorage.setItem("unrelated", "x");
    browserWindow.dispatchEvent(
      new browserWindow.StorageEvent("storage", {
        key: "unrelated",
        newValue: "x",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).not.toHaveBeenCalled();

    browserWindow.localStorage.setItem(
      "opencookie.binding.test",
      "written elsewhere",
    );
    browserWindow.dispatchEvent(
      new browserWindow.StorageEvent("storage", {
        key: "opencookie.binding.test",
        newValue: "written elsewhere",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(reload).toHaveBeenCalledTimes(1);

    mounted.destroy();
    browserWindow.close();
  });

  it("allows one active mount and mirrors Strict Mode setup, cleanup, and setup", async () => {
    const fixture = createBindingFixture();
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    const disconnect = vi.spyOn(
      browserWindow.MutationObserver.prototype,
      "disconnect",
    );
    const abort = vi.spyOn(browserWindow.AbortController.prototype, "abort");

    const first = fixture.binding.mount({ document });
    await first.ready;
    expect(() => fixture.binding.mount({ document })).toThrow(
      "OpenCookie browser binding already has an active mount.",
    );
    first.destroy();

    const second = fixture.binding.mount({ document });
    await second.ready;
    expect(fixture.binding.client).toBe(fixture.client);
    expect(document.querySelectorAll("[data-oc-root]")).toHaveLength(1);
    second.destroy();
    second.destroy();
    await settleDom();

    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(document.querySelector("[data-oc-root]")).toBeNull();
    expect(document.querySelector("style[data-opencookie]")).toBeNull();

    disconnect.mockRestore();
    abort.mockRestore();
    browserWindow.close();
  });

  it("hands an in-flight grant to the current mount before it reports active", async () => {
    const fixture = createBindingFixture();
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    document.head.append(
      declaration(document, "analytics-script", "analytics"),
    );
    const first = fixture.binding.mount({ document });
    await first.ready;

    const firstControllerStarted = deferred();
    const releaseFirstController = deferred();
    const firstControllerCleaned = deferred();
    const currentControllerStarted = deferred();
    const releaseCurrentController = deferred();
    let currentControllerHasStarted = false;
    scriptControllerBoundary.queue.push(
      {
        cleaned: firstControllerCleaned.resolve,
        entered: firstControllerStarted.resolve,
        release: releaseFirstController.promise,
      },
      {
        cleaned: () => undefined,
        entered: () => {
          currentControllerHasStarted = true;
          currentControllerStarted.resolve();
        },
        release: releaseCurrentController.promise,
      },
    );
    let grantSettled = false;
    const grant = fixture.client.acceptAll().then((result) => {
      grantSettled = true;
      return result;
    });
    await firstControllerStarted.promise;

    first.destroy();
    first.destroy();
    const current = fixture.binding.mount({ document });
    const currentReady = current.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentControllerHasStarted).toBe(false);
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();

    releaseFirstController.resolve();
    await firstControllerCleaned.promise;
    await currentControllerStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(grantSettled).toBe(false);

    releaseCurrentController.resolve();
    await currentReady;
    await expect(grant).resolves.toMatchObject({ outcome: "committed" });

    expect(fixture.client.getSnapshot().grantActivation).toBe("active");
    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);

    current.destroy();
    current.destroy();
    browserWindow.close();
  });

  it("preserves the cleanup barrier through a mount destroyed before ready", async () => {
    const fixture = createBindingFixture();
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    document.head.append(
      declaration(document, "analytics-script", "analytics"),
    );
    const first = fixture.binding.mount({ document });
    await first.ready;

    const releaseFirstController = deferred();
    const firstControllerStarted = deferred();
    const firstControllerCleaned = deferred();
    const releaseCurrentController = deferred();
    const currentControllerStarted = deferred();
    let currentControllerHasStarted = false;
    scriptControllerBoundary.queue.push(
      {
        cleaned: firstControllerCleaned.resolve,
        entered: firstControllerStarted.resolve,
        release: releaseFirstController.promise,
      },
      {
        cleaned: () => undefined,
        entered: () => {
          currentControllerHasStarted = true;
          currentControllerStarted.resolve();
        },
        release: releaseCurrentController.promise,
      },
    );
    const grant = fixture.client.acceptAll();
    await firstControllerStarted.promise;

    first.destroy();
    const transient = fixture.binding.mount({ document });
    const transientReady = transient.ready;
    transient.destroy();
    const current = fixture.binding.mount({ document });
    const currentReady = current.ready;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentControllerHasStarted).toBe(false);

    releaseFirstController.resolve();
    await firstControllerCleaned.promise;
    await currentControllerStarted.promise;
    releaseCurrentController.resolve();
    await Promise.all([transientReady, currentReady, grant]);

    expect(fixture.client.getSnapshot().grantActivation).toBe("active");
    expect(
      document.querySelectorAll('[data-oc-active-resource="analytics-script"]'),
    ).toHaveLength(1);

    current.destroy();
    browserWindow.close();
  });

  it("does not start a stale grant after the same mount receives newer denied authority", async () => {
    const underlyingStart = vi.fn();
    scriptControllerBoundary.controllerStarts.push(underlyingStart);
    let deniedEffect: ConsentRuntimeTransitionEffect | undefined;
    const denialReconciliationStarted = deferred();
    const fixture = createBindingFixture(undefined, {
      onReconcile: (effect) => {
        if (effect.record.method !== "reject-all") return;
        deniedEffect = effect;
        denialReconciliationStarted.resolve();
      },
    });
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    document.head.append(
      declaration(document, "analytics-script", "analytics"),
    );
    const mounted = fixture.binding.mount({ document });
    await mounted.ready;

    const grantDiscoveryReachedStartBoundary = deferred();
    const releaseGrantDiscovery = deferred();
    scriptControllerBoundary.discoverQueue.push({
      entered: grantDiscoveryReachedStartBoundary.resolve,
      release: releaseGrantDiscovery.promise,
    });
    const staleGrant = fixture.client.acceptAll();
    await grantDiscoveryReachedStartBoundary.promise;

    const rejection = fixture.client.rejectAll();
    await denialReconciliationStarted.promise;
    expect(deniedEffect?.runtime.effectiveAccess.resources).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );

    releaseGrantDiscovery.resolve();
    await Promise.allSettled([staleGrant, rejection]);
    await settleDom();

    expect(underlyingStart).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(
      (browserWindow as unknown as Record<string, unknown>)[
        "__openCookieBindingTest"
      ],
    ).not.toBe(true);
    const denied = fixture.client.getSnapshot();
    expect(denied.pendingGrant).toBeUndefined();
    expect(denied.grantActivation).not.toBe("active");
    expect(denied.runtime.effectiveAccess.resources).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );

    mounted.destroy();
    mounted.destroy();
    browserWindow.close();
  });

  it("does not trust cached grant authority after a denial publishes before its reconciliation port", async () => {
    const underlyingStart = vi.fn();
    scriptControllerBoundary.controllerStarts.push(underlyingStart);
    const denialReachedPortBoundary = deferred();
    const releaseDenialPort = deferred();
    const fixture = createBindingFixture(undefined, {
      beforeReconcile: async (effect) => {
        if (effect.record.method !== "reject-all") return;
        denialReachedPortBoundary.resolve();
        await releaseDenialPort.promise;
      },
    });
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    document.head.append(
      declaration(document, "analytics-script", "analytics"),
    );
    const mounted = fixture.binding.mount({ document });
    await mounted.ready;

    const grantDiscoveryReachedStartBoundary = deferred();
    const releaseGrantDiscovery = deferred();
    scriptControllerBoundary.discoverQueue.push({
      entered: grantDiscoveryReachedStartBoundary.resolve,
      release: releaseGrantDiscovery.promise,
    });
    const staleGrant = fixture.client.acceptAll();
    await grantDiscoveryReachedStartBoundary.promise;

    const rejection = fixture.client.rejectAll();
    await denialReachedPortBoundary.promise;
    const denied = fixture.client.getSnapshot();
    expect(denied.pendingGrant).toBeUndefined();
    expect(denied.runtime.effectiveAccess.resources).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );

    releaseGrantDiscovery.resolve();
    await settleDom();
    const startsBeforeDenialPort = underlyingStart.mock.calls.length;
    const executedBeforeDenialPort = (
      browserWindow as unknown as Record<string, unknown>
    )["__openCookieBindingTest"];
    releaseDenialPort.resolve();
    await Promise.allSettled([staleGrant, rejection]);
    await settleDom();

    expect(startsBeforeDenialPort).toBe(0);
    expect(executedBeforeDenialPort).not.toBe(true);
    expect(underlyingStart).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(fixture.client.getSnapshot().grantActivation).not.toBe("active");

    mounted.destroy();
    mounted.destroy();
    browserWindow.close();
  });

  it("does not start an obsolete controller after a remount establishes newer denied authority", async () => {
    const underlyingStarts = vi.fn();
    scriptControllerBoundary.controllerStarts.push(
      underlyingStarts,
      underlyingStarts,
    );
    const fixture = createBindingFixture();
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    document.head.append(
      declaration(document, "analytics-script", "analytics"),
    );
    const first = fixture.binding.mount({ document });
    await first.ready;

    const oldDiscoveryReachedStartBoundary = deferred();
    const releaseOldDiscovery = deferred();
    scriptControllerBoundary.discoverQueue.push({
      entered: oldDiscoveryReachedStartBoundary.resolve,
      release: releaseOldDiscovery.promise,
    });
    const oldGrant = fixture.client.acceptAll();
    await oldDiscoveryReachedStartBoundary.promise;

    first.destroy();
    first.destroy();
    const current = fixture.binding.mount({ document });
    const currentReady = current.ready;
    const rejection = await fixture.client.rejectAll();
    expect(["committed", "degraded"]).toContain(rejection.outcome);
    releaseOldDiscovery.resolve();
    await expect(currentReady).resolves.toBeUndefined();
    const denied = fixture.client.getSnapshot();
    expect(denied.pendingGrant).toBeUndefined();
    expect(denied.runtime.effectiveAccess.resources).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );
    await Promise.allSettled([oldGrant]);
    await settleDom();

    expect(underlyingStarts).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(
      (browserWindow as unknown as Record<string, unknown>)[
        "__openCookieBindingTest"
      ],
    ).not.toBe(true);
    const finalSnapshot = fixture.client.getSnapshot();
    expect(finalSnapshot.pendingGrant).toBeUndefined();
    expect(finalSnapshot.grantActivation).not.toBe("active");
    expect(finalSnapshot.runtime.effectiveAccess.resources).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );

    current.destroy();
    current.destroy();
    browserWindow.close();
  });

  it("durably establishes denied authority when an in-flight grant loses its only mount", async () => {
    const underlyingStart = vi.fn();
    scriptControllerBoundary.controllerStarts.push(underlyingStart);
    let grantEffect: ConsentRuntimeTransitionEffect | undefined;
    const reconciledMethods: string[] = [];
    const receipts: ConsentReceipt[] = [];
    const correctionResults: Awaited<
      ReturnType<OpenCookiePortContext["rejectAll"]>
    >[] = [];
    const fixture = createBindingFixture(undefined, {
      onReconcile: (effect) => {
        reconciledMethods.push(effect.record.method);
        if (effect.record.method === "accept-all") grantEffect = effect;
      },
      receipt: (receipt) => {
        receipts.push(receipt);
        return Promise.resolve();
      },
      wrapContext: (context) =>
        context === undefined
          ? undefined
          : Object.freeze({
              rejectAll: async () => {
                const result = await context.rejectAll();
                correctionResults.push(result);
                return result;
              },
              withdrawConsent: () => context.withdrawConsent(),
            }),
    });
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const document = browserWindow.document as unknown as Document;
    document.head.append(
      declaration(document, "analytics-script", "analytics"),
    );
    const onlyMount = fixture.binding.mount({ document });
    await onlyMount.ready;

    const discoveryReachedStartBoundary = deferred();
    const releaseDiscovery = deferred();
    scriptControllerBoundary.discoverQueue.push({
      entered: discoveryReachedStartBoundary.resolve,
      release: releaseDiscovery.promise,
    });
    const grant = fixture.client.acceptAll();
    await discoveryReachedStartBoundary.promise;
    const acceptedBytes = browserWindow.localStorage.getItem(
      "opencookie.binding.test",
    );
    expect(acceptedBytes).not.toBeNull();

    onlyMount.destroy();
    onlyMount.destroy();
    releaseDiscovery.resolve();
    await Promise.allSettled([grant]);
    await settleDom();

    expect(reconciledMethods).toContain("reject-all");
    const denied = fixture.client.getSnapshot();
    expect(denied.pendingGrant).toBeUndefined();
    expect(denied.grantActivation).not.toBe("active");
    expect(denied.runtime.effectiveAccess.resources).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );
    expect(underlyingStart).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();
    expect(correctionResults).toHaveLength(1);
    expect(correctionResults[0]).toMatchObject({
      transition: { persistenceStatus: "confirmed" },
    });
    expect(receipts).toContainEqual(
      expect.objectContaining({
        method: "reject-all",
        persistenceStatus: "confirmed",
      }),
    );
    const deniedBytes = browserWindow.localStorage.getItem(
      "opencookie.binding.test",
    );
    expect(deniedBytes).not.toBeNull();
    expect(deniedBytes).not.toBe(acceptedBytes);

    if (grantEffect === undefined) {
      throw new Error("The in-flight grant effect must be observed.");
    }
    await expect(fixture.ports().reconcile(grantEffect)).rejects.toThrow(
      "OpenCookie browser binding is not mounted.",
    );
    expect(fixture.client.getSnapshot()).toBe(denied);

    const unmountedGrant = await fixture.client.acceptAll();
    expect(unmountedGrant.outcome).not.toBe("committed");
    expect(fixture.client.getSnapshot().grantActivation).not.toBe("active");
    expect(
      fixture.client.getSnapshot().runtime.effectiveAccess.resources,
    ).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );

    const reloaded = createBindingFixture();
    const reloadedMount = reloaded.binding.mount({ document });
    await reloadedMount.ready;
    const restoredDenial = reloaded.client.getSnapshot();
    expect(restoredDenial.grantActivation).not.toBe("active");
    expect(restoredDenial.runtime.effectiveAccess.resources).toContainEqual(
      expect.objectContaining({
        access: "blocked",
        resourceId: "analytics-script",
      }),
    );
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();

    reloadedMount.destroy();
    reloadedMount.destroy();

    browserWindow.close();
  });

  it("surfaces a mount-loss correction whose denial persistence is unconfirmed", async () => {
    const correctionResults: Awaited<
      ReturnType<OpenCookiePortContext["rejectAll"]>
    >[] = [];
    const reconcileErrors: {
      readonly error: unknown;
      readonly method: string;
    }[] = [];
    const fixture = createBindingFixture(undefined, {
      onReconcileError: (effect, error) => {
        reconcileErrors.push({ error, method: effect.record.method });
      },
      wrapContext: (context) =>
        context === undefined
          ? undefined
          : Object.freeze({
              rejectAll: async () => {
                const result = await context.rejectAll();
                correctionResults.push(result);
                return result;
              },
              withdrawConsent: () => context.withdrawConsent(),
            }),
    });
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const localStorage = browserWindow.localStorage;
    let writes = 0;
    Object.defineProperty(browserWindow, "localStorage", {
      configurable: true,
      get: () => ({
        getItem: (key: string) => localStorage.getItem(key),
        removeItem: (key: string) => {
          localStorage.removeItem(key);
        },
        setItem: (key: string, value: string) => {
          writes += 1;
          if (writes > 2) {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }
          localStorage.setItem(key, value);
        },
      }),
    });
    const document = browserWindow.document as unknown as Document;
    document.head.append(
      declaration(document, "analytics-script", "analytics"),
    );
    const mounted = fixture.binding.mount({ document });
    await mounted.ready;

    const discoveryReachedStartBoundary = deferred();
    const releaseDiscovery = deferred();
    scriptControllerBoundary.discoverQueue.push({
      entered: discoveryReachedStartBoundary.resolve,
      release: releaseDiscovery.promise,
    });
    const grant = fixture.client.acceptAll();
    await discoveryReachedStartBoundary.promise;
    expect(localStorage.getItem("opencookie.binding.test")).not.toBeNull();

    mounted.destroy();
    releaseDiscovery.resolve();
    const grantResult = await grant;
    await settleDom();

    expect(correctionResults).toHaveLength(1);
    expect(correctionResults[0]).toMatchObject({
      transition: { persistenceStatus: "failed" },
    });
    expect(reconcileErrors).toHaveLength(1);
    expect(reconcileErrors[0]?.method).toBe("accept-all");
    expect(reconcileErrors[0]?.error).toBeInstanceOf(Error);
    expect((reconcileErrors[0]?.error as Error).message).toBe(
      "OpenCookie could not persist fail-closed authority after its browser mount was lost.",
    );
    expect(grantResult.outcome).not.toBe("committed");
    expect(fixture.client.getSnapshot().grantActivation).not.toBe("active");
    expect(
      document.querySelector('[data-oc-active-resource="analytics-script"]'),
    ).toBeNull();

    mounted.destroy();
    browserWindow.close();
  });

  it("keeps fallback transition identifiers unique across remounts with deferred receipts", async () => {
    const receiptArrivals = [deferred(), deferred(), deferred()];
    const receiptReleases = [deferred(), deferred(), deferred()];
    const receipts: ConsentReceipt[] = [];
    const fixture = createBindingFixture(undefined, {
      receipt: async (receipt) => {
        const index = receipts.length;
        receipts.push(receipt);
        receiptArrivals[index]?.resolve();
        await receiptReleases[index]?.promise;
      },
    });
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    Object.defineProperty(browserWindow.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    const document = browserWindow.document as unknown as Document;

    const first = fixture.binding.mount({ document });
    await first.ready;
    const accepted = fixture.client.acceptAll();
    await receiptArrivals[0]?.promise;
    first.destroy();
    first.destroy();
    receiptReleases[0]?.resolve();
    await expect(accepted).resolves.toMatchObject({ outcome: "committed" });

    const second = fixture.binding.mount({ document });
    await second.ready;
    const rejected = fixture.client.rejectAll();
    await receiptArrivals[1]?.promise;
    second.destroy();
    second.destroy();
    receiptReleases[1]?.resolve();
    await expect(rejected).resolves.toMatchObject({ outcome: "committed" });

    const third = fixture.binding.mount({ document });
    await third.ready;
    const acceptedAgain = fixture.client.acceptAll();
    await receiptArrivals[2]?.promise;
    third.destroy();
    third.destroy();
    receiptReleases[2]?.resolve();
    await expect(acceptedAgain).resolves.toMatchObject({
      outcome: "committed",
    });

    expect(receipts).toHaveLength(3);
    const transitionIds = receipts.map((receipt) => receipt.transitionId);
    expect(new Set(transitionIds).size).toBe(transitionIds.length);

    browserWindow.close();
  });

  it("delegates lifecycle ownership to browser-runtime and leaves mountOpenCookie presentation-only", () => {
    const bindingSource = readFileSync(
      new URL("./browser-binding.ts", import.meta.url),
      "utf8",
    );
    const publicMountSource = readFileSync(
      new URL("./public-mount.ts", import.meta.url),
      "utf8",
    );

    expect(bindingSource).toContain('from "./browser-runtime.js"');
    expect(bindingSource).toContain("createVanillaBrowserRuntime");
    expect(bindingSource).toContain("defaultBrowserIdGenerator");
    expect(bindingSource).toContain("defaultBrowserStorage");
    expect(bindingSource).not.toContain("MutationObserver");
    expect(bindingSource).not.toContain("pageshow");
    expect(bindingSource).not.toContain("randomUUID");
    expect(bindingSource).not.toContain("visibilitychange");
    expect(publicMountSource).not.toContain("browser-binding");
    expect(publicMountSource).not.toContain("browser-runtime");
  });
});
