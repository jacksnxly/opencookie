import {
  createPolicySnapshot,
  definePolicy,
  type DecisionStore,
  type PolicyDefinition,
} from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import {
  bootstrapOpenCookie,
  bootstrapOpenCookieFromHead,
  type BootstrapOpenCookieOptions,
  type InstalledOpenCookiePolicy,
} from "./index.js";

// `opencookie policy install --out <file>.json` writes the live publication
// with the identity it was published under. A site that bundles its own
// integration passes that document to the bootstrap, which must refuse to run
// a policy that no longer derives the recorded identity: nothing mounts, and
// every declared resource stays inert.

const DEFINITION: PolicyDefinition = {
  categories: [{ id: "optional", purposeIds: ["analytics"] }],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "aggregate-measurement" }],
  presentationRootCategoryIds: ["optional"],
  providers: [{ id: "site-operator" }],
  purposes: [
    {
      dataCategoryIds: ["usage-event"],
      disclosure: "Counts visits so we can see which pages are read.",
      id: "analytics",
      label: "Analytics",
      operationIds: ["aggregate-measurement"],
      providerIds: ["site-operator"],
      recipientIds: ["site-operator"],
      retentionIds: ["thirteen-months"],
    },
  ],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: "thirteen-months" }],
};

/** The document install writes, as a bundler hands it to the page. */
function installedDocument(): InstalledOpenCookiePolicy & {
  readonly generatedBy: string;
  readonly publicationId: string;
} {
  const defined = definePolicy(DEFINITION);
  if (!defined.ok) throw new Error("The test policy must be valid.");
  const snapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: defined.policy,
    policyVersion: "1.0.0",
  });
  // A JSON round trip, as a bundled import of the file is plain data.
  return JSON.parse(
    JSON.stringify({
      generatedBy: "opencookie policy install",
      publicationId: "pub-1",
      policyVersion: snapshot.policyVersion,
      catalogueRevision: snapshot.catalogueRevision,
      catalogueDigest: snapshot.catalogueDigest,
      decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
      policy: snapshot.policy,
    }),
  ) as InstalledOpenCookiePolicy & {
    readonly generatedBy: string;
    readonly publicationId: string;
  };
}

