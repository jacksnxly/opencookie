import type {
  AccessEnforcementController,
  EnforcementOperationResult,
} from "@opencookie-dev/core/infrastructure";

import {
  documentResolver,
  enforcementResult,
  requiredIdentifier,
} from "./runtime-guards.js";
import { deleteDeclaredStorage } from "./storage-cleanup.js";

/** @public */
export interface BlockedIframeControllerOptions {
  readonly category?: string;
  readonly document?: Document;
  readonly resourceId: string;
  readonly signal?: AbortSignal;
}

function hasActiveSource(iframe: HTMLIFrameElement): boolean {
  return iframe.hasAttribute("src") || iframe.hasAttribute("srcdoc");
}

function clearActiveSource(iframe: HTMLIFrameElement): void {
  iframe.removeAttribute("srcdoc");
  iframe.removeAttribute("src");
}

type IframeSource = HTMLIFrameElement | HTMLTemplateElement;

interface LegacyIframeState {
  readonly ariaHidden: string | null;
  readonly hidden: boolean;
  readonly id: string | null;
  readonly name: string | null;
}

interface IframeActivation {
  readonly active: HTMLIFrameElement;
  readonly legacyState: LegacyIframeState | undefined;
}

const reloadScheduledDocuments = new WeakSet<Document>();

function isIframe(source: IframeSource): source is HTMLIFrameElement {
  return source.tagName === "IFRAME";
}

function restoreAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function restoreLegacySource(
  source: HTMLIFrameElement,
  state: LegacyIframeState,
): void {
  source.hidden = state.hidden;
  restoreAttribute(source, "aria-hidden", state.ariaHidden);
  restoreAttribute(source, "id", state.id);
  restoreAttribute(source, "name", state.name);
}

function frameFromTemplate(
  document: Document,
  source: HTMLTemplateElement,
): HTMLIFrameElement {
  const active = document.createElement("iframe");
  for (const attribute of Array.from(source.attributes)) {
    if (
      attribute.name === "data-oc-iframe" ||
      attribute.name === "data-src" ||
      attribute.name === "data-srcdoc" ||
      attribute.name === "hidden" ||
      attribute.name === "id"
    ) {
      continue;
    }
    active.setAttribute(attribute.name, attribute.value);
  }
  return active;
}

/**
 * Creates an enforcement controller for declaratively blocked iframes.
 * Prefer a non-navigable `template[data-oc-iframe]` placeholder with the real
 * URL in `data-src` or markup in `data-srcdoc`. The controller creates a live
 * iframe only while access is allowed. Legacy source-less iframe declarations
 * remain supported with best-effort reload-history cleanup. Each operation
 * discovers matching placeholders again so SPA insertions are included in
 * later reconciliation passes.
 *
 * @public
 */
