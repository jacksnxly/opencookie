import type { OpenCookie, OpenCookieSnapshot } from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import {
  createBlockedIframeController,
  createBlockedScriptController,
  mountOpenCookie,
  type VanillaOpenCookieMountOptions,
} from "./index.js";
import { createTestClient } from "./index.test-helpers.js";
import { mountOpenCookieHost } from "./mount.js";

function snapshot(
  preferencesOpen: boolean,
  prompt: boolean,
  record?: {
    readonly decisions: readonly {
      readonly purposeId: string;
      readonly value: "denied" | "granted";
    }[];
    readonly method: "accept-all" | "withdrawal";
  },
  runtime?: {
    readonly accessConsent?: {
      readonly decisions: readonly {
        readonly decision: "denied" | "granted" | "unresolved";
        readonly purposeId: string;
      }[];
      readonly status:
        | "active"
        | "expired"
        | "first-visit"
        | "requires-reconsent"
        | "withdrawn";
    };
    readonly policyReconciliation?: {
      readonly prompt: boolean;
      readonly status: "current" | "requires-reconsent";
    };
  },
): OpenCookieSnapshot {
  const recordedDecisions = new Map(
    record?.decisions.map((decision) => [decision.purposeId, decision.value]),
  );
  return {
    diagnostics: [],
    policySnapshot: {
      policy: {
        categories: [],
        presentationRootCategoryIds: [],
        purposes: [
          {
            dependsOn: [],
            disclosure: "Policy-bound analytics disclosure.",
            id: "analytics",
            label: "Policy-bound analytics",
          },
          {
            dependsOn: [],
            disclosure: "Policy-bound personalization disclosure.",
            id: "personalization",
            label: "Policy-bound personalization",
          },
        ],
      },
    },
    preferencesOpen,
    readiness: "ready",
    ...(record === undefined ? {} : { record }),
    runtime: {
      accessConsent: runtime?.accessConsent ?? {
        decisions: ["analytics", "personalization"].map((purposeId) => ({
          decision: recordedDecisions.get(purposeId) ?? "unresolved",
          purposeId,
        })),
        status: prompt ? "first-visit" : "active",
      },
      accessPolicy: {
        purposes: ["analytics", "personalization"].map((id) => ({
          dependsOn: [],
          id,
        })),
        resources: [],
        valid: true,
      },
      consentEvaluation: {
        issues: [],
        prompt,
        status: prompt ? "first-visit" : "active",
      },
      effectiveAccess: { resources: [] },
      permittedPurposeIds: [],
      ...(runtime?.policyReconciliation === undefined
        ? {}
        : { policyReconciliation: runtime.policyReconciliation }),
    },
  } as unknown as OpenCookieSnapshot;
}

function groupedSnapshot(): OpenCookieSnapshot {
  const base = snapshot(true, true);
  const purposes = [
    {
      dependsOn: [],
      disclosure: "Measure aggregate site usage.",
      id: "analytics",
      label: "Analytics",
    },
    {
      dependsOn: [],
      disclosure: "Adapt the experience.",
      id: "personalization",
      label: "Personalization",
    },
    {
      dependsOn: [],
      disclosure: "Shared category purpose.",
      id: "shared",
      label: "Shared purpose",
    },
    {
      dependsOn: [],
      disclosure: "Outside the visited presentation graph.",
      id: "ungrouped",
      label: "Ungrouped purpose",
    },
  ];
  return {
    ...base,
    policySnapshot: {
      ...base.policySnapshot,
      policy: {
        ...base.policySnapshot.policy,
        categories: [
          {
            categoryIds: ["left", "right"],
            id: "root",
            purposeIds: [],
          },
          {
            categoryIds: [],
            id: "left",
            purposeIds: ["analytics", "shared"],
          },
          {
            categoryIds: [],
            id: "right",
            purposeIds: ["personalization", "shared"],
          },
        ],
        presentationRootCategoryIds: ["root"],
        purposes,
      },
    },
    runtime: {
      ...base.runtime,
      accessConsent: {
        decisions: purposes.map(({ id }) => ({
          decision: "unresolved" as const,
          purposeId: id,
        })),
        status: "first-visit",
      },
      accessPolicy: {
        purposes: purposes.map(({ dependsOn, id }) => ({ dependsOn, id })),
        resources: [],
        valid: true,
      },
    },
  } as unknown as OpenCookieSnapshot;
}

function categorySelectionSnapshot(): OpenCookieSnapshot {
  const base = groupedSnapshot();
  const purposes = [
    {
      dependsOn: [],
      disclosure: "Required by advertising.",
      id: "analytics",
      label: "Analytics",
    },
    {
      dependsOn: ["analytics"],
      disclosure: "Personalize advertising.",
      id: "ads",
      label: "Advertising",
    },
    {
      dependsOn: [],
      disclosure: "Adapt the experience.",
      id: "personalization",
      label: "Personalization",
    },
    {
      dependsOn: [],
      disclosure: "Shared root purpose.",
      id: "shared",
      label: "Shared purpose",
    },
    {
      dependsOn: [],
      disclosure: "Purpose whose id overlaps the root category.",
      id: "root",
      label: "Root purpose",
    },
    {
      dependsOn: [],
      disclosure: "Outside the category graph.",
      id: "ungrouped",
      label: "Ungrouped purpose",
    },
  ];
  return {
    ...base,
    policySnapshot: {
      ...base.policySnapshot,
      policy: {
        ...base.policySnapshot.policy,
        categories: [
          {
            categoryIds: ["marketing"],
            id: "root",
            purposeIds: ["shared"],
          },
          {
            categoryIds: [],
            id: "marketing",
            purposeIds: ["ads", "personalization"],
          },
        ],
        presentationRootCategoryIds: ["root"],
        purposes,
      },
    },
    runtime: {
      ...base.runtime,
      accessConsent: {
        decisions: purposes.map(({ id }) => ({
          decision:
            id === "shared" ? ("granted" as const) : ("unresolved" as const),
          purposeId: id,
        })),
        status: "first-visit",
      },
      accessPolicy: {
        purposes: purposes.map(({ dependsOn, id }) => ({ dependsOn, id })),
        resources: [],
        valid: true,
      },
    },
  } as unknown as OpenCookieSnapshot;
}

function dependencySnapshot(
  decisions: readonly {
    readonly decision: "denied" | "granted" | "unresolved";
    readonly purposeId: string;
  }[],
  prompt: boolean,
): OpenCookieSnapshot {
  const base = snapshot(true, prompt);
  return {
    ...base,
    policySnapshot: {
      ...base.policySnapshot,
      policy: {
        ...base.policySnapshot.policy,
        purposes: [
          {
            dependsOn: [],
            disclosure: "Measure aggregate site usage.",
            id: "analytics",
            label: "Analytics",
          },
          {
            dependsOn: ["analytics"],
            disclosure: "Personalize advertising.",
            id: "ads",
            label: "Advertising",
          },
        ],
      },
    },
    runtime: {
      ...base.runtime,
      accessConsent: {
        decisions,
        status: prompt ? "first-visit" : "active",
      },
    },
  } as unknown as OpenCookieSnapshot;
}

function pendingGrantSnapshot(
  grantedPurposeIds: readonly string[],
  transitionId: string,
  phase: "broadcast" | "persistence" = "persistence",
): OpenCookieSnapshot {
  const base = snapshot(true, true, undefined, {
    accessConsent: {
      decisions: ["analytics", "personalization"].map((purposeId) => ({
        decision: "unresolved" as const,
        purposeId,
      })),
      status: "first-visit",
    },
  });
  return {
    ...base,
    grantActivation: "pending",
    lastPersistenceStatus:
      phase === "persistence" ? "failed-conservative" : "pending",
    pendingGrant: {
      grantedPurposeIds,
      phase,
      transitionId,
    },
  };
}

function failedGrantSnapshot(
  preferencesOpen: boolean,
  transitionId = "transition-failed",
): OpenCookieSnapshot {
  const base = snapshot(preferencesOpen, false);
  return {
    ...base,
    grantActivation: "pending",
    lastPersistenceStatus: "failed-conservative",
    pendingGrant: {
      grantedPurposeIds: ["analytics"],
      phase: "persistence",
      transitionId,
    },
  };
}

