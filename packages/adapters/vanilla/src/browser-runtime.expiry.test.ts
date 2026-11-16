import type { OpenCookie, OpenCookieSnapshot } from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { createVanillaBrowserRuntime } from "./browser-runtime.js";

const MAX_BROWSER_TIMER_DELAY_MS = 2_147_483_647;

function snapshot(): OpenCookieSnapshot {
  return {
    diagnostics: [],
    grantActivation: "not-applicable",
    policySnapshot: {
      policy: {
        purposes: [
          {
            dependsOn: [],
            disclosure: "Analytics disclosure.",
            id: "analytics",
            label: "Analytics",
          },
        ],
      },
    },
    preferencesOpen: false,
    readiness: "ready",
    runtime: {
      accessConsent: {
        decisions: [{ decision: "denied", purposeId: "analytics" }],
        status: "active",
      },
      accessPolicy: {
        purposes: [{ dependsOn: [], id: "analytics" }],
        resources: [],
        valid: true,
      },
      consentEvaluation: {
        issues: [],
        prompt: false,
        status: "active",
      },
      effectiveAccess: { resources: [] },
      permittedPurposeIds: [],
    },
  } as unknown as OpenCookieSnapshot;
}

function fakeClient(): {
  readonly client: OpenCookie;
  readonly listenerCount: () => number;
  readonly publish: () => void;
} {
  const listeners = new Set<() => void>();
  const current = snapshot();
  const unchanged = () =>
    Promise.resolve({ outcome: "unchanged" as const } as never);
  return {
    client: {
      acceptAll: unchanged,
      closePreferences: () => undefined,
      getServerSnapshot: () => current,
      getSnapshot: () => current,
      initialize: () => Promise.resolve(current),
      openPreferences: () => undefined,
      refresh: () => Promise.resolve(current),
      rejectAll: unchanged,
      retryPendingGrant: unchanged,
      savePreferences: unchanged,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      withdrawConsent: unchanged,
    },
    listenerCount: () => listeners.size,
    publish: () => {
      for (const listener of listeners) listener();
    },
  };
}

interface TimerRecord {
  readonly callback: () => void;
  readonly delay: number;
}

type TimerIdentifier = number;

interface TestTimerWindow {
  readonly clearTimeout: (identifier: TimerIdentifier) => void;
  readonly setTimeout: (
    callback: () => void,
    delay?: number,
  ) => TimerIdentifier;
}

function installTimerHarness(browserWindow: Window): {
  readonly clearCalls: ReturnType<typeof vi.fn>;
  readonly fire: (identifier: TimerIdentifier) => void;
  readonly latest: () => readonly [TimerIdentifier, TimerRecord] | undefined;
  readonly pending: () => number;
} {
  let sequence = 0;
  const timers = new Map<TimerIdentifier, TimerRecord>();
  const timerWindow = browserWindow as unknown as TestTimerWindow;
  const clearCalls = vi.fn((identifier: TimerIdentifier) => {
    timers.delete(identifier);
  });
  vi.spyOn(timerWindow, "setTimeout").mockImplementation(
    (callback: () => void, delay?: number) => {
      const identifier = ++sequence;
      timers.set(identifier, {
        callback: () => {
          callback();
        },
        delay: delay ?? 0,
      });
      return identifier;
    },
  );
  vi.spyOn(timerWindow, "clearTimeout").mockImplementation(clearCalls);
  return {
    clearCalls,
    fire(identifier) {
      const timer = timers.get(identifier);
      if (timer === undefined) {
        throw new Error(`Unknown timer ${String(identifier)}.`);
      }
      timers.delete(identifier);
      timer.callback();
    },
    latest: () => [...timers.entries()].at(-1),
    pending: () => timers.size,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly reject: (error: unknown) => void;
  readonly resolve: () => void;
} {
  let rejectPromise: ((error: unknown) => void) | undefined;
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: (error) => rejectPromise?.(error),
    resolve: () => resolvePromise?.(),
  };
}

function trackedRefresh(...settlements: readonly Promise<void>[]): {
  readonly maximumActive: () => number;
  readonly refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  let active = 0;
  let invocation = 0;
  let maximumActive = 0;
  return {
    maximumActive: () => maximumActive,
    refresh: vi.fn(async () => {
      const settlement = settlements[invocation] ?? Promise.resolve();
      invocation += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await settlement;
      } finally {
        active -= 1;
      }
    }),
  };
}

