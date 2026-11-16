import {
  bootstrapOpenCookieFixture,
  type BootstrappedFixtureOpenCookie,
} from "./fixture-client";

interface FixtureRuntime {
  active?: BootstrappedFixtureOpenCookie;
  installed?: boolean;
  root?: Element;
}

const runtime = ((
  globalThis as typeof globalThis & {
    __ocAstroFixture?: FixtureRuntime;
  }
).__ocAstroFixture ??= {});

function renderConsentStatus(): void {
  const status =
    runtime.active?.client.getSnapshot().runtime.consentEvaluation.status;
  const output = document.querySelector<HTMLElement>(
    '[data-testid="consent-status"]',
  );
  if (output !== null) output.textContent = status ?? "pending";
}

async function mountCurrentPage(): Promise<void> {
  const root = document.querySelector("[data-fixture-root=astro]");
  if (root === null || root === runtime.root) return;
  runtime.root = root;
  runtime.active?.destroy();
  const nonce = document.querySelector<HTMLElement>("meta[data-oc-csp]")?.nonce;
  try {
    const mounted = bootstrapOpenCookieFixture(
      document,
      nonce === undefined || nonce.length === 0 ? undefined : nonce,
    );
    runtime.active = mounted;
    mounted.client.subscribe(renderConsentStatus);
    renderConsentStatus();
    await mounted.ready;
    renderConsentStatus();
    document.documentElement.setAttribute("data-oc-hydrated", "true");
    document.documentElement.setAttribute("data-oc-ready", "true");
  } catch (error) {
    document.documentElement.dataset.ocError =
      error instanceof Error ? error.message : String(error);
    throw error;
  }
}

if (runtime.installed !== true) {
  runtime.installed = true;
  document.addEventListener("astro:before-swap", () => {
    runtime.active?.destroy();
    delete runtime.active;
    delete runtime.root;
  });
  document.addEventListener("astro:page-load", () => {
    void mountCurrentPage();
  });
}

void mountCurrentPage();