function fakeClient(initial?: OpenCookieSnapshot): {
  readonly calls: string[];
  readonly client: OpenCookie;
  readonly publishSnapshot: (snapshot: OpenCookieSnapshot) => void;
} {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let current = initial ?? snapshot(true, true);
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const decide = (method: string) => {
    calls.push(method);
    current = snapshot(
      false,
      false,
      method === "accept-all"
        ? {
            decisions: [{ purposeId: "analytics", value: "granted" }],
            method,
          }
        : undefined,
    );
    publish();
    return Promise.resolve({ outcome: "committed" as const } as never);
  };

  return {
    calls,
    client: {
      acceptAll: () => decide("accept-all"),
      closePreferences: () => {
        calls.push("close-preferences");
        current = { ...current, preferencesOpen: false };
        publish();
      },
      getServerSnapshot: () => current,
      getSnapshot: () => current,
      initialize: () => Promise.resolve(current),
      openPreferences: () => {
        calls.push("open-preferences");
        current = { ...current, preferencesOpen: true };
        publish();
      },
      refresh: () => Promise.resolve(current),
      rejectAll: () => decide("reject-all"),
      retryPendingGrant: () =>
        Promise.resolve({ outcome: "unchanged" as const } as never),
      savePreferences: (purposeIds) =>
        decide(`granular:${purposeIds.join(",")}`),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      withdrawConsent: () => decide("withdraw-consent"),
    },
    publishSnapshot(next) {
      current = next;
      publish();
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function settingsPanel(document: Document): HTMLDialogElement {
  const dialog = document.querySelector<HTMLDialogElement>("dialog.oc-panel");
  if (dialog === null)
    throw new Error("The persistent settings panel is missing.");
  return dialog;
}

function cancelDialog(browserWindow: Window, dialog: HTMLDialogElement): void {
  dialog.dispatchEvent(
    new browserWindow.Event("cancel", {
      cancelable: true,
    }) as unknown as Event,
  );
}

function deferredRestorationClient(): {
  readonly client: OpenCookie;
  readonly restore: () => void;
} {
  const listeners = new Set<() => void>();
  let current = snapshot(true, true);
  let resolveInitialization: ((value: OpenCookieSnapshot) => void) | undefined;
  const initialization = new Promise<OpenCookieSnapshot>((resolve) => {
    resolveInitialization = resolve;
  });
  const unchanged = () =>
    Promise.resolve({ outcome: "unchanged" as const } as never);

  return {
    client: {
      acceptAll: unchanged,
      closePreferences: () => undefined,
      getServerSnapshot: () => current,
      getSnapshot: () => current,
      initialize: () => initialization,
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
    restore: () => {
      current = snapshot(false, false, {
        decisions: [{ purposeId: "analytics", value: "denied" }],
        method: "accept-all",
      });
      for (const listener of listeners) listener();
      resolveInitialization?.(current);
    },
  };
}

describe("mountOpenCookie", () => {
  it("renders domain-projected category legends with one owner per purpose", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient(groupedSnapshot());
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const groups = Array.from(
      document.querySelectorAll<HTMLFieldSetElement>("fieldset.oc-purposes"),
    );
    expect(
      groups.map((group) => ({
        legend: group.querySelector("legend")?.textContent,
        purposeIds: Array.from(
          group.querySelectorAll<HTMLInputElement>(
            'input[name="opencookie-purpose"]',
          ),
          ({ value }) => value,
        ),
      })),
    ).toEqual([
      {
        legend: "left",
        purposeIds: ["analytics", "shared"],
      },
      {
        legend: "right",
        purposeIds: ["personalization"],
      },
      {
        legend: "Privacy preferences",
        purposeIds: ["ungrouped"],
      },
    ]);
    expect(
      document.querySelectorAll<HTMLInputElement>('input[value="shared"]'),
    ).toHaveLength(1);

    const left = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="left"]',
    );
    const right = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="right"]',
    );
    right?.click();
    expect(right?.checked).toBe(true);
    expect(right?.indeterminate).toBe(false);
    expect(left?.checked).toBe(false);
    expect(left?.indeterminate).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="opencookie-purpose"][value="shared"]',
      )?.checked,
    ).toBe(true);

    mount.destroy();
    browserWindow.close();
  });

  it("renders an empty-root policy as one flat section", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient(snapshot(true, true));
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const groups = document.querySelectorAll<HTMLFieldSetElement>(
      "fieldset.oc-purposes",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelector("legend")?.textContent).toBe(
      "Privacy preferences",
    );
    expect(
      Array.from(
        groups[0]?.querySelectorAll("input") ?? [],
        ({ value }) => value,
      ),
    ).toEqual(["analytics", "personalization"]);
    expect(
      document.querySelector('input[name="opencookie-category"]'),
    ).toBeNull();

    mount.destroy();
    browserWindow.close();
  });

  it("operates category choices through domain expansion and dependency closure", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient(categorySelectionSnapshot());
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const root = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="root"]',
    );
    const purpose = (id: string) =>
      document.querySelector<HTMLInputElement>(
        `input[name="opencookie-purpose"][value="${id}"]`,
      );

    expect(root?.closest("label")?.textContent).toContain("root");
    expect(root?.checked).toBe(false);
    expect(root?.indeterminate).toBe(true);

    root?.click();
    expect(root?.checked).toBe(true);
    expect(root?.indeterminate).toBe(false);
    for (const purposeId of ["ads", "analytics", "personalization", "shared"]) {
      expect(purpose(purposeId)?.checked).toBe(true);
    }
    expect(purpose("ungrouped")?.checked).toBe(false);

    purpose("personalization")?.click();
    expect(root?.checked).toBe(false);
    expect(root?.indeterminate).toBe(true);

    root?.click();
    root?.click();
    expect(root?.checked).toBe(false);
    expect(root?.indeterminate).toBe(false);
    expect(purpose("ads")?.checked).toBe(false);
    expect(purpose("personalization")?.checked).toBe(false);
    expect(purpose("shared")?.checked).toBe(false);
    expect(purpose("analytics")?.checked).toBe(true);

    root?.click();
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settle();
    expect(calls).toContain("granular:ads,analytics,personalization,shared");

    mount.destroy();
    browserWindow.close();
  });

  it("restores category focus by input kind and value after a rerender", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const initial = categorySelectionSnapshot();
    const { client, publishSnapshot } = fakeClient(initial);
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const category = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="root"]',
    );
    category?.focus();
    expect(document.activeElement).toBe(category);

    publishSnapshot({ ...initial });

    const renderedCategory = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="root"]',
    );
    expect(document.activeElement).toBe(renderedCategory);
    expect(document.activeElement).not.toBe(
      document.querySelector('input[name="opencookie-purpose"][value="root"]'),
    );

    mount.destroy();
    browserWindow.close();
  });

  it("resolves one category interaction with one linear domain pass", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient(snapshot(true, true));
    const resolveDependencies = vi.fn(
      (_policy: unknown, purposeId: string) => [purposeId] as const,
    );
    const resolveSelection = vi.fn<
      (
        policy: unknown,
        purposeIds: readonly string[],
        mode: "complete" | "supported",
      ) => readonly string[]
    >((_policy, purposeIds) => Object.freeze([...purposeIds]));
    const expandCategories = vi.fn(
      (_policy: unknown, categoryIds: readonly string[]) =>
        categoryIds.includes("root")
          ? Object.freeze(["analytics", "personalization"])
          : Object.freeze([]),
    );
    const projectPresentation = vi.fn(
      (_policy: unknown, selectedPurposeIds: ReadonlySet<string>) => {
        const selectedCount = ["analytics", "personalization"].filter(
          (purposeId) => selectedPurposeIds.has(purposeId),
        ).length;
        return Object.freeze([
          Object.freeze({
            categoryId: "root",
            checked: selectedCount === 2,
            indeterminate: selectedCount === 1,
            purposeIds: Object.freeze(["analytics", "personalization"]),
          }),
        ]);
      },
    );

    const mount = mountOpenCookieHost(
      { client, document },
      resolveDependencies,
      resolveSelection,
      expandCategories,
      projectPresentation,
    );
    await mount.ready;
    const dialog = settingsPanel(document);
    expect(dialog.childElementCount).toBe(0);
    expect(projectPresentation).not.toHaveBeenCalled();
    expect(expandCategories).not.toHaveBeenCalled();

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    expect(dialog.open).toBe(true);
    expect(projectPresentation).toHaveBeenCalledTimes(1);
    resolveDependencies.mockClear();
    resolveSelection.mockClear();
    expandCategories.mockClear();
    projectPresentation.mockClear();

    const category = document.querySelector<HTMLInputElement>(
      'input[name="opencookie-category"][value="root"]',
    );
    category?.click();
    expect(expandCategories).toHaveBeenCalledTimes(1);
    expect(expandCategories.mock.calls[0]?.[1]).toEqual(["root"]);
    expect(resolveSelection).toHaveBeenCalledTimes(1);
    expect(resolveSelection.mock.calls[0]?.[1]).toEqual([
      "analytics",
      "personalization",
    ]);
    expect(resolveSelection.mock.calls[0]?.[2]).toBe("complete");
    expect(projectPresentation).toHaveBeenCalledTimes(1);
    expect(resolveDependencies).not.toHaveBeenCalled();

    resolveSelection.mockClear();
    expandCategories.mockClear();
    projectPresentation.mockClear();
    category?.click();
    expect(expandCategories).toHaveBeenCalledTimes(1);
    expect(resolveSelection).toHaveBeenCalledTimes(1);
    expect(resolveSelection.mock.calls[0]?.[2]).toBe("supported");
    expect(projectPresentation).toHaveBeenCalledTimes(1);
    expect(resolveDependencies).not.toHaveBeenCalled();

    mount.destroy();
    browserWindow.close();
  });

  it("does not rebuild the bar after initialize already publishes", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const initial = snapshot(true, true);
    const { client: baseClient, publishSnapshot } = fakeClient(initial);
    let barAfterPublication: Element | null = null;
    const client: OpenCookie = {
      ...baseClient,
      initialize: () => {
        publishSnapshot(initial);
        barAfterPublication = document.querySelector(".oc-bar");
        return Promise.resolve(initial);
      },
    };

    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    expect(barAfterPublication).not.toBeNull();
    expect(document.querySelector(".oc-bar")).toBe(barAfterPublication);

    mount.destroy();
    browserWindow.close();
  });

  it("renders only digest-bound purpose copy and ignores untrusted selection defaults", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient();
    const mount = mountOpenCookie({
      client,
      document,
      purposes: [
        {
          description: "Untrusted disclosure",
          id: "analytics",
          label: "Untrusted label",
          selected: true,
        },
      ],
    } as unknown as VanillaOpenCookieMountOptions);
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const purpose = document.querySelector<HTMLElement>(".oc-purpose");
    expect(purpose?.textContent).toContain("Policy-bound analytics");
    expect(purpose?.textContent).toContain(
      "Policy-bound analytics disclosure.",
    );
    expect(purpose?.textContent).not.toContain("Untrusted");
    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(false);

    mount.destroy();
    browserWindow.close();
  });

  it("does not render a transient first-visit prompt before restoration", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client, restore } = deferredRestorationClient();
    const mount = mountOpenCookie({ client, document });

    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).toBeNull();

    restore();
    await mount.ready;

    expect(settingsPanel(document)).toBe(dialog);
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    mount.destroy();
    browserWindow.close();
  });

  it("splits the first-visit bar from a separately named settings panel", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    const bar = document.querySelector<HTMLElement>(".oc-bar");
    // The three decisions stay equal; closing the bar is not one of them.
    const actions = Array.from(
      bar?.querySelectorAll<HTMLButtonElement>(".oc-bar-actions button") ?? [],
    );
    const dismiss = bar?.querySelector<HTMLButtonElement>(
      '[data-oc-action="dismiss"]',
    );
    const dialog = settingsPanel(document);
    expect(bar).not.toBeNull();
    expect(dismiss?.textContent).toBe("Close");
    expect(dismiss?.type).toBe("button");
    expect(dismiss?.classList.contains("oc-btn--choice")).toBe(false);
    expect(bar?.getAttribute("role")).not.toBe("dialog");
    expect(bar?.getAttribute("aria-modal")).toBeNull();
    expect(actions.map((action) => action.textContent)).toEqual([
      "Reject all",
      "Accept all",
      "Settings",
    ]);
    expect(actions.every((action) => action.type === "button")).toBe(true);
    expect(actions[0]?.className).toBe("oc-btn oc-btn--choice");
    expect(actions[1]?.className).toBe(actions[0]?.className);
    expect(actions[2]?.className).toBe("oc-btn oc-btn--choice oc-btn--quiet");
    expect(dialog.open).toBe(false);
    expect(bar?.contains(dialog)).toBe(false);
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.childElementCount).toBe(0);
    expect(dialog.querySelector("input, button")).toBeNull();

    const settings = actions[2];
    settings?.click();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("input, button")).not.toBeNull();
    expect(dialog.querySelector(".oc-title")?.id).toBe(
      dialog.getAttribute("aria-labelledby"),
    );

    dialog
      .querySelector<HTMLButtonElement>('[data-oc-action="close"]')
      ?.click();
    actions[0]?.click();
    await settle();
    expect(calls).toEqual(["reject-all"]);
    expect(dialog.open).toBe(false);
    expect(dialog.isConnected).toBe(true);
    expect(document.querySelector('[data-oc-action="open"]')).not.toBeNull();
    mount.destroy();
    browserWindow.close();
  });

  it("preserves the focused panel control across open-state publications", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client, publishSnapshot } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const analytics = document.querySelector<HTMLInputElement>(
      'input[value="analytics"]',
    );
    analytics?.focus();
    expect(document.activeElement).toBe(analytics);

    publishSnapshot(
      snapshot(true, true, undefined, {
        accessConsent: {
          decisions: [
            { decision: "unresolved", purposeId: "analytics" },
            { decision: "unresolved", purposeId: "personalization" },
          ],
          status: "first-visit",
        },
      }),
    );

    expect(document.activeElement).toBe(
      document.querySelector('input[value="analytics"]'),
    );
    mount.destroy();
    browserWindow.close();
  });

  it("preserves title and action focus across open-state publications", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client, publishSnapshot } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const dialog = settingsPanel(document);
    const title = dialog.querySelector<HTMLElement>(".oc-title");
    title?.focus();
    publishSnapshot(snapshot(true, true));
    expect(document.activeElement).toBe(dialog.querySelector(".oc-title"));

    const save = dialog.querySelector<HTMLButtonElement>(
      '[data-oc-action="save"]',
    );
    save?.focus();
    publishSnapshot(snapshot(true, true));
    expect(document.activeElement).toBe(
      dialog.querySelector('[data-oc-action="save"]'),
    );

    mount.destroy();
    browserWindow.close();
  });

  it("restores checkbox focus without interpolating a hostile purpose id into a selector", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const hostilePurposeId = 'analytics"] [data-oc-action="save';
    const base = snapshot(true, true);
    const hostilePurpose = {
      dependsOn: [],
      disclosure: "Hostile identifier disclosure.",
      id: hostilePurposeId,
      label: "Hostile identifier purpose",
    };
    const hostileSnapshot = {
      ...base,
      policySnapshot: {
        ...base.policySnapshot,
        policy: {
          ...base.policySnapshot.policy,
          purposes: [hostilePurpose],
        },
      },
      runtime: {
        ...base.runtime,
        accessConsent: {
          decisions: [
            {
              decision: "unresolved" as const,
              purposeId: hostilePurposeId,
            },
          ],
          status: "first-visit" as const,
        },
        accessPolicy: {
          purposes: [{ dependsOn: [], id: hostilePurposeId }],
          resources: [],
          valid: true,
        },
      },
    } as unknown as OpenCookieSnapshot;
    const { client, publishSnapshot } = fakeClient(hostileSnapshot);
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const hostileCheckbox = Array.from(
      settingsPanel(document).querySelectorAll<HTMLInputElement>(
        'input[name="opencookie-purpose"]',
      ),
    ).find(({ value }) => value === hostilePurposeId);
    hostileCheckbox?.focus();
    publishSnapshot({
      ...hostileSnapshot,
      runtime: {
        ...hostileSnapshot.runtime,
        accessConsent: {
          ...hostileSnapshot.runtime.accessConsent,
          decisions: [...hostileSnapshot.runtime.accessConsent.decisions],
        },
      },
    });

    expect((document.activeElement as HTMLInputElement | null)?.value).toBe(
      hostilePurposeId,
    );
    mount.destroy();
    browserWindow.close();
  });

  it("keeps the exact panel opener connected across notice publications", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client, publishSnapshot } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    const settings = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="settings"]',
    );
    settings?.click();
    publishSnapshot(pendingGrantSnapshot([], "notice-publication"));

    expect(settings?.isConnected).toBe(true);
    expect(document.querySelector('[data-oc-action="settings"]')).toBe(
      settings,
    );
    document.querySelector<HTMLDialogElement>("dialog.oc-panel")?.dispatchEvent(
      new browserWindow.Event("cancel", {
        cancelable: true,
      }) as unknown as Event,
    );
    expect(document.activeElement).toBe(settings);
    mount.destroy();
    browserWindow.close();
  });

  it("normalizes failed persistence to the launcher and client preference transitions", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const fixture = fakeClient();
    let retry = 0;
    const client: OpenCookie = {
      ...fixture.client,
      acceptAll: () => {
        fixture.calls.push("accept-all");
        fixture.publishSnapshot(failedGrantSnapshot(true));
        return Promise.resolve({ outcome: "pending" as const } as never);
      },
      retryPendingGrant: () => {
        retry += 1;
        fixture.calls.push(`retry-pending-grant:${String(retry)}`);
        fixture.publishSnapshot(
          failedGrantSnapshot(true, `transition-failed-${String(retry)}`),
        );
        return Promise.resolve({ outcome: "pending" as const } as never);
      },
    };
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="accept-all"]')
      ?.click();
    await settle();

    const launcher = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="open"]',
    );
    expect(launcher).not.toBeNull();
    expect(document.querySelectorAll(".oc-bar")).toHaveLength(0);
    expect(document.querySelectorAll('[data-oc-action="open"]')).toHaveLength(
      1,
    );
    expect(
      document.querySelectorAll(
        '.oc-notice [data-oc-action="retry-pending-grant"]',
      ),
    ).toHaveLength(1);
    expect(fixture.client.getSnapshot().preferencesOpen).toBe(false);
    expect(fixture.calls).toEqual(["accept-all", "close-preferences"]);

    launcher?.click();
    expect(fixture.client.getSnapshot().preferencesOpen).toBe(true);
    expect(settingsPanel(document).open).toBe(true);
    expect(fixture.calls).toEqual([
      "accept-all",
      "close-preferences",
      "open-preferences",
    ]);

    for (const index of [1, 2, 3]) {
      document
        .querySelector<HTMLButtonElement>(
          '.oc-panel [data-oc-action="retry-pending-grant"]',
        )
        ?.click();
      await settle();
      expect(fixture.client.getSnapshot().preferencesOpen).toBe(true);
      expect(settingsPanel(document).open).toBe(true);
      expect(document.querySelector('[data-oc-action="open"]')).toBe(launcher);
      expect(fixture.calls.at(-1)).toBe(`retry-pending-grant:${String(index)}`);
    }

    document
      .querySelector<HTMLButtonElement>('.oc-panel [data-oc-action="close"]')
      ?.click();
    expect(fixture.client.getSnapshot().preferencesOpen).toBe(false);
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).toBe(launcher);
    expect(
      document.querySelector(
        '.oc-notice [data-oc-action="retry-pending-grant"]',
      ),
    ).not.toBeNull();
    expect(fixture.calls.at(-1)).toBe("close-preferences");

    document
      .querySelector<HTMLButtonElement>(
        '.oc-notice [data-oc-action="retry-pending-grant"]',
      )
      ?.click();
    await settle();
    expect(fixture.client.getSnapshot().preferencesOpen).toBe(false);
    expect(settingsPanel(document).open).toBe(false);
    expect(document.querySelectorAll(".oc-bar")).toHaveLength(0);
    expect(document.querySelector('[data-oc-action="open"]')).toBe(launcher);
    expect(fixture.calls.slice(-2)).toEqual([
      "retry-pending-grant:4",
      "close-preferences",
    ]);

    mount.destroy();
    browserWindow.close();
  });

  it("keeps the same focused launcher across closed-state publications", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client, publishSnapshot } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
      ?.click();
    await settle();
    const firstLauncher = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="open"]',
    );
    expect(document.activeElement).toBe(firstLauncher);

    publishSnapshot(snapshot(false, false));
    await settle();
    const retainedLauncher = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="open"]',
    );
    expect(retainedLauncher).toBe(firstLauncher);
    expect(document.activeElement).toBe(retainedLauncher);

    mount.destroy();
    browserWindow.close();
  });

  it("restores launcher focus after a closing decision settles", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const outside = document.createElement("button");
    document.body.append(outside);
    const { client: baseClient, publishSnapshot } = fakeClient();
    let resolveDecision: ((value: never) => void) | undefined;
    const decision = new Promise<never>((resolve) => {
      resolveDecision = resolve;
    });
    const client: OpenCookie = {
      ...baseClient,
      rejectAll: () => {
        publishSnapshot(snapshot(false, false));
        return decision;
      },
    };
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
      ?.click();
    outside.focus();
    expect(document.activeElement).toBe(outside);

    resolveDecision?.({ outcome: "committed" } as never);
    await settle();
    expect(document.activeElement).toBe(
      document.querySelector('[data-oc-action="open"]'),
    );

    mount.destroy();
    browserWindow.close();
  });

  it("does not refocus a deferred decision target after destroy", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const { client: baseClient, publishSnapshot } = fakeClient();
    let resolveDecision: ((value: never) => void) | undefined;
    const decision = new Promise<never>((resolve) => {
      resolveDecision = resolve;
    });
    const client: OpenCookie = {
      ...baseClient,
      rejectAll: () => {
        publishSnapshot(snapshot(false, false));
        return decision;
      },
    };
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
      ?.click();
    const detachedLauncher = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="open"]',
    );
    mount.destroy();
    expect(document.activeElement).toBe(outside);

    resolveDecision?.({ outcome: "committed" } as never);
    await settle();
    expect(detachedLauncher?.isConnected).toBe(false);
    expect(document.activeElement).toBe(outside);
    browserWindow.close();
  });

  it.each(["throw", "reject"] as const)(
    "restores the settled launcher after a decision %s",
    async (failureMode) => {
      const browserWindow = new Window({ url: "https://shop.example.test" });
      const document = browserWindow.document as unknown as Document;
      const { client: baseClient, publishSnapshot } = fakeClient();
      const error = new Error(`decision ${failureMode}`);
      const onError = vi.fn();
      const client: OpenCookie = {
        ...baseClient,
        rejectAll: () => {
          publishSnapshot(snapshot(false, false));
          if (failureMode === "throw") throw error;
          return Promise.reject(error);
        },
      };
      const mount = mountOpenCookie({ client, document, onError });
      await mount.ready;

      document
        .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
        ?.click();
      await settle();

      const launcher = document.querySelector<HTMLButtonElement>(
        '[data-oc-action="open"]',
      );
      expect(launcher).not.toBeNull();
      expect(document.activeElement).toBe(launcher);
      expect(onError).toHaveBeenCalledWith(error);

      mount.destroy();
      browserWindow.close();
    },
  );

  it.each(["retry-pending-grant", "withdraw"] as const)(
    "does not focus the outside launcher when %s leaves settings open",
    async (action) => {
      const browserWindow = new Window({ url: "https://shop.example.test" });
      const document = browserWindow.document as unknown as Document;
      const pending = snapshot(
        true,
        false,
        {
          decisions: [{ purposeId: "analytics", value: "granted" }],
          method: "accept-all",
        },
        {
          accessConsent: {
            decisions: [
              { decision: "granted", purposeId: "analytics" },
              { decision: "denied", purposeId: "personalization" },
            ],
            status: "active",
          },
        },
      );
      const current = {
        ...pending,
        grantActivation: "pending",
        lastPersistenceStatus: "failed-conservative",
        pendingGrant: {
          grantedPurposeIds: ["analytics"],
          phase: "persistence" as const,
          transitionId: "open-panel-retry",
        },
      } as OpenCookieSnapshot;
      const { client: baseClient } = fakeClient(current);
      const unchanged = () =>
        Promise.resolve({ outcome: "unchanged" as const } as never);
      const client: OpenCookie = {
        ...baseClient,
        retryPendingGrant: unchanged,
        withdrawConsent: unchanged,
      };
      const mount = mountOpenCookie({ client, document });
      await mount.ready;

      const dialog = settingsPanel(document);
      const launcher = document.querySelector<HTMLButtonElement>(
        '[data-oc-action="open"]',
      );
      const launcherFocus = vi.spyOn(launcher as HTMLButtonElement, "focus");
      const decision = dialog.querySelector<HTMLButtonElement>(
        `[data-oc-action="${action}"]`,
      );
      expect(dialog.open).toBe(true);
      expect(decision).not.toBeNull();
      decision?.focus();
      decision?.click();
      await settle();

      expect(dialog.open).toBe(true);
      expect(document.activeElement).toBe(decision);
      expect(launcherFocus).not.toHaveBeenCalled();

      mount.destroy();
      browserWindow.close();
    },
  );

  it("discloses declared resource exceptions without interactive controls", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const base = snapshot(true, true);
    const exceptionReason =
      'Keeps the signed-in session available. <img data-injected="true">';
    const { client } = fakeClient({
      ...base,
      runtime: {
        ...base.runtime,
        accessPolicy: {
          purposes: base.policySnapshot.policy.purposes.map((purpose) => ({
            dependsOn: purpose.dependsOn,
            id: purpose.id,
          })),
          resources: [
            {
              access: "declared-exception",
              exceptionReason,
              id: "session-cookie",
              purposeIds: [],
              serviceId: "session",
            },
          ],
          valid: true,
        },
      },
    });
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const exceptions = document.querySelector<HTMLElement>(
      "[data-oc-exceptions]",
    );
    expect(exceptions?.querySelector("h3")?.textContent).toBe(
      "Not controlled by these choices",
    );
    expect(exceptions?.textContent).toContain("session-cookie");
    expect(exceptions?.textContent).toContain(exceptionReason);
    expect(exceptions?.querySelector("input, button")).toBeNull();
    expect(document.querySelector('[data-injected="true"]')).toBeNull();

    mount.destroy();
    browserWindow.close();
  });

  it("does not steal host focus while the first-visit bar becomes ready", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const { client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    let readySettled = false;
    void mount.ready.then(() => {
      readySettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    const reject = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="reject-all"]',
    );
    expect(reject).not.toBeNull();
    expect(document.activeElement).toBe(outside);

    await mount.ready;
    expect(document.activeElement).toBe(outside);
    expect(readySettled).toBe(true);

    mount.destroy();
    browserWindow.close();
  });

  it("preserves host focus across first-visit publications before readiness", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const { client, publishSnapshot } = fakeClient();
    const mount = mountOpenCookie({ client, document });

    queueMicrotask(() => {
      publishSnapshot(snapshot(true, true));
    });

    await mount.ready;

    expect(
      document.querySelector('[data-oc-action="reject-all"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(outside);

    mount.destroy();
    browserWindow.close();
  });

  it("restores the pre-mount host focus when an open panel is destroyed", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    const { client } = fakeClient();
    const mount = mountOpenCookie({ client, document });

    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    expect(document.activeElement).toBe(
      settingsPanel(document).querySelector(".oc-title"),
    );

    mount.destroy();

    expect(document.activeElement).toBe(outside);
    browserWindow.close();
  });

  it("keeps one persistent native panel across bar and launcher states", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(false);
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    expect(dialog.open).toBe(true);
    cancelDialog(browserWindow, dialog);
    expect(dialog.open).toBe(false);
    expect(dialog.isConnected).toBe(true);
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
      ?.click();
    await settle();
    const launcher = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="open"]',
    );
    launcher?.click();
    expect(settingsPanel(document)).toBe(dialog);
    expect(dialog.open).toBe(true);
    mount.destroy();
    expect(dialog.isConnected).toBe(false);
    browserWindow.close();
  });

  it("places the non-modal bar after ordinary host controls", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const ordinaryControl = document.createElement("button");
    ordinaryControl.type = "button";
    document.body.append(ordinaryControl);
    const { client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    const root = document.querySelector<HTMLElement>("[data-oc-root]");
    const bodyChildren = Array.from(document.body.children);
    expect(bodyChildren.indexOf(root as HTMLElement)).toBeGreaterThan(
      bodyChildren.indexOf(ordinaryControl),
    );
    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(false);
    const settings = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="settings"]',
    );
    settings?.click();
    cancelDialog(browserWindow, dialog);

    expect(dialog.open).toBe(false);
    expect(dialog.isConnected).toBe(true);
    settings?.click();
    expect(settingsPanel(document)).toBe(dialog);
    expect(dialog.open).toBe(true);

    mount.destroy();
    browserWindow.close();
  });

  it("offers an explicit withdrawal action after an optional grant", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    await client.acceptAll();
    client.openPreferences();
    const dialog = settingsPanel(document);
    const withdraw = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="withdraw"]',
    );
    expect(withdraw?.textContent).toBe("Withdraw consent");
    withdraw?.click();
    await settle();

    expect(calls).toEqual([
      "accept-all",
      "open-preferences",
      "withdraw-consent",
    ]);
    expect(dialog.open).toBe(false);
    expect(dialog.isConnected).toBe(true);
    mount.destroy();
    browserWindow.close();
  });

  it("rehydrates granular controls from the committed consent record", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    await client.acceptAll();
    client.openPreferences();
    expect(settingsPanel(document).open).toBe(true);

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('input[value="personalization"]')
        ?.checked,
    ).toBe(false);
    mount.destroy();
    browserWindow.close();
  });

  it("rehydrates and resubmits the exact persistence-pending granular choice on mount", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient(
      pendingGrantSnapshot(["personalization"], "transition-granular"),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('input[value="personalization"]')
        ?.checked,
    ).toBe(true);

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settle();

    expect(calls).toEqual(["granular:personalization"]);
    mount.destroy();
    browserWindow.close();
  });

  it("rehydrates the exact broadcast-pending granular choice on mount", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient(
      pendingGrantSnapshot(
        ["personalization"],
        "transition-broadcast",
        "broadcast",
      ),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('input[value="personalization"]')
        ?.checked,
    ).toBe(true);

    mount.destroy();
    browserWindow.close();
  });

  it("synchronizes a persistence-pending choice only once per transition", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const firstPending = pendingGrantSnapshot(
      ["analytics"],
      "transition-granular-a",
    );
    const { client, publishSnapshot } = fakeClient(firstPending);
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    document
      .querySelector<HTMLInputElement>('input[value="personalization"]')
      ?.click();
    publishSnapshot({ ...firstPending });

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('input[value="personalization"]')
        ?.checked,
    ).toBe(true);

    publishSnapshot(
      pendingGrantSnapshot(["personalization"], "transition-granular-b"),
    );

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('input[value="personalization"]')
        ?.checked,
    ).toBe(true);

    mount.destroy();
    browserWindow.close();
  });

  it("resynchronizes a distinct pending choice when a transition id is reused", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const transitionId = "transition-reused";
    const { client, publishSnapshot } = fakeClient(
      pendingGrantSnapshot(["analytics"], transitionId),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    publishSnapshot(snapshot(true, true));
    publishSnapshot(pendingGrantSnapshot(["personalization"], transitionId));

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('input[value="personalization"]')
        ?.checked,
    ).toBe(true);

    mount.destroy();
    browserWindow.close();
  });

  it("removes retired purpose ids before resubmitting a pending choice", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient(
      pendingGrantSnapshot(["retired", "analytics"], "transition-retired"),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settle();

    expect(calls).toEqual(["granular:analytics"]);
    mount.destroy();
    browserWindow.close();
  });

  it("does not claim that retained grants are blocked after persistence fails", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const pending = pendingGrantSnapshot(
      ["analytics", "personalization"],
      "transition-retained",
    );
    const retainedGrant: OpenCookieSnapshot = {
      ...pending,
      runtime: {
        ...pending.runtime,
        accessConsent: {
          decisions: [
            { decision: "granted", purposeId: "analytics" },
            { decision: "denied", purposeId: "personalization" },
          ],
          status: "active",
        },
      },
    };
    const { client } = fakeClient(retainedGrant);
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "We could not save your choice. No additional optional services were enabled; previously saved choices remain in effect.",
    );

    mount.destroy();
    browserWindow.close();
  });

  it("selects prerequisites and exposes their relationship before saving", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient(
      dependencySnapshot(
        ["analytics", "ads"].map((purposeId) => ({
          decision: "unresolved" as const,
          purposeId,
        })),
        true,
      ),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const analytics = document.querySelector<HTMLInputElement>(
      'input[value="analytics"]',
    );
    const ads = document.querySelector<HTMLInputElement>('input[value="ads"]');
    ads?.click();

    expect(analytics?.checked).toBe(true);
    expect(ads?.checked).toBe(true);
    const descriptionId = ads?.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toMatch(
      /requires analytics/i,
    );

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settle();
    expect(calls).toContain("granular:ads,analytics");

    mount.destroy();
    browserWindow.close();
  });

  it("renders unsupported grants off and clears dependents with their prerequisite", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient(
      dependencySnapshot(
        [
          { decision: "denied", purposeId: "analytics" },
          { decision: "granted", purposeId: "ads" },
        ],
        false,
      ),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const analytics = document.querySelector<HTMLInputElement>(
      'input[value="analytics"]',
    );
    const ads = document.querySelector<HTMLInputElement>('input[value="ads"]');
    expect(analytics?.checked).toBe(false);
    expect(ads?.checked).toBe(false);

    ads?.click();
    expect(analytics?.checked).toBe(true);
    expect(ads?.checked).toBe(true);
    analytics?.click();
    expect(analytics?.checked).toBe(false);
    expect(ads?.checked).toBe(false);

    mount.destroy();
    browserWindow.close();
  });

  it("preserves a dirty granular draft across background access updates", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client, publishSnapshot } = fakeClient(snapshot(true, true));
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const analytics = document.querySelector<HTMLInputElement>(
      'input[value="analytics"]',
    );
    analytics?.click();
    expect(analytics?.checked).toBe(true);

    publishSnapshot(
      snapshot(true, true, undefined, {
        accessConsent: {
          decisions: ["analytics", "personalization"].map((purposeId) => ({
            decision: "unresolved" as const,
            purposeId,
          })),
          status: "expired",
        },
      }),
    );

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(true);
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settle();
    expect(calls).toContain("granular:analytics");

    mount.destroy();
    browserWindow.close();
  });

  it("tracks selective checkbox state and dismissal from verified reconciliation", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const historicalRecord = {
      decisions: [
        { purposeId: "analytics", value: "granted" as const },
        { purposeId: "personalization", value: "granted" as const },
      ],
      method: "accept-all" as const,
    };
    const initial = snapshot(true, false, historicalRecord, {
      accessConsent: {
        decisions: [
          { decision: "granted", purposeId: "analytics" },
          { decision: "granted", purposeId: "personalization" },
        ],
        status: "active",
      },
      policyReconciliation: { prompt: false, status: "current" },
    });
    const { calls, client, publishSnapshot } = fakeClient(initial);
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(true);

    publishSnapshot(
      snapshot(true, false, historicalRecord, {
        accessConsent: {
          decisions: [
            { decision: "unresolved", purposeId: "analytics" },
            { decision: "granted", purposeId: "personalization" },
          ],
          status: "requires-reconsent",
        },
        policyReconciliation: {
          prompt: true,
          status: "requires-reconsent",
        },
      }),
    );

    expect(
      document.querySelector<HTMLInputElement>('input[value="analytics"]')
        ?.checked,
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('input[value="personalization"]')
        ?.checked,
    ).toBe(true);
    expect(document.querySelector('[data-oc-action="close"]')).not.toBeNull();
    cancelDialog(browserWindow, dialog);
    expect(calls).not.toContain("close-preferences");
    expect(dialog.open).toBe(false);
    expect(document.querySelector(".oc-bar")).not.toBeNull();

    mount.destroy();
    browserWindow.close();
  });

  it("closes the editor without dismissing a required choice and notifies after a decision", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const dialog = settingsPanel(document);
    const firstVisitClose = dialog.querySelector<HTMLButtonElement>(
      '[data-oc-action="close"]',
    );
    expect(firstVisitClose?.textContent).toBe("Close preferences");
    firstVisitClose?.click();
    expect(dialog.open).toBe(false);
    expect(document.querySelector(".oc-bar")).not.toBeNull();
    expect(calls).not.toContain("close-preferences");

    await client.acceptAll();
    const launcher = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="open"]',
    );
    launcher?.click();
    const close = dialog.querySelector<HTMLButtonElement>(
      '[data-oc-action="close"]',
    );
    expect(close?.textContent).toBe("Close preferences");
    close?.click();

    expect(calls).toEqual([
      "accept-all",
      "open-preferences",
      "close-preferences",
    ]);
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).toBe(launcher);
    expect(document.activeElement).toBe(launcher);
    mount.destroy();
    browserWindow.close();
  });

  it("restores stored selections and the summary view when preferences reopen", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient(
      snapshot(
        false,
        false,
        {
          decisions: [
            { purposeId: "analytics", value: "granted" },
            { purposeId: "personalization", value: "denied" },
          ],
          method: "accept-all",
        },
        {
          accessConsent: {
            decisions: [
              { decision: "granted", purposeId: "analytics" },
              { decision: "denied", purposeId: "personalization" },
            ],
            status: "active",
          },
        },
      ),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;
    const personalization = () =>
      document.querySelector<HTMLInputElement>(
        'input[value="personalization"]',
      );

    client.openPreferences();
    expect(settingsPanel(document).open).toBe(true);
    expect(personalization()?.checked).toBe(false);
    personalization()?.click();
    expect(personalization()?.checked).toBe(true);

    client.closePreferences();
    client.openPreferences();

    expect(settingsPanel(document).open).toBe(true);
    expect(personalization()?.checked).toBe(false);

    mount.destroy();
    browserWindow.close();
  });

  it("keeps the withdrawal control bound to the stored record", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient(
      snapshot(
        false,
        false,
        {
          decisions: [
            { purposeId: "analytics", value: "granted" },
            { purposeId: "personalization", value: "granted" },
          ],
          method: "accept-all",
        },
        {
          accessConsent: {
            decisions: [
              { decision: "granted", purposeId: "analytics" },
              { decision: "granted", purposeId: "personalization" },
            ],
            status: "active",
          },
        },
      ),
    );
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    client.openPreferences();
    expect(settingsPanel(document).open).toBe(true);
    for (const value of ["analytics", "personalization"]) {
      document
        .querySelector<HTMLInputElement>(`input[value="${value}"]`)
        ?.click();
    }

    client.closePreferences();
    client.openPreferences();

    expect(
      document.querySelector('[data-oc-action="withdraw"]'),
    ).not.toBeNull();

    mount.destroy();
    browserWindow.close();
  });

  it("renders a focus indicator that contrasts with the panel in both colour schemes", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const client = createTestClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    const stylesheet = Array.from(document.head.querySelectorAll("style"))
      .map((element) => element.textContent)
      .join("\n");

    const channel = (hex: string, start: number): number => {
      const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string): number => {
      const value = hex.replace("#", "");
      return (
        0.2126 * channel(value, 0) +
        0.7152 * channel(value, 2) +
        0.0722 * channel(value, 4)
      );
    };
    const contrast = (a: string, b: string): number => {
      const [high, low] = [luminance(a), luminance(b)].sort(
        (x, y) => y - x,
      ) as [number, number];
      return (high + 0.05) / (low + 0.05);
    };
    const token = (scope: string, name: string): string => {
      const declaration = new RegExp(`${name}:(#[0-9a-f]{6})`, "iu").exec(
        scope,
      );
      if (declaration === null) throw new Error(`missing token ${name}`);
      return declaration[1] as string;
    };

    const focusRule = /\.oc-btn:focus-visible[^{]*\{([^}]*)\}/u.exec(
      stylesheet,
    );
    if (focusRule === null) {
      throw new Error("the stylesheet must define a focus indicator");
    }
    const outline = /outline:[^;]*?(var\(--oc-[a-z-]+\)|#[0-9a-f]{6})/iu.exec(
      focusRule[1] as string,
    );
    if (outline === null) {
      throw new Error("the focus indicator must declare an outline colour");
    }
    const outlineToken = (outline[1] as string).replace(
      /^var\(--oc-([a-z-]+)\)$/u,
      "--oc-$1",
    );

    // The dark palette is each token's second light-dark() value, used when
    // the page declares dark support.
    const pairs =
      /@supports \(color:light-dark\([^)]*\)\)\{:where\(\.oc-root\)\{([^}]*)\}/u.exec(
        stylesheet,
      );
    if (pairs === null) {
      throw new Error("the stylesheet must define a dark palette");
    }
    const darkScope = [
      pairs[0],
      (pairs[1] as string).replace(
        /light-dark\((#[0-9a-f]{6}),(#[0-9a-f]{6})\)/giu,
        "$2",
      ),
    ];
    const lightScope = /(?::where\()?\.oc-root\)?\{(--oc-[^}]*)\}/u.exec(
      stylesheet,
    );
    if (lightScope === null) {
      throw new Error("the stylesheet must define a light palette");
    }

    for (const [label, scope] of [
      ["light", lightScope[1] as string],
      ["dark", darkScope[1] as string],
    ] as const) {
      const ring = outlineToken.startsWith("--oc-")
        ? token(scope, outlineToken)
        : outlineToken;
      const paper = token(scope, "--oc-paper");
      expect(
        contrast(ring, paper),
        `${label} focus ring ${ring} against panel ${paper}`,
      ).toBeGreaterThanOrEqual(3);
    }

    mount.destroy();
    browserWindow.close();
  });

  it("gives the launcher focus indicator its own adjacent surface", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    const stylesheet = Array.from(document.head.querySelectorAll("style"))
      .map((element) => element.textContent)
      .join("\n");

    const launcherFocus = /\.oc-launcher:focus-visible\{([^}]*)\}/u.exec(
      stylesheet,
    );
    if (launcherFocus === null) {
      throw new Error(
        "the launcher must declare its own focus indicator, because it is fixed over an arbitrary host page",
      );
    }
    expect(launcherFocus[1]).toContain("var(--oc-paper)");

    mount.destroy();
    browserWindow.close();
  });

  it("keeps first-visit cancel local and closes post-decision preferences", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    const settings = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="settings"]',
    );
    settings?.click();
    const dialog = settingsPanel(document);
    cancelDialog(browserWindow, dialog);
    expect(dialog.open).toBe(false);
    expect(dialog.isConnected).toBe(true);
    expect(document.activeElement).toBe(settings);
    expect(calls).not.toContain("close-preferences");
    expect(document.querySelector(".oc-bar")).not.toBeNull();

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="reject-all"]')
      ?.click();
    await settle();
    const launcher = document.querySelector<HTMLButtonElement>(
      '[data-oc-action="open"]',
    );
    launcher?.click();
    expect(dialog.open).toBe(true);
    cancelDialog(browserWindow, dialog);

    expect(calls).toEqual([
      "reject-all",
      "open-preferences",
      "close-preferences",
    ]);
    expect(dialog.open).toBe(false);
    expect(document.querySelector('[data-oc-action="open"]')).toBe(launcher);
    expect(document.activeElement).toBe(launcher);

    mount.destroy();
    browserWindow.close();
  });

  for (const closePath of ["button", "Escape"] as const) {
    it(`discards a first-visit draft after ${closePath} closes settings`, async () => {
      const browserWindow = new Window({ url: "https://shop.example.test" });
      const document = browserWindow.document as unknown as Document;
      const { calls, client } = fakeClient();
      const mount = mountOpenCookie({ client, document });
      await mount.ready;

      const settings = document.querySelector<HTMLButtonElement>(
        '[data-oc-action="settings"]',
      );
      settings?.click();
      const dialog = settingsPanel(document);
      const analytics = dialog.querySelector<HTMLInputElement>(
        'input[value="analytics"]',
      );
      expect(analytics?.checked).toBe(false);
      analytics?.click();
      expect(analytics?.checked).toBe(true);

      if (closePath === "button") {
        dialog
          .querySelector<HTMLButtonElement>('[data-oc-action="close"]')
          ?.click();
      } else {
        cancelDialog(browserWindow, dialog);
      }

      expect(dialog.open).toBe(false);
      expect(dialog.childElementCount).toBe(0);
      expect(calls).not.toContain("close-preferences");

      settings?.click();

      expect(settingsPanel(document)).toBe(dialog);
      expect(dialog.open).toBe(true);
      expect(
        dialog.querySelector<HTMLInputElement>('input[value="analytics"]')
          ?.checked,
      ).toBe(false);

      mount.destroy();
      browserWindow.close();
    });
  }

  it("removes the native cancel handler when the mount is destroyed", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    await client.acceptAll();
    client.openPreferences();
    const dialog = settingsPanel(document);
    expect(dialog.open).toBe(true);
    mount.destroy();
    const afterDestroy = calls.length;

    cancelDialog(browserWindow, dialog);

    expect(calls).toHaveLength(afterDestroy);
    browserWindow.close();
  });

  it("supports granular save, focus trapping, and post-decision cancel", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { calls, client } = fakeClient();
    const mount = mountOpenCookie({ client, document });
    await mount.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const firstCheckbox = document.querySelector<HTMLInputElement>(
      'input[value="analytics"]',
    );
    firstCheckbox?.click();
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="save"]')
      ?.click();
    await settle();
    expect(calls).toEqual(["granular:analytics"]);

    client.openPreferences();
    const dialog = settingsPanel(document);
    cancelDialog(browserWindow, dialog);
    expect(calls).toContain("close-preferences");

    client.openPreferences();
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>("button, input"),
    );
    const last = focusables.at(-1);
    last?.focus();
    last?.dispatchEvent(
      new browserWindow.KeyboardEvent("keydown", {
        bubbles: true,
        key: "Tab",
      }) as unknown as Event,
    );
    expect(document.activeElement).toBe(focusables[0]);
    mount.destroy();
    browserWindow.close();
  });

  it("applies a CSP nonce to its static style and removes everything on destroy", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const { client } = fakeClient();
    const mount = mountOpenCookie({
      client,
      document,
      nonce: "fixture-nonce",
    });
    await mount.ready;

    expect(
      document.querySelector("style[data-opencookie]")?.getAttribute("nonce"),
    ).toBe("fixture-nonce");
    mount.destroy();
    expect(document.querySelector("[data-oc-root]")).toBeNull();
    expect(document.querySelector("style[data-opencookie]")).toBeNull();
    browserWindow.close();
  });
});