function startExpiryRuntime(
  browserWindow: Window,
  options: {
    readonly beforeResourceReconciliation?: (() => Promise<void>) | undefined;
    readonly client: OpenCookie;
    readonly now: () => number;
    readonly onError?: (error: unknown) => void;
    readonly reconcile?: (() => Promise<void>) | undefined;
    readonly refresh: () => Promise<void>;
    readonly refreshAt: () => number | undefined;
  },
) {
  const document = browserWindow.document as unknown as Document;
  return createVanillaBrowserRuntime({
    categoryDependencyResolver: (_policy, purposeIds) => purposeIds,
    categoryResolver: () => [],
    document,
    knownPurposeIds: new Set(["analytics"]),
    ...(options.beforeResourceReconciliation === undefined
      ? {}
      : {
          beforeResourceReconciliation: options.beforeResourceReconciliation,
        }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    purposeResolver: (_policy, purposeId) => [purposeId],
    sectionResolver: (policy) => [
      {
        categoryId: null,
        checked: false,
        indeterminate: false,
        purposeIds: policy.purposes.map(({ id }) => id),
      },
    ],
    prepareProduct: () => () => [
      options.client,
      options.reconcile ?? (() => Promise.resolve()),
      {
        now: options.now,
        refresh: options.refresh,
        refreshAt: options.refreshAt,
      },
    ],
  });
}

describe("vanilla browser expiry observation", () => {
  it.each(["initialization", "cleanup", "reconciliation"] as const)(
    "starts recovery observation after initial %s failure",
    async (failurePoint) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const document = browserWindow.document as unknown as Document;
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = "analytics";
      resource.dataset["ocResource"] = "analytics-script";
      document.head.append(resource);

      const NativeMutationObserver = browserWindow.MutationObserver;
      const allocations = vi.fn();
      class InstrumentedMutationObserver extends NativeMutationObserver {
        constructor(
          callback: ConstructorParameters<typeof NativeMutationObserver>[0],
        ) {
          super(callback);
          allocations();
        }
      }
      Reflect.set(
        browserWindow,
        "MutationObserver",
        InstrumentedMutationObserver,
      );
      const observe = vi.spyOn(
        InstrumentedMutationObserver.prototype,
        "observe",
      );
      const timers = installTimerHarness(browserWindow);
      const fixture = fakeClient();
      const failure = new Error(`initial ${failurePoint} failure`);
      let initializationAttempts = 0;
      const client: OpenCookie = {
        ...fixture.client,
        initialize: () => {
          if (
            failurePoint === "initialization" &&
            initializationAttempts++ === 0
          ) {
            return Promise.reject(failure);
          }
          return fixture.client.initialize();
        },
      };
      const reconcile = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(() =>
          failurePoint === "reconciliation"
            ? Promise.reject(failure)
            : Promise.resolve(),
        )
        .mockResolvedValue();
      const refresh = vi.fn(() => Promise.resolve());
      let now = 1_000;
      let refreshAt: number | undefined = undefined;
      const runtime = startExpiryRuntime(browserWindow, {
        beforeResourceReconciliation: () =>
          failurePoint === "cleanup"
            ? Promise.reject(failure)
            : Promise.resolve(),
        client,
        now: () => now,
        reconcile,
        refresh,
        refreshAt: () => refreshAt,
      });

      await expect(runtime.ready).rejects.toBe(failure);
      expect(fixture.listenerCount()).toBe(2);
      expect(allocations).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledTimes(1);

      const lateResource = resource.cloneNode(true);
      document.body.append(lateResource);
      await settle();
      expect(reconcile).toHaveBeenCalledTimes(
        failurePoint === "reconciliation" ? 2 : 1,
      );

      refreshAt = 2_000;
      fixture.publish();
      expect(timers.latest()?.[1].delay).toBe(1_000);
      const timer = timers.latest()?.[0];
      expect(timer).toBeDefined();
      now = 2_000;
      if (timer !== undefined) timers.fire(timer);
      await settle();
      expect(refresh).toHaveBeenCalledTimes(1);

      if (failurePoint === "cleanup") {
        await expect(runtime.destroyAndWait()).rejects.toBe(failure);
      } else {
        await expect(runtime.destroyAndWait()).resolves.toBeUndefined();
      }
      expect(fixture.listenerCount()).toBe(0);
      Reflect.set(browserWindow, "MutationObserver", NativeMutationObserver);
      browserWindow.close();
    },
  );

  it("chunks absolute deadlines beyond the browser timer limit", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client } = fakeClient();
    const refresh = vi.fn(() => Promise.resolve());
    let now = 0;
    let refreshAt: number | undefined = MAX_BROWSER_TIMER_DELAY_MS + 1_000;
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => now,
      refresh: async () => {
        await refresh();
        refreshAt = undefined;
      },
      refreshAt: () => refreshAt,
    });

    await runtime.ready;
    expect(timers.latest()?.[1].delay).toBe(MAX_BROWSER_TIMER_DELAY_MS);

    now = MAX_BROWSER_TIMER_DELAY_MS;
    const firstTimer = timers.latest()?.[0];
    expect(firstTimer).toBeDefined();
    if (firstTimer !== undefined) timers.fire(firstTimer);
    expect(timers.latest()?.[1].delay).toBe(1_000);
    expect(refresh).not.toHaveBeenCalled();

    now += 1_000;
    const secondTimer = timers.latest()?.[0];
    expect(secondTimer).toBeDefined();
    if (secondTimer !== undefined) timers.fire(secondTimer);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);

    runtime.destroy();
    browserWindow.close();
  });

  it("observes pageshow and only visible visibility changes", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    installTimerHarness(browserWindow);
    const { client, publish } = fakeClient();
    const refresh = vi.fn(() => Promise.resolve());
    let now = 1_000;
    let refreshAt: number | undefined = 2_000;
    let visibilityState: DocumentVisibilityState = "hidden";
    const document = browserWindow.document as unknown as Document;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState,
    );
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => now,
      refresh: async () => {
        await refresh();
        refreshAt = undefined;
      },
      refreshAt: () => refreshAt,
    });
    await runtime.ready;

    now = 2_000;
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    refreshAt = 2_000;
    publish();
    browserWindow.document.dispatchEvent(
      new browserWindow.Event("visibilitychange"),
    );
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    browserWindow.document.dispatchEvent(
      new browserWindow.Event("visibilitychange"),
    );
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);

    runtime.destroy();
    browserWindow.close();
  });

  it("reschedules from client snapshots and tears down every owner", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const refresh = vi.fn(() => Promise.resolve());
    let refreshAt: number | undefined = 2_000;
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 1_000,
      refresh,
      refreshAt: () => refreshAt,
    });
    await runtime.ready;

    expect(listenerCount()).toBe(2);
    const firstTimer = timers.latest()?.[0];
    refreshAt = 4_000;
    publish();
    expect(timers.latest()?.[1].delay).toBe(3_000);
    expect(timers.clearCalls).toHaveBeenCalledWith(firstTimer);

    const staleCallback = timers.latest()?.[1].callback;
    runtime.destroy();
    expect(listenerCount()).toBe(0);
    expect(timers.pending()).toBe(0);

    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    browserWindow.document.dispatchEvent(
      new browserWindow.Event("visibilitychange"),
    );
    staleCallback?.();
    await settle();
    expect(refresh).not.toHaveBeenCalled();

    browserWindow.close();
  });

  it("coalesces concurrent observations and reports refresh failures", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client } = fakeClient();
    const firstRefresh = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValue();
    const onError = vi.fn();
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => 2_000,
    });
    await runtime.ready;

    const dueTimer = timers.latest()?.[0];
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer);
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    browserWindow.document.dispatchEvent(
      new browserWindow.Event("visibilitychange"),
    );
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    const failure = new Error("simulated refresh failure");
    firstRefresh.reject(failure);
    await settle();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(timers.pending()).toBe(0);

    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(3);

    runtime.destroy();
    browserWindow.close();
  });

  it("does not schedule while the product has no observable deadline", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, publish } = fakeClient();
    const refresh = vi.fn(() => Promise.resolve());
    const state: { refreshAt: number | undefined } = {
      refreshAt: undefined,
    };
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 1_000,
      refresh,
      refreshAt: () => state.refreshAt,
    });
    await runtime.ready;
    expect(timers.pending()).toBe(0);

    state.refreshAt = 2_000;
    publish();
    expect(timers.latest()?.[1].delay).toBe(1_000);
    expect(refresh).not.toHaveBeenCalled();

    runtime.destroy();
    browserWindow.close();
  });

  it.each(["resolve", "reject"] as const)(
    "retains the latest future observation while a refresh %s",
    async (settlement) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const timers = installTimerHarness(browserWindow);
      const { client, publish } = fakeClient();
      const pendingRefresh = deferred();
      const refresh = vi.fn(() => pendingRefresh.promise);
      const onError = vi.fn();
      let refreshAt = 2_000;
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => 2_000,
        onError,
        refresh,
        refreshAt: () => refreshAt,
      });
      await runtime.ready;

      const dueTimer = timers.latest()?.[0];
      expect(dueTimer).toBeDefined();
      if (dueTimer !== undefined) timers.fire(dueTimer);
      await settle();
      expect(refresh).toHaveBeenCalledTimes(1);

      refreshAt = 4_000;
      publish();
      refreshAt = 7_000;
      publish();
      refreshAt = 5_000;
      publish();
      refreshAt = 2_000;

      const failure = new Error("simulated deferred refresh failure");
      if (settlement === "resolve") pendingRefresh.resolve();
      else pendingRefresh.reject(failure);
      await settle();

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(timers.pending()).toBe(1);
      expect(timers.latest()?.[1].delay).toBe(3_000);
      if (settlement === "reject") {
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(failure);
      } else {
        expect(onError).not.toHaveBeenCalled();
      }

      runtime.destroy();
      browserWindow.close();
    },
  );

  it("coalesces explicit observations retained during a refresh", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, publish } = fakeClient();
    const firstRefresh = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValueOnce();
    const document = browserWindow.document as unknown as Document;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      refresh,
      refreshAt: () => 2_000,
    });
    await runtime.ready;

    const dueTimer = timers.latest()?.[0];
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer);
    await settle();

    publish();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    browserWindow.document.dispatchEvent(
      new browserWindow.Event("visibilitychange"),
    );
    browserWindow.document.dispatchEvent(
      new browserWindow.Event("visibilitychange"),
    );
    firstRefresh.resolve();
    await settle();
    await settle();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(timers.pending()).toBe(0);

    runtime.destroy();
    browserWindow.close();
  });

  it.each([
    { deadline: 2_000, label: "exact", settlement: "resolve" },
    { deadline: 2_000, label: "exact", settlement: "reject" },
    { deadline: 1_999, label: "past", settlement: "resolve" },
    { deadline: 1_999, label: "past", settlement: "reject" },
  ])(
    "parks an unchanged $label deadline after $settlement until an explicit or newer observation",
    async ({ deadline, settlement }) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const timers = installTimerHarness(browserWindow);
      const { client, publish } = fakeClient();
      const failure = new Error("simulated stable deadline failure");
      const refresh = vi.fn(() =>
        settlement === "resolve" ? Promise.resolve() : Promise.reject(failure),
      );
      const onError = vi.fn();
      const document = browserWindow.document as unknown as Document;
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      let refreshAt = deadline;
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => 2_000,
        onError,
        refresh,
        refreshAt: () => refreshAt,
      });
      await runtime.ready;

      const initialTimer = timers.latest()?.[0];
      expect(initialTimer).toBeDefined();
      if (initialTimer !== undefined) timers.fire(initialTimer);
      await settle();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(timers.pending()).toBe(0);

      publish();
      await settle();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(timers.pending()).toBe(0);

      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      await settle();
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(timers.pending()).toBe(0);

      browserWindow.document.dispatchEvent(
        new browserWindow.Event("visibilitychange"),
      );
      await settle();
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(timers.pending()).toBe(0);

      refreshAt = deadline - 1;
      publish();
      const newerTimer = timers.latest()?.[0];
      expect(newerTimer).toBeDefined();
      expect(timers.latest()?.[1].delay).toBe(0);
      if (newerTimer !== undefined) timers.fire(newerTimer);
      await settle();
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(timers.pending()).toBe(0);
      expect(onError).toHaveBeenCalledTimes(settlement === "reject" ? 4 : 0);
      if (settlement === "reject") {
        expect(onError).toHaveBeenLastCalledWith(failure);
      }

      runtime.destroy();
      browserWindow.close();
    },
  );

  it.each([
    { invalidDeadline: -1, invalidNow: 1_000, label: "deadline" },
    { invalidDeadline: 2_000, invalidNow: Number.NaN, label: "clock" },
  ])("recovers after an invalid $label observation", async (invalid) => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, publish } = fakeClient();
    const onError = vi.fn();
    const refresh = vi.fn(() => Promise.resolve());
    let now = invalid.invalidNow;
    let refreshAt = invalid.invalidDeadline;
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => now,
      onError,
      refresh,
      refreshAt: () => refreshAt,
    });
    await runtime.ready;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);

    now = 1_000;
    refreshAt = 2_000;
    publish();
    expect(timers.pending()).toBe(1);
    expect(timers.latest()?.[1].delay).toBe(1_000);
    expect(refresh).not.toHaveBeenCalled();

    runtime.destroy();
    browserWindow.close();
  });

  it("preserves a newer future observation published from invalid-time reporting", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const refresh = vi.fn(() => Promise.resolve());
    let refreshAt = -1;
    const onError = vi.fn(() => {
      refreshAt = 3_000;
      publish();
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => refreshAt,
    });
    await runtime.ready;

    expect(onError).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);
    expect(timers.latest()?.[1].delay).toBe(1_000);

    runtime.destroy();
    expect(listenerCount()).toBe(0);
    expect(timers.pending()).toBe(0);
    browserWindow.close();
  });

  it.each([
    {
      label: "invalid deadline",
      malformedNow: () => 1_000,
      malformedRefreshAt: () => -1,
    },
    {
      label: "throwing deadline",
      malformedNow: () => 1_000,
      malformedRefreshAt: () => {
        throw new Error("simulated deadline read failure");
      },
    },
    {
      label: "invalid clock",
      malformedNow: () => Number.NaN,
      malformedRefreshAt: () => 4_000,
    },
    {
      label: "throwing clock",
      malformedNow: () => {
        throw new Error("simulated clock read failure");
      },
      malformedRefreshAt: () => 4_000,
    },
  ])(
    "preserves an armed deadline through a $label observation",
    async ({ malformedNow, malformedRefreshAt }) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const timers = installTimerHarness(browserWindow);
      const { client, listenerCount, publish } = fakeClient();
      const reporterFailure = new Error("simulated error reporter failure");
      const refresh = vi.fn(() => Promise.resolve());
      let malformed = false;
      let now = 1_000;
      const onError = vi.fn(() => {
        throw reporterFailure;
      });
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => (malformed ? malformedNow() : now),
        onError,
        refresh,
        refreshAt: () => (malformed ? malformedRefreshAt() : 4_000),
      });
      await runtime.ready;

      const armedTimer = timers.latest();
      expect(armedTimer).toBeDefined();
      expect(armedTimer?.[1].delay).toBe(3_000);

      malformed = true;
      publish();
      const timerAfterMalformedObservation = timers.latest();
      malformed = false;
      now = 4_000;
      if (
        armedTimer !== undefined &&
        timerAfterMalformedObservation?.[0] === armedTimer[0]
      ) {
        timers.fire(armedTimer[0]);
      }
      await settle();
      publish();
      publish();
      await settle();
      const observedRefreshCalls = refresh.mock.calls.length;
      const observedErrorCalls = onError.mock.calls.length;
      const observedPendingTimers = timers.pending();

      runtime.destroy();
      publish();
      armedTimer?.[1].callback();
      await settle();

      expect(timerAfterMalformedObservation?.[0]).toBe(armedTimer?.[0]);
      expect(timerAfterMalformedObservation?.[1].delay).toBe(3_000);
      expect(timers.clearCalls).not.toHaveBeenCalledWith(armedTimer?.[0]);
      expect(observedErrorCalls).toBe(1);
      expect(observedRefreshCalls).toBe(1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(observedPendingTimers).toBe(0);
      expect(listenerCount()).toBe(0);
      browserWindow.close();
    },
  );

  it("treats a valid no-deadline observation as cancellation", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const refresh = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    let refreshAt: number | undefined = 4_000;
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 1_000,
      onError,
      refresh,
      refreshAt: () => refreshAt,
    });
    await runtime.ready;

    const armedTimer = timers.latest();
    expect(armedTimer).toBeDefined();
    refreshAt = undefined;
    publish();

    expect(onError).not.toHaveBeenCalled();
    expect(timers.clearCalls).toHaveBeenCalledWith(armedTimer?.[0]);
    expect(timers.pending()).toBe(0);
    expect(refresh).not.toHaveBeenCalled();

    runtime.destroy();
    publish();
    armedTimer?.[1].callback();
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(0);
    browserWindow.close();
  });

  it("retains a future schedule and sticky retry through malformed in-flight observations", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const firstRefresh = deferred();
    const secondRefresh = deferred();
    const tracked = trackedRefresh(firstRefresh.promise, secondRefresh.promise);
    const reporterFailure = new Error("simulated error reporter failure");
    const onError = vi.fn(() => {
      throw reporterFailure;
    });
    let malformed = false;
    let now = 2_000;
    let refreshAt = 2_000;
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => now,
      onError,
      refresh: tracked.refresh,
      refreshAt: () => {
        if (malformed) throw new Error("simulated deadline read failure");
        return refreshAt;
      },
    });
    await runtime.ready;

    const initialTimer = timers.latest();
    expect(initialTimer).toBeDefined();
    if (initialTimer !== undefined) timers.fire(initialTimer[0]);
    await settle();

    refreshAt = 5_000;
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    malformed = true;
    publish();
    malformed = false;
    firstRefresh.resolve();
    await settle();
    await settle();

    const retainedTimer = timers.latest();
    const retainedDelay = retainedTimer?.[1].delay;
    if (retainedTimer !== undefined) {
      now = 5_000;
      timers.fire(retainedTimer[0]);
      await settle();
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      malformed = true;
      publish();
      malformed = false;
      secondRefresh.resolve();
      await settle();
      await settle();
    } else {
      secondRefresh.resolve();
    }

    publish();
    publish();
    await settle();
    const observedRefreshCalls = tracked.refresh.mock.calls.length;
    const observedMaximumActive = tracked.maximumActive();
    const observedErrors = onError.mock.calls.length;
    const observedPendingTimers = timers.pending();

    runtime.destroy();
    publish();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    retainedTimer?.[1].callback();
    await settle();

    expect(retainedDelay).toBe(3_000);
    expect(observedErrors).toBe(2);
    expect(observedRefreshCalls).toBe(3);
    expect(tracked.refresh).toHaveBeenCalledTimes(3);
    expect(observedMaximumActive).toBe(1);
    expect(observedPendingTimers).toBe(0);
    expect(listenerCount()).toBe(0);
    browserWindow.close();
  });

  it("runs one fail-closed refresh when the settlement clock is malformed", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const firstRefresh = deferred();
    const failClosedRefresh = deferred();
    const tracked = trackedRefresh(
      firstRefresh.promise,
      failClosedRefresh.promise,
    );
    const reporterFailure = new Error("simulated error reporter failure");
    const onError = vi.fn(() => {
      throw reporterFailure;
    });
    let invalidClock = false;
    let now = 2_000;
    let refreshAt = 2_000;
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => {
        if (invalidClock) throw new Error("simulated clock read failure");
        return now;
      },
      onError,
      refresh: tracked.refresh,
      refreshAt: () => refreshAt,
    });
    await runtime.ready;

    const initialTimer = timers.latest();
    expect(initialTimer).toBeDefined();
    if (initialTimer !== undefined) timers.fire(initialTimer[0]);
    await settle();

    refreshAt = 5_000;
    publish();
    invalidClock = true;
    firstRefresh.resolve();
    await settle();
    await settle();
    const callsAfterInvalidClock = tracked.refresh.mock.calls.length;

    invalidClock = false;
    now = 5_000;
    failClosedRefresh.resolve();
    await settle();
    await settle();
    publish();
    publish();
    await settle();
    const observedRefreshCalls = tracked.refresh.mock.calls.length;
    const observedMaximumActive = tracked.maximumActive();
    const observedErrors = onError.mock.calls.length;
    const observedPendingTimers = timers.pending();

    runtime.destroy();
    publish();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    initialTimer?.[1].callback();
    await settle();

    expect(callsAfterInvalidClock).toBe(2);
    expect(observedErrors).toBe(1);
    expect(observedRefreshCalls).toBe(2);
    expect(tracked.refresh).toHaveBeenCalledTimes(2);
    expect(observedMaximumActive).toBe(1);
    expect(observedPendingTimers).toBe(0);
    expect(listenerCount()).toBe(0);
    browserWindow.close();
  });

  it.each([
    {
      label: "deadline",
      malformedNow: () => 2_000,
      malformedRefreshAt: () => {
        throw new Error("simulated deadline read failure");
      },
    },
    {
      label: "clock",
      malformedNow: () => {
        throw new Error("simulated clock read failure");
      },
      malformedRefreshAt: () => 2_000,
    },
  ])(
    "fails closed when the $label becomes malformed as an armed timer fires",
    async ({ malformedNow, malformedRefreshAt }) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const timers = installTimerHarness(browserWindow);
      const { client, listenerCount, publish } = fakeClient();
      const failClosedRefresh = deferred();
      const tracked = trackedRefresh(failClosedRefresh.promise);
      const reporterFailure = new Error("simulated error reporter failure");
      const onError = vi.fn(() => {
        throw reporterFailure;
      });
      let malformed = false;
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => (malformed ? malformedNow() : 1_000),
        onError,
        refresh: tracked.refresh,
        refreshAt: () => (malformed ? malformedRefreshAt() : 2_000),
      });
      await runtime.ready;

      const armedTimer = timers.latest();
      expect(armedTimer?.[1].delay).toBe(1_000);
      malformed = true;
      if (armedTimer !== undefined) timers.fire(armedTimer[0]);
      await settle();
      await settle();
      const observedRefreshCalls = tracked.refresh.mock.calls.length;
      const observedMaximumActive = tracked.maximumActive();
      const observedErrors = onError.mock.calls.length;
      const observedPendingTimers = timers.pending();

      malformed = false;
      failClosedRefresh.resolve();
      await settle();
      runtime.destroy();
      publish();
      armedTimer?.[1].callback();
      await settle();

      expect(observedErrors).toBe(1);
      expect(observedRefreshCalls).toBe(1);
      expect(observedMaximumActive).toBe(1);
      expect(observedPendingTimers).toBe(0);
      expect(listenerCount()).toBe(0);
      browserWindow.close();
    },
  );

  it("retains a malformed explicit observation during an in-flight refresh", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const firstRefresh = deferred();
    const retryRefresh = deferred();
    const tracked = trackedRefresh(firstRefresh.promise, retryRefresh.promise);
    const reporterFailure = new Error("simulated error reporter failure");
    const onError = vi.fn(() => {
      throw reporterFailure;
    });
    let malformed = false;
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh: tracked.refresh,
      refreshAt: () => {
        if (malformed) throw new Error("simulated deadline read failure");
        return 2_000;
      },
    });
    await runtime.ready;

    const dueTimer = timers.latest();
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer[0]);
    await settle();

    malformed = true;
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    malformed = false;
    firstRefresh.resolve();
    await settle();
    await settle();
    const observedRefreshCalls = tracked.refresh.mock.calls.length;
    const observedMaximumActive = tracked.maximumActive();
    const observedErrors = onError.mock.calls.length;
    const observedPendingTimers = timers.pending();

    retryRefresh.resolve();
    await settle();
    runtime.destroy();
    publish();
    await settle();

    expect(observedErrors).toBe(1);
    expect(observedRefreshCalls).toBe(2);
    expect(observedMaximumActive).toBe(1);
    expect(observedPendingTimers).toBe(0);
    expect(listenerCount()).toBe(0);
    browserWindow.close();
  });

  it.each(["resolve", "reject"] as const)(
    "re-arms a fail-closed future deadline after the retry %s path recovers its clock",
    async (settlement) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const timers = installTimerHarness(browserWindow);
      const { client, listenerCount, publish } = fakeClient();
      const firstRefresh = deferred();
      const failClosedRefresh = deferred();
      const tracked = trackedRefresh(
        firstRefresh.promise,
        failClosedRefresh.promise,
        Promise.resolve(),
      );
      const reporterFailure = new Error("simulated error reporter failure");
      const retryFailure = new Error("simulated fail-closed refresh failure");
      const onError = vi.fn(() => {
        throw reporterFailure;
      });
      let invalidClock = false;
      let now = 2_000;
      let refreshAt = 2_000;
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => {
          if (invalidClock) throw new Error("simulated clock read failure");
          return now;
        },
        onError,
        refresh: tracked.refresh,
        refreshAt: () => refreshAt,
      });
      await runtime.ready;

      const initialTimer = timers.latest();
      expect(initialTimer).toBeDefined();
      if (initialTimer !== undefined) timers.fire(initialTimer[0]);
      await settle();

      refreshAt = 5_000;
      publish();
      invalidClock = true;
      firstRefresh.resolve();
      await settle();
      await settle();
      expect(tracked.refresh).toHaveBeenCalledTimes(2);

      invalidClock = false;
      now = 2_000;
      if (settlement === "resolve") {
        failClosedRefresh.resolve();
      } else {
        failClosedRefresh.reject(retryFailure);
      }
      await settle();
      await settle();
      const recoveredTimer = timers.latest();
      expect(recoveredTimer?.[1].delay).toBe(3_000);

      now = 5_000;
      if (recoveredTimer !== undefined) timers.fire(recoveredTimer[0]);
      await settle();
      await settle();
      const observedRefreshCalls = tracked.refresh.mock.calls.length;
      const observedMaximumActive = tracked.maximumActive();
      const observedErrors = onError.mock.calls.length;
      const observedPendingTimers = timers.pending();

      runtime.destroy();
      publish();
      recoveredTimer?.[1].callback();
      await settle();

      expect(observedErrors).toBe(settlement === "resolve" ? 1 : 2);
      expect(observedRefreshCalls).toBe(3);
      expect(observedMaximumActive).toBe(1);
      expect(observedPendingTimers).toBe(0);
      expect(listenerCount()).toBe(0);
      browserWindow.close();
    },
  );

  it("keeps a valid reentrant schedule published by malformed reporting", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const refresh = vi.fn(() => Promise.resolve());
    const reporterFailure = new Error("simulated error reporter failure");
    let malformed = false;
    let now = 1_000;
    let refreshAt = 4_000;
    const onError = vi.fn(() => {
      malformed = false;
      now = 2_000;
      refreshAt = 3_000;
      publish();
      throw reporterFailure;
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => now,
      onError,
      refresh,
      refreshAt: () => {
        if (malformed) throw new Error("simulated deadline read failure");
        return refreshAt;
      },
    });
    await runtime.ready;

    const firstTimer = timers.latest();
    expect(firstTimer).toBeDefined();
    malformed = true;
    publish();
    const reentrantTimer = timers.latest();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(reentrantTimer?.[0]).not.toBe(firstTimer?.[0]);
    expect(reentrantTimer?.[1].delay).toBe(1_000);
    expect(timers.clearCalls).toHaveBeenCalledWith(firstTimer?.[0]);

    now = 3_000;
    if (reentrantTimer !== undefined) timers.fire(reentrantTimer[0]);
    await settle();
    publish();
    await settle();
    const observedRefreshCalls = refresh.mock.calls.length;

    runtime.destroy();
    publish();
    firstTimer?.[1].callback();
    reentrantTimer?.[1].callback();
    await settle();

    expect(observedRefreshCalls).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
    expect(listenerCount()).toBe(0);
    browserWindow.close();
  });

  it("yields a failed explicit capture to a newer reentrant refresh", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const replacementRefresh = deferred();
    const tracked = trackedRefresh(replacementRefresh.promise);
    const reporterFailure = new Error("simulated error reporter failure");
    let malformed = false;
    let now = 1_000;
    let refreshAt: number | undefined;
    const onError = vi.fn(() => {
      malformed = false;
      now = 2_000;
      refreshAt = 2_000;
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      throw reporterFailure;
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => now,
      onError,
      refresh: tracked.refresh,
      refreshAt: () => {
        if (malformed) throw new Error("simulated deadline read failure");
        return refreshAt;
      },
    });
    await runtime.ready;
    expect(timers.pending()).toBe(0);

    malformed = true;
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    await settle();
    expect(tracked.refresh).toHaveBeenCalledTimes(1);

    replacementRefresh.resolve();
    await settle();
    await settle();
    const observedRefreshCalls = tracked.refresh.mock.calls.length;
    const observedMaximumActive = tracked.maximumActive();
    const observedErrors = onError.mock.calls.length;
    const observedPendingTimers = timers.pending();

    runtime.destroy();
    publish();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    await settle();

    expect(observedErrors).toBe(1);
    expect(observedRefreshCalls).toBe(1);
    expect(observedMaximumActive).toBe(1);
    expect(observedPendingTimers).toBe(0);
    expect(listenerCount()).toBe(0);
    browserWindow.close();
  });

  it("yields rejected settlement to a newer refresh started by error reporting", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const firstRefresh = deferred();
    const replacementRefresh = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => replacementRefresh.promise)
      .mockResolvedValue();
    const failure = new Error("simulated rejected refresh");
    let refreshAt = 2_000;
    const onError = vi.fn((error: unknown) => {
      if (error !== failure) return;
      refreshAt = 1_999;
      publish();
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => refreshAt,
    });
    await runtime.ready;

    const dueTimer = timers.latest()?.[0];
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    firstRefresh.reject(failure);
    await settle();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(timers.pending()).toBe(0);

    runtime.destroy();
    replacementRefresh.resolve();
    publish();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    await settle();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
    expect(timers.pending()).toBe(0);
    browserWindow.close();
  });

  it("stops rejected settlement when error reporting destroys the runtime", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const pendingRefresh = deferred();
    const refresh = vi.fn(() => pendingRefresh.promise);
    const failure = new Error("simulated terminal refresh failure");
    const owner: { runtime?: ReturnType<typeof startExpiryRuntime> } = {};
    const onError = vi.fn(() => {
      owner.runtime?.destroy();
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => 2_000,
    });
    owner.runtime = runtime;
    await runtime.ready;

    const dueTimer = timers.latest()?.[0];
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer);
    await settle();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));

    pendingRefresh.reject(failure);
    await settle();
    publish();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
    expect(timers.pending()).toBe(0);
    browserWindow.close();
  });

  it.each(["timer", "pageshow", "visibilitychange"] as const)(
    "does not invoke a deferred refresh after synchronous %s teardown",
    async (trigger) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const document = browserWindow.document as unknown as Document;
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      const addWindowListener = vi.spyOn(browserWindow, "addEventListener");
      const removeWindowListener = vi.spyOn(
        browserWindow,
        "removeEventListener",
      );
      const addDocumentListener = vi.spyOn(document, "addEventListener");
      const removeDocumentListener = vi.spyOn(document, "removeEventListener");
      const timers = installTimerHarness(browserWindow);
      const { client, listenerCount, publish } = fakeClient();
      const refresh = vi.fn(() => Promise.resolve());
      const onError = vi.fn();
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => 2_000,
        onError,
        refresh,
        refreshAt: () => 2_000,
      });
      await runtime.ready;

      const addedPageShow = addWindowListener.mock.calls.find(
        ([eventName]) => eventName === "pageshow",
      )?.[1];
      const addedVisibility = addDocumentListener.mock.calls.find(
        ([eventName]) => eventName === "visibilitychange",
      )?.[1];
      expect(addedPageShow).toBeDefined();
      expect(addedVisibility).toBeDefined();

      if (trigger === "timer") {
        const dueTimer = timers.latest()?.[0];
        expect(dueTimer).toBeDefined();
        if (dueTimer !== undefined) timers.fire(dueTimer);
      } else if (trigger === "pageshow") {
        browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      } else {
        browserWindow.document.dispatchEvent(
          new browserWindow.Event("visibilitychange"),
        );
      }
      runtime.destroy();
      await settle();

      expect(refresh).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(listenerCount()).toBe(0);
      expect(timers.pending()).toBe(0);
      expect(removeWindowListener).toHaveBeenCalledWith(
        "pageshow",
        addedPageShow,
      );
      expect(removeDocumentListener).toHaveBeenCalledWith(
        "visibilitychange",
        addedVisibility,
      );

      publish();
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      browserWindow.document.dispatchEvent(
        new browserWindow.Event("visibilitychange"),
      );
      await settle();
      expect(refresh).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();

      browserWindow.close();
    },
  );

  it("keeps a retained explicit retry through a passive failure publication", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, publish } = fakeClient();
    const firstRefresh = deferred();
    const retryRefresh = deferred();
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockImplementationOnce(() => retryRefresh.promise)
      .mockResolvedValue();
    const failure = new Error("simulated refresh failure");
    const onError = vi.fn((error: unknown) => {
      if (error === failure) publish();
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => 2_000,
    });
    await runtime.ready;

    const dueTimer = timers.latest()?.[0];
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);

    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    firstRefresh.reject(failure);
    await settle();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(timers.pending()).toBe(0);

    retryRefresh.resolve();
    await settle();
    publish();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(timers.pending()).toBe(0);

    runtime.destroy();
    browserWindow.close();
  });

  it("isolates throwing error reporting while retaining one explicit retry", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const firstRefresh = deferred();
    const retryRefresh = deferred();
    const refreshFailure = new Error("simulated refresh failure");
    const reporterFailure = new Error("simulated error reporter failure");
    let refreshCalls = 0;
    let activeRefreshes = 0;
    let maximumActiveRefreshes = 0;
    const refresh = vi.fn(async () => {
      const invocation = ++refreshCalls;
      activeRefreshes += 1;
      maximumActiveRefreshes = Math.max(
        maximumActiveRefreshes,
        activeRefreshes,
      );
      try {
        if (invocation === 1) await firstRefresh.promise;
        if (invocation === 2) await retryRefresh.promise;
      } finally {
        activeRefreshes -= 1;
      }
    });
    const onError = vi.fn((error: unknown) => {
      if (error === refreshFailure) publish();
      throw reporterFailure;
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => 2_000,
    });
    await runtime.ready;

    const dueTimer = timers.latest()?.[0];
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer);
    await settle();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));

    firstRefresh.reject(refreshFailure);
    await settle();
    await settle();
    retryRefresh.resolve();
    await settle();
    await settle();

    publish();
    publish();
    await settle();
    const observedRefreshCalls = refresh.mock.calls.length;
    const observedMaximumActiveRefreshes = maximumActiveRefreshes;
    const observedErrors = [...onError.mock.calls];
    const observedPendingTimers = timers.pending();

    runtime.destroy();
    expect(listenerCount()).toBe(0);
    browserWindow.close();

    expect(observedErrors).toEqual([[refreshFailure]]);
    expect(observedRefreshCalls).toBe(2);
    expect(observedMaximumActiveRefreshes).toBe(1);
    expect(observedPendingTimers).toBe(0);
  });

  it("allows a later lifecycle retry after throwing error reporting", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const firstRefresh = deferred();
    const refreshFailure = new Error("simulated refresh failure");
    const reporterFailure = new Error("simulated error reporter failure");
    let refreshCalls = 0;
    let activeRefreshes = 0;
    let maximumActiveRefreshes = 0;
    const refresh = vi.fn(async () => {
      const invocation = ++refreshCalls;
      activeRefreshes += 1;
      maximumActiveRefreshes = Math.max(
        maximumActiveRefreshes,
        activeRefreshes,
      );
      try {
        if (invocation === 1) await firstRefresh.promise;
      } finally {
        activeRefreshes -= 1;
      }
    });
    const onError = vi.fn(() => {
      throw reporterFailure;
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => 2_000,
    });
    await runtime.ready;

    const dueTimer = timers.latest()?.[0];
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer);
    await settle();

    firstRefresh.reject(refreshFailure);
    await settle();
    await settle();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    await settle();
    await settle();

    publish();
    publish();
    await settle();
    const observedRefreshCalls = refresh.mock.calls.length;
    const observedMaximumActiveRefreshes = maximumActiveRefreshes;
    const observedErrors = [...onError.mock.calls];
    const observedPendingTimers = timers.pending();

    runtime.destroy();
    expect(listenerCount()).toBe(0);
    browserWindow.close();

    expect(observedErrors).toEqual([[refreshFailure]]);
    expect(observedRefreshCalls).toBe(2);
    expect(observedMaximumActiveRefreshes).toBe(1);
    expect(observedPendingTimers).toBe(0);
  });

  it("keeps teardown final when error reporting destroys and throws", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test/" });
    const timers = installTimerHarness(browserWindow);
    const { client, listenerCount, publish } = fakeClient();
    const pendingRefresh = deferred();
    const refreshFailure = new Error("simulated refresh failure");
    const reporterFailure = new Error("simulated error reporter failure");
    const refresh = vi.fn(() => pendingRefresh.promise);
    const owner: { runtime?: ReturnType<typeof startExpiryRuntime> } = {};
    const onError = vi.fn(() => {
      owner.runtime?.destroy();
      throw reporterFailure;
    });
    const runtime = startExpiryRuntime(browserWindow, {
      client,
      now: () => 2_000,
      onError,
      refresh,
      refreshAt: () => 2_000,
    });
    owner.runtime = runtime;
    await runtime.ready;

    const dueTimer = timers.latest();
    expect(dueTimer).toBeDefined();
    if (dueTimer !== undefined) timers.fire(dueTimer[0]);
    await settle();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));

    pendingRefresh.reject(refreshFailure);
    await settle();
    await settle();
    publish();
    browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
    dueTimer?.[1].callback();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(refreshFailure);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listenerCount()).toBe(0);
    expect(timers.pending()).toBe(0);
    browserWindow.close();
  });

  it.each([
    { invalidDeadline: -1, invalidNow: 1_000, label: "deadline" },
    { invalidDeadline: 2_000, invalidNow: Number.NaN, label: "clock" },
  ])(
    "does not allocate a resource observer after invalid $label reporting destroys the runtime",
    async (invalid) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const document = browserWindow.document as unknown as Document;
      const resource = document.createElement("script");
      resource.type = "text/plain";
      resource.dataset["ocCategory"] = "analytics";
      resource.dataset["ocResource"] = "analytics-script";
      document.head.append(resource);

      const NativeMutationObserver = browserWindow.MutationObserver;
      const allocations = vi.fn();
      class InstrumentedMutationObserver extends NativeMutationObserver {
        constructor(
          callback: ConstructorParameters<typeof NativeMutationObserver>[0],
        ) {
          super(callback);
          allocations();
        }
      }
      Reflect.set(
        browserWindow,
        "MutationObserver",
        InstrumentedMutationObserver,
      );
      const observe = vi.spyOn(
        InstrumentedMutationObserver.prototype,
        "observe",
      );
      const disconnect = vi.spyOn(
        InstrumentedMutationObserver.prototype,
        "disconnect",
      );
      const addWindowListener = vi.spyOn(browserWindow, "addEventListener");
      const removeWindowListener = vi.spyOn(
        browserWindow,
        "removeEventListener",
      );
      const addDocumentListener = vi.spyOn(document, "addEventListener");
      const removeDocumentListener = vi.spyOn(document, "removeEventListener");
      const timers = installTimerHarness(browserWindow);
      const { client, listenerCount, publish } = fakeClient();
      const refresh = vi.fn(() => Promise.resolve());
      const owner: { runtime?: ReturnType<typeof startExpiryRuntime> } = {};
      const onError = vi.fn(() => {
        owner.runtime?.destroy();
      });
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => invalid.invalidNow,
        onError,
        refresh,
        refreshAt: () => invalid.invalidDeadline,
      });
      owner.runtime = runtime;
      await runtime.ready;

      const addedPageShow = addWindowListener.mock.calls.find(
        ([eventName]) => eventName === "pageshow",
      )?.[1];
      const addedVisibility = addDocumentListener.mock.calls.find(
        ([eventName]) => eventName === "visibilitychange",
      )?.[1];
      expect(addedPageShow).toBeDefined();
      expect(addedVisibility).toBeDefined();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      expect(allocations).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
      expect(listenerCount()).toBe(0);
      expect(timers.pending()).toBe(0);
      expect(removeWindowListener).toHaveBeenCalledWith(
        "pageshow",
        addedPageShow,
      );
      expect(removeDocumentListener).toHaveBeenCalledWith(
        "visibilitychange",
        addedVisibility,
      );

      publish();
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      browserWindow.document.dispatchEvent(
        new browserWindow.Event("visibilitychange"),
      );
      await settle();
      expect(allocations).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);

      Reflect.set(browserWindow, "MutationObserver", NativeMutationObserver);
      browserWindow.close();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "fully tears down while a pending refresh later %s",
    async (settlement) => {
      const browserWindow = new Window({
        url: "https://shop.example.test/",
      });
      const document = browserWindow.document as unknown as Document;
      const addWindowListener = vi.spyOn(browserWindow, "addEventListener");
      const removeWindowListener = vi.spyOn(
        browserWindow,
        "removeEventListener",
      );
      const addDocumentListener = vi.spyOn(document, "addEventListener");
      const removeDocumentListener = vi.spyOn(document, "removeEventListener");
      const timers = installTimerHarness(browserWindow);
      const { client, listenerCount, publish } = fakeClient();
      const pendingRefresh = deferred();
      const refresh = vi.fn(() => pendingRefresh.promise);
      const onError = vi.fn();
      let refreshAt = 2_000;
      const runtime = startExpiryRuntime(browserWindow, {
        client,
        now: () => 2_000,
        onError,
        refresh,
        refreshAt: () => refreshAt,
      });
      await runtime.ready;

      const addedPageShow = addWindowListener.mock.calls.find(
        ([eventName]) => eventName === "pageshow",
      )?.[1];
      const addedVisibility = addDocumentListener.mock.calls.find(
        ([eventName]) => eventName === "visibilitychange",
      )?.[1];
      expect(addedPageShow).toBeDefined();
      expect(addedVisibility).toBeDefined();

      const dueTimer = timers.latest();
      expect(dueTimer).toBeDefined();
      if (dueTimer !== undefined) timers.fire(dueTimer[0]);
      await settle();
      expect(refresh).toHaveBeenCalledTimes(1);

      refreshAt = 5_000;
      publish();
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      runtime.destroy();

      expect(listenerCount()).toBe(0);
      expect(timers.pending()).toBe(0);
      expect(removeWindowListener).toHaveBeenCalledWith(
        "pageshow",
        addedPageShow,
      );
      expect(removeDocumentListener).toHaveBeenCalledWith(
        "visibilitychange",
        addedVisibility,
      );

      publish();
      browserWindow.dispatchEvent(new browserWindow.Event("pageshow"));
      browserWindow.document.dispatchEvent(
        new browserWindow.Event("visibilitychange"),
      );
      dueTimer?.[1].callback();
      if (settlement === "resolve") pendingRefresh.resolve();
      else pendingRefresh.reject(new Error("failure after destroy"));
      await settle();

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(listenerCount()).toBe(0);
      expect(timers.pending()).toBe(0);

      browserWindow.close();
    },
  );
});
