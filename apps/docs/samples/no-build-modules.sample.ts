import { Window } from "happy-dom";

import { mountOpenCookie, VANILLA_COPY_DE } from "@opencookie-dev/vanilla";

import { createOpenCookieStore } from "../opencookie.config.js";

// docs:consumer-path: no-build/index.html
// docs:display:start
export const noBuildModulePage = String.raw`<!doctype html>
<html lang="de">
  <head>
    <script type="importmap">
      {
        "imports": {
          "@opencookie-dev/core": "/vendor/opencookie/core/index.js",
          "@opencookie-dev/core/domain": "/vendor/opencookie/core/domain.js",
          "@opencookie-dev/core/infrastructure": "/vendor/opencookie/core/infrastructure.js",
          "@opencookie-dev/vanilla": "/vendor/opencookie/vanilla/index.js"
        }
      }
    </script>
  </head>
  <body>
    <script type="module">
      import {
        CONSENT_RECORD_SCHEMA_VERSION,
        createLocalStorageDecisionStore,
        createOpenCookie,
        createPolicySnapshot,
        definePolicy,
        defineResourcePolicy,
      } from "@opencookie-dev/core";
      import { createOpenCookieBrowserBinding, VANILLA_COPY_DE } from "@opencookie-dev/vanilla";

      // Your published policy, as opencookie policy starter writes it.
      const response = await fetch("/opencookie/policy.json");
      const document = await response.json();
      const defined = definePolicy(document.policy);
      if (!defined.ok) throw new Error("The published policy is invalid.");
      const snapshot = createPolicySnapshot({
        catalogueRevision: document.catalogueRevision,
        policy: defined.policy,
        policyVersion: document.policyVersion,
      });
      const resources = defineResourcePolicy({
        policy: snapshot.policy,
        resources: [],
        services: [],
      });
      if (!resources.ok) throw new Error("The resource policy is invalid.");

      const mounted = createOpenCookieBrowserBinding({
        createClient: (ports) =>
          createOpenCookie({
            consentDurationMs: 180 * 24 * 60 * 60 * 1000,
            idGenerator: ports.idGenerator,
            now: ports.now,
            policyHistory: [snapshot],
            policySnapshot: snapshot,
            reconcile: ports.reconcile,
            resourcePolicy: resources.resourcePolicy,
            store: createLocalStorageDecisionStore({
              key: "opencookie.consent",
              schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
              storage: ports.storage,
            }),
          }),
      }).mount({ copy: VANILLA_COPY_DE });
      await mounted.ready;
    </script>
  </body>
</html>`;
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window({ url: "https://example.test/" });
  window.document.body.innerHTML = noBuildModulePage;
  const map = window.document.querySelector('script[type="importmap"]');
  const imports = (
    JSON.parse(map?.textContent ?? "{}") as {
      imports?: Record<string, string>;
    }
  ).imports;
  for (const specifier of [
    "@opencookie-dev/core",
    "@opencookie-dev/core/domain",
    "@opencookie-dev/core/infrastructure",
    "@opencookie-dev/vanilla",
  ]) {
    if (imports?.[specifier] === undefined) {
      throw new Error(`The import map does not resolve ${specifier}.`);
    }
  }
  window.close();

  // The page above is what an operator writes; this is the same mount running,
  // so the recipe cannot claim a German banner with several purposes unless one
  // renders.
  const app = new Window({ url: "https://example.test/" });
  const document = app.document as unknown as Document;
  document.documentElement.lang = "de";
  const mounted = mountOpenCookie({
    client: createOpenCookieStore(),
    copy: VANILLA_COPY_DE,
    document,
  });
  await mounted.ready;
  const actions = Array.from(document.querySelectorAll(".oc-btn--choice")).map(
    (element) => element.textContent,
  );
  if (!actions.includes("Alle akzeptieren")) {
    throw new Error(
      `The no-build page did not render German: ${actions.join("|")}`,
    );
  }
  const settings = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(({ textContent }) => textContent === "Einstellungen");
  settings?.click();
  const purposes = document.querySelectorAll(
    'input[name="opencookie-purpose"]',
  );
  if (purposes.length < 2) {
    throw new Error(
      `The no-build page offered ${String(purposes.length)} purposes, not several.`,
    );
  }
  mounted.destroy();
  app.close();
}