describe("createBlockedScriptController", () => {
  it("keeps declared scripts inert, starts once with a nonce, and re-blocks", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const original = document.createElement("script");
    original.type = "text/plain";
    original.dataset["ocCategory"] = "analytics";
    original.dataset["ocResource"] = "analytics-script";
    original.dataset["src"] = "https://cdn.example.test/analytics.js";
    document.head.append(original);
    const controller = createBlockedScriptController({
      category: "analytics",
      document,
      nonce: "fixture-nonce",
      resourceId: "analytics-script",
    });

    await expect(controller.discover()).resolves.toBe("blocked");
    await expect(controller.start()).resolves.toEqual({
      irreversibleEffects: ["script-effects-may-persist"],
    });
    await controller.start();
    const active = document.querySelectorAll<HTMLScriptElement>(
      'script[data-oc-active-resource="analytics-script"]',
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.src).toBe("https://cdn.example.test/analytics.js");
    expect(active[0]?.nonce).toBe("fixture-nonce");
    expect(original.type).toBe("text/plain");

    await controller.stop();
    await expect(controller.block()).resolves.toEqual({
      irreversibleEffects: [],
    });
    await expect(controller.cleanup()).resolves.toEqual({
      irreversibleEffects: [],
    });
    expect(
      document.querySelector(
        'script[data-oc-active-resource="analytics-script"]',
      ),
    ).toBeNull();
    browserWindow.close();
  });

  it("reports a script that was not declared inert instead of claiming it was blocked", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const script = document.createElement("script");
    script.dataset["ocCategory"] = "analytics";
    script.dataset["ocResource"] = "analytics-script";
    document.head.append(script);
    const controller = createBlockedScriptController({
      category: "analytics",
      document,
      resourceId: "analytics-script",
    });

    await expect(controller.block()).resolves.toEqual({
      irreversibleEffects: ["previous-script-execution-unknown"],
    });
    expect(script.type).toBe("text/plain");
    browserWindow.close();
  });

  it("TEST-SPA-DYNAMIC-DISCOVERY starts each newly inserted allowed script once", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const first = document.createElement("script");
    first.type = "text/plain";
    first.dataset["ocResource"] = "analytics-script";
    first.dataset["src"] = "https://cdn.example.test/first.js";
    document.head.append(first);
    const controller = createBlockedScriptController({
      document,
      resourceId: "analytics-script",
    });

    await controller.start();
    const second = document.createElement("script");
    second.type = "text/plain";
    second.dataset["ocResource"] = "analytics-script";
    second.dataset["src"] = "https://cdn.example.test/second.js";
    document.head.append(second);

    await expect(controller.discover()).resolves.toBe("partial");
    await controller.start();
    await controller.start();

    expect(
      Array.from(
        document.querySelectorAll<HTMLScriptElement>(
          'script[data-oc-active-resource="analytics-script"]',
        ),
      ).map((script) => script.src),
    ).toEqual([
      "https://cdn.example.test/first.js",
      "https://cdn.example.test/second.js",
    ]);
    browserWindow.close();
  });
});