function capturingStore(): {
  readonly records: readonly unknown[];
  readonly store: DecisionStore;
} {
  const records: unknown[] = [];
  return {
    records,
    store: {
      clear: () => {
        records.length = 0;
        return Promise.resolve();
      },
      clearIfCurrent: () => {
        records.length = 0;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet(_expected, candidate) {
        records.push(candidate);
        return Promise.resolve({ status: "written" });
      },
      read: () => Promise.resolve({ status: "missing" }),
    },
  };
}

/** A page with one declared analytics script, as a site marks it up. */
function pageWithDeclaredScript(): {
  readonly document: Document;
  readonly window: Window;
} {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = [
    '<script type="text/plain" data-src="https://tracker.example.test/t.js"',
    ' data-oc-resource="tracker" data-oc-category="analytics"></script>',
  ].join("");
  return { document: window.document as unknown as Document, window };
}

/** What the bootstrap left behind on the page. */
function effects(document: Document): Record<string, boolean> {
  return {
    activeResource:
      document.querySelector("[data-oc-active-resource]") !== null,
    root: document.querySelector("[data-oc-root]") !== null,
    runnableScript:
      document.querySelector(
        'script[src="https://tracker.example.test/t.js"]',
      ) !== null,
    style: document.querySelector("style[data-opencookie]") !== null,
  };
}

const NOTHING_HAPPENED = {
  activeResource: false,
  root: false,
  runnableScript: false,
  style: false,
};

describe("bootstrapping from an installed policy", () => {
  it("mounts and records decisions under the installed identity", async () => {
    const { document, window } = pageWithDeclaredScript();
    const installed = installedDocument();

    const started = bootstrapOpenCookie({
      document,
      installedPolicy: installed,
      now: () => 1_700_000_000_000,
      storage: window.localStorage,
    });
    await started.ready;

    expect(document.querySelector("[data-oc-root]")).not.toBeNull();
    await started.client.acceptAll();
    expect(
      document.querySelector('[data-oc-active-resource="tracker"]'),
    ).not.toBeNull();
    const stored = window.localStorage.getItem("opencookie.consent") ?? "";
    expect(stored).toContain(installed.catalogueDigest);
    expect(stored).toContain(installed.decisionSurfaceDigest);
    expect(stored).toContain('"policyVersion":"1.0.0"');
    started.destroy();
    window.close();
  });

  it("records a rejection under the installed identity in a caller's store", async () => {
    const { document, window } = pageWithDeclaredScript();
    const installed = installedDocument();
    const memory = capturingStore();

    const started = bootstrapOpenCookie({
      document,
      installedPolicy: installed,
      now: () => 1_700_000_000_000,
      store: memory.store,
    });
    await started.ready;
    await started.client.rejectAll();

    expect(memory.records[0]).toMatchObject({
      record: {
        catalogueDigest: installed.catalogueDigest,
        decisionSurfaceDigest: installed.decisionSurfaceDigest,
        policyVersion: "1.0.0",
      },
    });
    started.destroy();
    window.close();
  });

  const tampered: readonly (readonly [
    string,
    (installed: InstalledOpenCookiePolicy) => InstalledOpenCookiePolicy,
  ])[] = [
    [
      "a policy edited after install",
      (installed) => ({
        ...installed,
        policy: JSON.parse(
          JSON.stringify(installed.policy).replace(
            "Counts visits",
            "Counts visits and profiles visitors",
          ),
        ) as unknown,
      }),
    ],
    [
      "a catalogue digest it does not derive",
      (installed) => ({
        ...installed,
        catalogueDigest: `sha256-v1:${"0".repeat(64)}`,
      }),
    ],
    [
      "a decision-surface digest it does not derive",
      (installed) => ({
        ...installed,
        decisionSurfaceDigest: installed.catalogueDigest,
      }),
    ],
  ];

  it.each(tampered)(
    "throws before mounting for %s, and no resource starts",
    async (_case, tamper) => {
      const { document, window } = pageWithDeclaredScript();
      let started: ReturnType<typeof bootstrapOpenCookie> | undefined;
      let thrown: unknown;

      try {
        started = bootstrapOpenCookie({
          document,
          installedPolicy: tamper(installedDocument()),
          storage: window.localStorage,
        });
      } catch (error) {
        thrown = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(started).toBeUndefined();
      expect(thrown).toBeInstanceOf(TypeError);
      expect(String(thrown)).toMatch(/installed OpenCookie policy/u);
      expect(effects(document)).toEqual(NOTHING_HAPPENED);
      expect(window.localStorage.length).toBe(0);
      window.close();
    },
  );

  it.each([
    ["an invalid policy", { policy: { purposes: [] } }],
    ["a blank policy version", { policyVersion: " " }],
    ["a catalogue revision that is not text", { catalogueRevision: 7 }],
    ["no catalogue digest", { catalogueDigest: undefined }],
  ] as const)(
    "refuses an installed document with %s before mounting",
    (_case, broken) => {
      const { document, window } = pageWithDeclaredScript();

      expect(() =>
        bootstrapOpenCookie({
          document,
          installedPolicy: {
            ...installedDocument(),
            ...broken,
          } as unknown as InstalledOpenCookiePolicy,
        }),
      ).toThrow(TypeError);
      expect(effects(document)).toEqual(NOTHING_HAPPENED);
      window.close();
    },
  );
  // The installed document carries its own policy, version and revision. A
  // second source for any of them would leave it unclear which one runs.
  it.each([
    ["policyDefinition", { policyDefinition: DEFINITION }],
    ["policyVersion", { policyVersion: "1.0.0" }],
    ["catalogueRevision", { catalogueRevision: "catalogue-1" }],
  ] as const)(
    "refuses installedPolicy combined with %s",
    (option, combined: Partial<BootstrapOpenCookieOptions>) => {
      const { document, window } = pageWithDeclaredScript();

      expect(() =>
        bootstrapOpenCookie({
          document,
          installedPolicy: installedDocument(),
          ...combined,
        }),
      ).toThrow(
        new RegExp(`installedPolicy cannot be combined with.*${option}`, "u"),
      );
      expect(effects(document)).toEqual(NOTHING_HAPPENED);
      window.close();
    },
  );
});

describe("bootstrapping from an installed policy in <head>", () => {
  it("mounts from a matching installed policy", async () => {
    const { document, window } = pageWithDeclaredScript();

    const started = await bootstrapOpenCookieFromHead({
      document,
      installedPolicy: installedDocument(),
      storage: window.localStorage,
    });
    await started.ready;

    expect(document.querySelector(".oc-bar")).not.toBeNull();
    started.destroy();
    window.close();
  });

  it("rejects a mismatched installed policy and leaves Consent Mode denied", async () => {
    const { document, window } = pageWithDeclaredScript();
    const calls: unknown[][] = [];

    await expect(
      bootstrapOpenCookieFromHead({
        document,
        googleConsentMode: {
          command: (...call: unknown[]) => calls.push(call),
          mapping: { analyticsStorageResourceIds: ["tracker"] },
          mode: "basic",
        },
        installedPolicy: {
          ...installedDocument(),
          catalogueDigest: `sha256-v1:${"0".repeat(64)}`,
        },
        storage: window.localStorage,
      }),
    ).rejects.toThrow(/installed OpenCookie policy/u);

    expect(calls.map(([, action]) => action)).toEqual(["default"]);
    expect(effects(document)).toEqual(NOTHING_HAPPENED);
    window.close();
  });

  it("refuses installedPolicy combined with a policy definition", async () => {
    const { document, window } = pageWithDeclaredScript();

    await expect(
      bootstrapOpenCookieFromHead({
        document,
        installedPolicy: installedDocument(),
        policyDefinition: DEFINITION,
      }),
    ).rejects.toThrow(/installedPolicy cannot be combined with/u);
    expect(effects(document)).toEqual(NOTHING_HAPPENED);
    window.close();
  });
});