export function createBlockedIframeController(
  options: BlockedIframeControllerOptions,
): AccessEnforcementController {
  const resourceId = requiredIdentifier(
    options.resourceId,
    "Blocked iframe resource identifier",
  );
  const category =
    options.category === undefined
      ? undefined
      : requiredIdentifier(options.category, "Blocked iframe category");
  const getDocument = documentResolver(
    options.document,
    "Blocked iframe operations require a browser Document. Pass document when using an isolated DOM.",
  );

  const activations = new Map<IframeSource, IframeActivation>();
  let everNavigatedLegacyFrame = false;
  let lifecycleWindow: Window | undefined;
  let resumeRequiresReload = false;
  let suspended = false;

  const sourceFrames = (): readonly IframeSource[] =>
    Array.from(
      getDocument().querySelectorAll<IframeSource>(
        "iframe[data-oc-resource]:not([data-oc-active-resource]),template[data-oc-iframe][data-oc-resource]",
      ),
    ).filter(
      (source) =>
        source.dataset["ocResource"] === resourceId &&
        (category === undefined || source.dataset["ocCategory"] === category),
    );

  const activeIframes = (): readonly HTMLIFrameElement[] =>
    Array.from(
      getDocument().querySelectorAll<HTMLIFrameElement>(
        "iframe[data-oc-active-resource]",
      ),
    ).filter(
      (iframe) =>
        iframe.dataset["ocActiveResource"] === resourceId &&
        (category === undefined || iframe.dataset["ocCategory"] === category),
    );

  const pruneActivations = (): void => {
    for (const [source, activation] of activations) {
      if (source.isConnected && activation.active.isConnected) continue;
      activation.active.remove();
      if (isIframe(source) && activation.legacyState !== undefined) {
        restoreLegacySource(source, activation.legacyState);
      }
      activations.delete(source);
    }
  };

  const sanitizeLegacyHistory = (event: Event): void => {
    if (!everNavigatedLegacyFrame) return;
    suspended = true;
    const legacySources = sourceFrames().filter(isIframe);
    const activeFrames = activeIframes();

    for (const source of legacySources) {
      const replacement = source.cloneNode(false) as HTMLIFrameElement;
      const state = activations.get(source)?.legacyState;
      if (state !== undefined) restoreLegacySource(replacement, state);
      clearActiveSource(replacement);
      source.replaceWith(replacement);
    }
    for (const active of activeFrames) {
      const replacement = active.cloneNode(false) as HTMLIFrameElement;
      clearActiveSource(replacement);
      replacement.removeAttribute("data-src");
      replacement.removeAttribute("data-srcdoc");
      active.replaceWith(replacement);
    }
    activations.clear();
    resumeRequiresReload = "persisted" in event && event.persisted === true;
  };

  const resumeLegacyPage = (event: Event): void => {
    if (
      !resumeRequiresReload ||
      !("persisted" in event) ||
      event.persisted !== true
    ) {
      return;
    }
    resumeRequiresReload = false;
    const document = getDocument();
    if (reloadScheduledDocuments.has(document)) return;
    reloadScheduledDocuments.add(document);
    document.defaultView?.location.reload();
  };

  const observeLegacyLifecycle = (): void => {
    if (lifecycleWindow !== undefined || options.signal?.aborted === true)
      return;
    const window = getDocument().defaultView;
    if (window === null) return;
    lifecycleWindow = window;
    const listenerOptions =
      options.signal === undefined ? undefined : { signal: options.signal };
    window.addEventListener("pagehide", sanitizeLegacyHistory, listenerOptions);
    window.addEventListener("pageshow", resumeLegacyPage, listenerOptions);
  };

  const restoreAndRemove = (
    source: IframeSource,
    activation: IframeActivation,
  ): void => {
    activation.active.remove();
    if (isIframe(source) && activation.legacyState !== undefined) {
      restoreLegacySource(source, activation.legacyState);
    }
    activations.delete(source);
  };

  const blockFrames = (): boolean => {
    pruneActivations();
    let previousNavigationUnknown = false;
    for (const source of sourceFrames()) {
      if (isIframe(source) && hasActiveSource(source)) {
        previousNavigationUnknown = true;
        everNavigatedLegacyFrame = true;
        observeLegacyLifecycle();
        clearActiveSource(source);
      }
    }
    for (const [source, activation] of [...activations]) {
      if (hasActiveSource(activation.active)) {
        previousNavigationUnknown = true;
      }
      restoreAndRemove(source, activation);
    }
    return previousNavigationUnknown;
  };

  return Object.freeze({
    block(): Promise<EnforcementOperationResult> {
      return Promise.resolve(
        blockFrames()
          ? enforcementResult("previous-iframe-navigation-unknown")
          : enforcementResult(),
      );
    },

    cleanup(): Promise<EnforcementOperationResult> {
      return new Promise((resolve) => {
        blockFrames();
        deleteDeclaredStorage(getDocument(), sourceFrames(), resourceId);
        resolve(enforcementResult());
      });
    },

    discover() {
      pruneActivations();
      const sources = sourceFrames();
      if (sources.length === 0) return Promise.resolve("dormant" as const);
      if (suspended) return Promise.resolve("blocked" as const);
      const activeCount = sources.filter((source) => {
        const activation = activations.get(source);
        return (
          (isIframe(source) && hasActiveSource(source)) ||
          (activation !== undefined && activation.active.isConnected)
        );
      }).length;
      if (activeCount === 0) return Promise.resolve("blocked" as const);
      return Promise.resolve(
        activeCount === sources.length
          ? ("active" as const)
          : ("partial" as const),
      );
    },

    start(): Promise<EnforcementOperationResult> {
      if (suspended) return Promise.resolve(enforcementResult());
      pruneActivations();
      let navigationStarted = false;
      const document = getDocument();
      for (const source of sourceFrames()) {
        if (isIframe(source) && hasActiveSource(source)) {
          everNavigatedLegacyFrame = true;
          observeLegacyLifecycle();
          continue;
        }
        const current = activations.get(source);
        if (current !== undefined && current.active.isConnected) continue;
        const sourceDocument = source.dataset["srcdoc"];
        const sourceUrl = source.dataset["src"];
        if (sourceDocument === undefined && sourceUrl === undefined) continue;

        const active = isIframe(source)
          ? (source.cloneNode(false) as HTMLIFrameElement)
          : frameFromTemplate(document, source);
        const legacyState = isIframe(source)
          ? {
              ariaHidden: source.getAttribute("aria-hidden"),
              hidden: source.hidden,
              id: source.getAttribute("id"),
              name: source.getAttribute("name"),
            }
          : undefined;
        clearActiveSource(active);
        active.removeAttribute("data-src");
        active.removeAttribute("data-srcdoc");
        active.dataset["ocActiveResource"] = resourceId;

        try {
          if (legacyState !== undefined && isIframe(source)) {
            source.hidden = true;
            source.setAttribute("aria-hidden", "true");
            source.removeAttribute("id");
            source.removeAttribute("name");
          }
          source.insertAdjacentElement("afterend", active);
          if (sourceDocument !== undefined) {
            active.srcdoc = sourceDocument;
          } else if (sourceUrl !== undefined) {
            active.src = sourceUrl;
          }
          activations.set(source, { active, legacyState });
          if (legacyState !== undefined) {
            everNavigatedLegacyFrame = true;
            observeLegacyLifecycle();
          }
          navigationStarted = true;
        } catch (error) {
          active.remove();
          if (legacyState !== undefined && isIframe(source)) {
            restoreLegacySource(source, legacyState);
          }
          activations.delete(source);
          throw error;
        }
      }
      return Promise.resolve(
        navigationStarted
          ? enforcementResult("iframe-navigation-may-persist")
          : enforcementResult(),
      );
    },

    stop(): Promise<void> {
      blockFrames();
      return Promise.resolve();
    },
  });
}