describe("createBlockedIframeController", () => {
  it("TEST-IFRAME-NONNAVIGABLE-PLACEHOLDER activates only after consent", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const placeholder = document.createElement("template");
    placeholder.dataset["ocIframe"] = "";
    placeholder.dataset["ocCategory"] = "marketing";
    placeholder.dataset["ocResource"] = "video-frame";
    placeholder.dataset["src"] = "https://video.example.test/embed/42";
    placeholder.className = "product-video";
    placeholder.title = "Product video";
    document.body.append(placeholder);
    const controller = createBlockedIframeController({
      category: "marketing",
      document,
      resourceId: "video-frame",
    });

    await expect(controller.discover()).resolves.toBe("blocked");
    expect(document.querySelectorAll("iframe")).toHaveLength(0);

    await expect(controller.start()).resolves.toEqual({
      irreversibleEffects: ["iframe-navigation-may-persist"],
    });

    expect(placeholder.isConnected).toBe(true);
    const active = document.querySelector<HTMLIFrameElement>(
      'iframe[data-oc-active-resource="video-frame"]',
    );
    expect(active).not.toBeNull();
    expect(active?.src).toBe("https://video.example.test/embed/42");
    expect(active?.className).toBe("product-video");
    expect(active?.title).toBe("Product video");
    await expect(controller.discover()).resolves.toBe("active");

    await controller.stop();

    expect(active?.isConnected).toBe(false);
    expect(placeholder.isConnected).toBe(true);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    await expect(controller.discover()).resolves.toBe("blocked");

    await controller.start();
    const restarted = document.querySelector<HTMLIFrameElement>(
      'iframe[data-oc-active-resource="video-frame"]',
    );
    expect(restarted).not.toBeNull();
    expect(restarted).not.toBe(active);
    expect(restarted?.src).toBe("https://video.example.test/embed/42");
    browserWindow.close();
  });

  it("TEST-IFRAME-TRANSACTIONAL-ACTIVATION rolls back a rejected navigation", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const placeholder = document.createElement("template");
    placeholder.dataset["ocIframe"] = "";
    placeholder.dataset["ocCategory"] = "marketing";
    placeholder.dataset["ocResource"] = "video-frame";
    placeholder.dataset["srcdoc"] = "<p>Product video</p>";
    document.body.append(placeholder);
    const controller = createBlockedIframeController({
      category: "marketing",
      document,
      resourceId: "video-frame",
    });
    const srcdocSetter = vi
      .spyOn(browserWindow.HTMLIFrameElement.prototype, "srcdoc", "set")
      .mockImplementation(() => {
        throw new TypeError("TrustedHTML required");
      });

    await expect(
      Promise.resolve().then(() => controller.start()),
    ).rejects.toThrow("TrustedHTML required");
    expect(
      document.querySelectorAll('[data-oc-active-resource="video-frame"]'),
    ).toHaveLength(0);
    await expect(controller.discover()).resolves.toBe("blocked");

    srcdocSetter.mockRestore();
    await expect(controller.start()).resolves.toEqual({
      irreversibleEffects: ["iframe-navigation-may-persist"],
    });
    expect(
      document.querySelectorAll('[data-oc-active-resource="video-frame"]'),
    ).toHaveLength(1);
    browserWindow.close();
  });

  it("TEST-IFRAME-RELOAD-ISOLATION keeps navigation off the declarative source", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const iframe = document.createElement("iframe");
    iframe.dataset["ocCategory"] = "marketing";
    iframe.dataset["ocResource"] = "video-frame";
    iframe.dataset["src"] = "https://video.example.test/embed/42";
    iframe.setAttribute("aria-hidden", "false");
    iframe.title = "Product video";
    document.body.append(iframe);
    const controller = createBlockedIframeController({
      category: "marketing",
      document,
      resourceId: "video-frame",
    });

    await controller.start();

    expect(iframe.hasAttribute("src")).toBe(false);
    expect(iframe.hidden).toBe(true);
    expect(iframe.getAttribute("aria-hidden")).toBe("true");
    const active = document.querySelector<HTMLIFrameElement>(
      'iframe[data-oc-active-resource="video-frame"]',
    );
    expect(active).not.toBeNull();
    expect(active).not.toBe(iframe);
    expect(active?.src).toBe("https://video.example.test/embed/42");
    expect(active?.title).toBe("Product video");
    await controller.start();
    expect(
      document.querySelectorAll(
        'iframe[data-oc-active-resource="video-frame"]',
      ),
    ).toHaveLength(1);
    await expect(controller.discover()).resolves.toBe("active");

    await controller.stop();

    expect(active?.isConnected).toBe(false);
    expect(iframe.hidden).toBe(false);
    expect(iframe.getAttribute("aria-hidden")).toBe("false");
    expect(iframe.hasAttribute("src")).toBe(false);
    await expect(controller.discover()).resolves.toBe("blocked");
    browserWindow.close();
  });

  it("TEST-IFRAME-DETACH-RESTORE preserves legacy attributes across reattachment", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const iframe = document.createElement("iframe");
    iframe.dataset["ocResource"] = "video-frame";
    iframe.dataset["src"] = "https://video.example.test/embed/42";
    iframe.id = "product-video";
    iframe.name = "product-video-frame";
    iframe.setAttribute("aria-hidden", "false");
    document.body.append(iframe);
    const controller = createBlockedIframeController({
      document,
      resourceId: "video-frame",
    });
    await controller.start();

    iframe.remove();
    await expect(controller.discover()).resolves.toBe("dormant");

    expect(iframe.hidden).toBe(false);
    expect(iframe.id).toBe("product-video");
    expect(iframe.name).toBe("product-video-frame");
    expect(iframe.getAttribute("aria-hidden")).toBe("false");

    document.body.append(iframe);
    await controller.start();
    const active = document.querySelector<HTMLIFrameElement>(
      'iframe[data-oc-active-resource="video-frame"]',
    );
    expect(active?.hidden).toBe(false);
    expect(active?.id).toBe("product-video");
    expect(active?.name).toBe("product-video-frame");
    browserWindow.close();
  });

  it("TEST-IFRAME-RELOAD-HISTORY clears active browsing contexts before a reload", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const iframe = document.createElement("iframe");
    iframe.dataset["ocCategory"] = "marketing";
    iframe.dataset["ocResource"] = "video-frame";
    iframe.dataset["src"] = "https://video.example.test/embed/42";
    iframe.title = "Product video";
    document.body.append(iframe);
    const controller = createBlockedIframeController({
      category: "marketing",
      document,
      resourceId: "video-frame",
    });
    await controller.start();
    const active = document.querySelector<HTMLIFrameElement>(
      'iframe[data-oc-active-resource="video-frame"]',
    );
    expect(active).not.toBeNull();

    const pageHide = new browserWindow.Event("pagehide");
    Object.defineProperty(pageHide, "persisted", { value: false });
    browserWindow.dispatchEvent(pageHide);

    expect(active?.isConnected).toBe(false);
    expect(iframe.isConnected).toBe(false);
    const replacement = document.querySelector<HTMLIFrameElement>(
      'iframe[data-oc-resource="video-frame"]:not([data-oc-active-resource])',
    );
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(iframe);
    expect(replacement?.dataset["src"]).toBe(
      "https://video.example.test/embed/42",
    );
    expect(replacement?.title).toBe("Product video");
    expect(replacement?.hasAttribute("src")).toBe(false);
    expect(replacement?.hasAttribute("srcdoc")).toBe(false);
    expect(
      document.querySelectorAll("iframe[src],iframe[srcdoc]"),
    ).toHaveLength(0);
    browserWindow.close();
  });

  it("TEST-IFRAME-BFCACHE-RESTORE reloads a sanitized persisted legacy page", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const iframe = document.createElement("iframe");
    iframe.dataset["ocResource"] = "video-frame";
    iframe.dataset["src"] = "https://video.example.test/embed/42";
    document.body.append(iframe);
    const controller = createBlockedIframeController({
      document,
      resourceId: "video-frame",
    });
    const reload = vi
      .spyOn(browserWindow.location, "reload")
      .mockImplementation(() => undefined);
    await controller.start();

    const pageHide = new browserWindow.Event("pagehide");
    Object.defineProperty(pageHide, "persisted", { value: true });
    browserWindow.dispatchEvent(pageHide);
    expect(
      document.querySelectorAll("iframe[src],iframe[srcdoc]"),
    ).toHaveLength(0);

    const pageShow = new browserWindow.Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    browserWindow.dispatchEvent(pageShow);

    expect(reload).toHaveBeenCalledOnce();
    browserWindow.close();
  });

  it("keeps declared frames blank until allowed and re-blocks them", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const iframe = document.createElement("iframe");
    iframe.dataset["ocCategory"] = "marketing";
    iframe.dataset["ocResource"] = "video-frame";
    iframe.dataset["src"] = "https://video.example.test/embed/42";
    iframe.title = "Product video";
    document.body.append(iframe);
    const controller = createBlockedIframeController({
      category: "marketing",
      document,
      resourceId: "video-frame",
    });

    expect(iframe.hasAttribute("src")).toBe(false);
    await expect(controller.discover()).resolves.toBe("blocked");
    await expect(controller.start()).resolves.toEqual({
      irreversibleEffects: ["iframe-navigation-may-persist"],
    });
    const active = document.querySelector<HTMLIFrameElement>(
      'iframe[data-oc-active-resource="video-frame"]',
    );
    expect(iframe.hasAttribute("src")).toBe(false);
    expect(active?.src).toBe("https://video.example.test/embed/42");
    await expect(controller.discover()).resolves.toBe("active");

    await controller.stop();
    expect(active?.isConnected).toBe(false);
    expect(iframe.hasAttribute("src")).toBe(false);
    await expect(controller.discover()).resolves.toBe("blocked");
    browserWindow.close();
  });

  it("discovers dynamic frames and reports navigation that started before blocking", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const controller = createBlockedIframeController({
      document,
      resourceId: "support-frame",
    });

    await expect(controller.discover()).resolves.toBe("dormant");
    const iframe = document.createElement("iframe");
    iframe.dataset["ocResource"] = "support-frame";
    iframe.dataset["src"] = "https://support.example.test/widget";
    iframe.src = "https://support.example.test/widget";
    document.body.append(iframe);

    await expect(controller.block()).resolves.toEqual({
      irreversibleEffects: ["previous-iframe-navigation-unknown"],
    });
    expect(iframe.hasAttribute("src")).toBe(false);
    await expect(controller.cleanup()).resolves.toEqual({
      irreversibleEffects: [],
    });
    browserWindow.close();
  });

  it("TEST-SPA-DYNAMIC-DISCOVERY distinguishes partially activated frames", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const first = document.createElement("iframe");
    first.dataset["ocResource"] = "video-frame";
    first.dataset["src"] = "https://video.example.test/first";
    document.body.append(first);
    const controller = createBlockedIframeController({
      document,
      resourceId: "video-frame",
    });

    await controller.start();
    const second = document.createElement("iframe");
    second.dataset["ocResource"] = "video-frame";
    second.dataset["src"] = "https://video.example.test/second";
    document.body.append(second);

    await expect(controller.discover()).resolves.toBe("partial");
    await controller.start();
    expect(first.hasAttribute("src")).toBe(false);
    expect(second.hasAttribute("src")).toBe(false);
    expect(
      Array.from(
        document.querySelectorAll<HTMLIFrameElement>(
          'iframe[data-oc-active-resource="video-frame"]',
        ),
      ).map((iframe) => iframe.src),
    ).toEqual([
      "https://video.example.test/first",
      "https://video.example.test/second",
    ]);
    browserWindow.close();
  });

  it("TEST-SPA-DYNAMIC-IFRAME discovers a template inserted after startup", async () => {
    const browserWindow = new Window({ url: "https://shop.example.test" });
    const document = browserWindow.document as unknown as Document;
    const controller = createBlockedIframeController({
      document,
      resourceId: "video-frame",
    });
    await expect(controller.discover()).resolves.toBe("dormant");

    const placeholder = document.createElement("template");
    placeholder.dataset["ocIframe"] = "";
    placeholder.dataset["ocResource"] = "video-frame";
    placeholder.dataset["src"] = "https://video.example.test/dynamic";
    document.body.append(placeholder);

    await expect(controller.discover()).resolves.toBe("blocked");
    await controller.start();
    expect(
      document.querySelector<HTMLIFrameElement>(
        'iframe[data-oc-active-resource="video-frame"]',
      )?.src,
    ).toBe("https://video.example.test/dynamic");
    browserWindow.close();
  });
});
