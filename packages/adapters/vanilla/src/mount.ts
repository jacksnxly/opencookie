import type { OpenCookie, OpenCookieSnapshot } from "@opencookie-dev/core";
import type { PolicyText } from "@opencookie-dev/core/domain";

import { resolveDocument } from "./runtime-guards.js";

/** @public */
export interface VanillaOpenCookieCopy {
  readonly acceptAll: string;
  readonly close: string;
  readonly description: string;
  readonly dismiss: string;
  readonly eyebrow: string;
  /** The BCP 47 language of this copy, which the interface declares. */
  readonly lang: string;
  readonly manage: string;
  readonly notControlled: string;
  readonly open: string;
  readonly retryPersistence: string;
  readonly rejectAll: string;
  readonly requires: string;
  readonly restricted: string;
  readonly save: string;
  readonly persistenceFailure: string;
  readonly title: string;
  readonly withdrawConsent: string;
}

/**
 * A link the banner shows, such as the privacy notice or the imprint.
 *
 * @public
 */
export interface VanillaOpenCookieLink {
  readonly href: string;
  readonly label: string;
}

/** @public */
export interface VanillaOpenCookieMountOptions {
  readonly client: OpenCookie;
  readonly copy?: Partial<VanillaOpenCookieCopy>;
  readonly document?: Document;
  /**
   * Whether the floating button that reopens the choices is shown once a
   * decision is stored. `false` leaves it out while the page carries its own
   * `data-oc-open-preferences` entry point, and moves focus there instead. A
   * page without one still shows it, so the choices stay reachable. While the
   * banner is hidden, removing the last such element brings the button back,
   * and putting one back removes it.
   *
   * @defaultValue `true`
   */
  readonly launcher?: boolean;
  /** Links shown in the banner, in the given order. */
  readonly links?: readonly VanillaOpenCookieLink[];
  readonly nonce?: string;
  readonly onError?: (error: unknown) => void;
}

/**
 * Finds the page's own entry point, which replaces the launcher under
 * `launcher: false`. Only the programmatic entry points pass it, so the
 * drop-in, which has no such option, does not carry it. @internal
 */
export type VanillaOwnEntryPoint = (document: Document) => HTMLElement | null;

/** The page's own entry point for a `launcher` option. @internal */
export function launcherReplacement(
  launcher: boolean | undefined,
): VanillaOwnEntryPoint | undefined {
  return launcher === false
    ? (document) =>
        document.querySelector<HTMLElement>("[data-oc-open-preferences]")
    : undefined;
}

/** @public */
export interface MountedOpenCookie {
  readonly destroy: () => void;
  readonly ready: Promise<void>;
}

/**
 * The event every entry point dispatches on `document` with what the visitor
 * now permits, for bridges to vendors OpenCookie does not load itself.
 *
 * @public
 */
export const OPENCOOKIE_CHANGE_EVENT = "opencookie:change";

/**
 * The detail of an {@link OPENCOOKIE_CHANGE_EVENT} event.
 *
 * @public
 */
export interface OpenCookieChangeDetail {
  /** The optional purposes the visitor permits now, in policy order. */
  readonly permitted: readonly string[];
  /** True only for the first event, which reports the restored decision. */
  readonly restored: boolean;
  /** The purposes permitted before this change and not now. */
  readonly revoked: readonly string[];
}

/** Core-owned purpose closure used by the shared browser host. @internal */
export type VanillaPurposeDependencyResolver = (
  policy: OpenCookieSnapshot["policySnapshot"]["policy"],
  purposeId: string,
) => readonly string[];

/** Core-owned category expansion used by the shared browser host. @internal */
export type VanillaCategorySelectionResolver = (
  policy: OpenCookieSnapshot["policySnapshot"]["policy"],
  categoryIds: readonly string[],
) => readonly string[];

/** Core-owned batch purpose closure used for a category choice. @internal */
export type VanillaCategoryDependencyResolver = (
  policy: OpenCookieSnapshot["policySnapshot"]["policy"],
  purposeIds: readonly string[],
  mode: "complete" | "supported",
) => readonly string[];

/** Domain-owned grouping projected as identifiers for the shared host. @internal */
export interface VanillaPolicyPresentationSection {
  readonly categoryId: string | null;
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly purposeIds: readonly string[];
}

/** Domain-owned section projection used by the shared browser host. @internal */
export type VanillaPolicyPresentationResolver = (
  policy: OpenCookieSnapshot["policySnapshot"]["policy"],
  selectedPurposeIds: ReadonlySet<string>,
) => readonly VanillaPolicyPresentationSection[];

/** Domain-owned text for the page's language, used by the shared host. @internal */
export type VanillaPolicyTextResolver = (
  policy: OpenCookieSnapshot["policySnapshot"]["policy"],
  locale: string,
) => PolicyText;

const DEFAULT_COPY: VanillaOpenCookieCopy = {
  lang: "en",
  acceptAll: "Accept all",
  close: "Close preferences",
  description:
    "Choose which optional purposes you allow. You can change your decision at any time.",
  dismiss: "Close",
  eyebrow: "Privacy preferences",
  manage: "Settings",
  notControlled: "Not controlled by these choices",
  open: "Privacy choices",
  retryPersistence: "Try saving again",
  rejectAll: "Reject all",
  requires: "Requires",
  restricted: "Blocked by your browser's privacy signal.",
  save: "Save choices",
  persistenceFailure:
    "We could not save your choice. No additional optional services were enabled; previously saved choices remain in effect.",
  title: "Your choices, clearly.",
  withdrawConsent: "Withdraw consent",
};

/**
 * The copy with the defaults filled in. A locale usually arrives as JSON,
 * where a missing string is null rather than an absent key. Spreading it would
 * overwrite the default and paint a coerced "null" into a control, so only
 * usable strings override. @internal
 */
export function resolveCopy(
  copy: Partial<VanillaOpenCookieCopy> | undefined,
): VanillaOpenCookieCopy {
  return {
    ...DEFAULT_COPY,
    ...Object.fromEntries(
      Object.entries(copy ?? {}).filter(
        ([, value]) => typeof value === "string" && value.trim(),
      ),
    ),
  };
}

/** A banner address is a site path, a fragment, or an absolute http(s) URL. */
function acceptedLinkAddress(href: string): boolean {
  // A browser treats "\" as "/" and drops tabs and line breaks inside a scheme.
  if (href.includes("\\")) return false;
  for (const character of href) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return false;
  }
  const address = href.trim();
  if (address.startsWith("/") && !address.startsWith("//")) return true;
  if (address.startsWith("#")) return true;
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Refuses a banner link that could run script, or a blank label, before
 * anything is mounted. @internal
 */
function linkField(link: object, field: "href" | "label"): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(link, field);
    if (descriptor !== undefined && "value" in descriptor) {
      return descriptor.value;
    }
  } catch {
    // A proxy that throws, or a getter, is not a link we can render.
  }
  return undefined;
}

function assertOneBannerLink(link: unknown): void {
  if (typeof link !== "object" || link === null) {
    throw new TypeError("An OpenCookie link needs a label.");
  }
  const label = linkField(link, "label");
  const href = linkField(link, "href");
  if (typeof label !== "string" || label.trim() === "") {
    throw new TypeError("An OpenCookie link needs a label.");
  }
  if (typeof href !== "string" || !acceptedLinkAddress(href)) {
    throw new TypeError(
      "An OpenCookie link address must be an http(s) URL, a site path, or a fragment.",
    );
  }
}

export function assertBannerLinks(
  links: readonly VanillaOpenCookieLink[] | undefined,
): void {
  if (links === undefined) return;
  if (!Array.isArray(links)) {
    throw new TypeError("OpenCookie links must be a list.");
  }
  for (const link of links) {
    assertOneBannerLink(link);
  }
}

const STYLES = `:where(.oc-root){--oc-ink:#0f172a;--oc-paper:#ffffff;--oc-muted:#475569;--oc-accent:#1d4ed8;--oc-radius:12px;--oc-border:color-mix(in srgb,var(--oc-ink) 14%,transparent);--oc-shadow:0 12px 32px color-mix(in srgb,var(--oc-ink) 18%,transparent);position:relative;z-index:2147483000;color:var(--oc-ink);font-family:inherit;line-height:1.45}.oc-root *{box-sizing:border-box}:where(.oc-root *){color:var(--oc-ink)}.oc-bar{position:fixed;inset:auto 1rem 1rem;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,36rem);gap:1rem;align-items:center;max-width:72rem;margin-inline:auto;border:1px solid var(--oc-border);border-radius:var(--oc-radius);background:var(--oc-paper);box-shadow:var(--oc-shadow);padding:1rem;max-height:calc(100vh - 2rem);max-height:calc(100dvh - 2rem);overflow:auto;container-type:inline-size}.oc-bar-copy{grid-column:1 / -1;min-width:0}.oc-bar-links{grid-column:1;grid-row:2;display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;min-width:0}.oc-link{color:var(--oc-accent);font-size:.875rem;font-weight:500;text-decoration:underline}.oc-bar-title{max-width:none;margin:0;padding-right:4.5rem;font-size:1.125rem;font-weight:700;letter-spacing:normal;line-height:1.3}.oc-bar-description{max-width:none;margin:.5rem 0 0;color:var(--oc-muted);font-size:1rem}.oc-panel{width:min(100% - 2rem,40rem);max-height:calc(100vh - 2rem);margin:auto;overflow:auto;border:1px solid var(--oc-border);border-radius:var(--oc-radius);background:var(--oc-paper);color:var(--oc-ink);box-shadow:var(--oc-shadow);padding:clamp(1.25rem,3vw,2rem)}.oc-panel::backdrop{background:rgba(23,25,18,.56)}.oc-meta{margin:0 0 1rem;color:var(--oc-muted);font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.oc-title{max-width:none;margin:0;font-size:1.5rem;font-weight:700;letter-spacing:normal;line-height:1.2}.oc-description{max-width:56ch;margin:1rem 0 1.5rem;color:var(--oc-muted);font-size:1rem}.oc-alert{margin:0 0 1rem;border:1px solid var(--oc-border);padding:.875rem;font-weight:700}.oc-exceptions{margin:0 0 1.5rem;border:1px solid var(--oc-border);border-radius:var(--oc-radius);padding:1rem}.oc-exceptions h3{margin:0 0 .5rem;font-size:1rem}.oc-exceptions ul{display:grid;gap:.5rem;margin:0;padding:0;list-style:none}.oc-exceptions small{display:block;color:var(--oc-muted)}.oc-notice{position:fixed;top:1rem;right:1rem;width:min(calc(100% - 2rem),28rem);border:1px solid var(--oc-border);border-radius:var(--oc-radius);background:var(--oc-paper);box-shadow:var(--oc-shadow);padding:1rem}.oc-notice .oc-btn{width:100%}.oc-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}.oc-bar-actions{grid-column:2;grid-row:2;justify-self:end;min-width:0;width:100%;max-width:36rem;grid-template-columns:repeat(3,minmax(0,1fr))}.oc-bar-actions .oc-btn{width:100%;min-width:0}.oc-btn{min-height:2.75rem;border:1px solid var(--oc-border);border-radius:calc(var(--oc-radius) - 4px);background:transparent;color:var(--oc-ink);font:inherit;font-weight:600;overflow-wrap:anywhere;cursor:pointer;padding:.75rem 1rem}.oc-alert,.oc-btn--choice{background:var(--oc-accent);color:var(--oc-paper);border-color:var(--oc-accent)}.oc-btn--quiet,.oc-btn--withdraw{background:transparent;color:var(--oc-accent);border-color:var(--oc-accent)}.oc-actions>.oc-btn:not(.oc-btn--choice){grid-column:1 / -1}.oc-btn--dismiss{position:absolute;top:.65rem;right:.75rem;min-height:2.75rem;border:0;background:transparent;box-shadow:none;color:var(--oc-muted);font-weight:500;text-decoration:none}.oc-btn--dismiss:hover,.oc-btn--dismiss:focus-visible{text-decoration:underline}.oc-purposes{display:grid;gap:.5rem;margin:0 0 1rem;padding:0;border:0}.oc-purposes legend{display:flex;width:100%;margin:0;padding:0;font-weight:700}.oc-purpose{display:flex;flex-direction:row-reverse;justify-content:space-between;align-items:center;gap:.75rem;border:1px solid var(--oc-border);border-radius:8px;padding:.875rem;cursor:pointer}.oc-purpose.oc-category{flex:1;width:100%;border-color:transparent;font-weight:700}.oc-purpose input{appearance:none;-webkit-appearance:none;width:44px;height:24px;margin:0;flex:0 0 auto;border:1px solid var(--oc-border);border-radius:999px;background:color-mix(in srgb,var(--oc-ink) 12%,var(--oc-paper));position:relative}.oc-purpose input::before{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:999px;background:var(--oc-paper)}.oc-purpose input:checked{background:var(--oc-accent);border-color:var(--oc-accent)}.oc-purpose input:checked::before{left:22px}.oc-purpose input:indeterminate{background:color-mix(in srgb,var(--oc-accent) 40%,var(--oc-paper));border-color:var(--oc-accent)}.oc-purpose input:indeterminate::before{left:12px}.oc-purpose input:disabled{opacity:.45}.oc-purpose small{display:block;margin-top:.15rem;color:var(--oc-muted);font-size:.875rem;font-weight:400}.oc-btn:focus-visible,.oc-link:focus-visible,.oc-purpose input:focus-visible,.oc-title:focus-visible{outline:4px solid var(--oc-ink);outline-offset:3px}.oc-launcher{position:fixed;right:1rem;bottom:1rem;border:1px solid var(--oc-border);border-radius:999px;background:var(--oc-paper);box-shadow:var(--oc-shadow)}.oc-launcher:focus-visible{outline:4px solid var(--oc-ink);outline-offset:3px;box-shadow:0 0 0 3px var(--oc-paper),var(--oc-shadow)}@container (max-width:46rem){.oc-bar-actions{grid-column:1 / -1;grid-row:2;justify-self:end}.oc-bar-links{grid-column:1 / -1;grid-row:3}}@media (max-width:36rem){.oc-bar{inset:auto .5rem .5rem;grid-template-columns:minmax(0,1fr)}.oc-bar-copy{order:1}.oc-actions{grid-template-columns:1fr}.oc-bar-actions{order:2;grid-column:1;grid-row:auto;justify-self:stretch;width:auto;max-width:none;grid-template-columns:repeat(2,minmax(0,1fr))}.oc-bar-links{order:3;grid-column:1;grid-row:auto}.oc-bar-actions .oc-btn--quiet{grid-column:1 / -1}}@supports (color:light-dark(red,red)){:where(.oc-root){--oc-ink:light-dark(#0f172a,#e8eefc);--oc-paper:light-dark(#ffffff,#0b1220);--oc-muted:light-dark(#475569,#9fb0cc);--oc-accent:light-dark(#1d4ed8,#5b8cff)}.oc-panel::backdrop{background:light-dark(rgba(23,25,18,.56),rgba(0,0,0,.72))}}@media (forced-colors:active){.oc-purpose input{appearance:auto;-webkit-appearance:auto;width:auto;height:auto}.oc-purpose input::before{content:none}}@media (prefers-reduced-motion:reduce){.oc-root *{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}.oc-bar:focus{outline:none}`;

let mountSequence = 0;

/** Shared browser host with an injected domain-owned dependency resolver. @internal */
export function mountOpenCookieHost(
  options: VanillaOpenCookieMountOptions,
  resolveDependencies: VanillaPurposeDependencyResolver,
  resolveCategoryDependencies: VanillaCategoryDependencyResolver,
  expandCategories: VanillaCategorySelectionResolver,
  projectPresentationSections: VanillaPolicyPresentationResolver,
  // Checks this tab's own stored decision when another tab announces one; the
  // default reloads, for a host that cannot read its store.
  onDecisionElsewhere?: () => void,
  // Runs once a decision made in this tab is stored, after the other tabs are
  // told of it, with the purposes the last stored decision permitted and this
  // one does not.
  onDecisionStored?: (revokedPurposeIds: readonly string[]) => void,
  // The policy's text in the copy's language; without it, its own text.
  resolveText?: VanillaPolicyTextResolver,
  // The page's own entry point, where it replaces the launcher.
  ownEntryPoint?: VanillaOwnEntryPoint,
): MountedOpenCookie {
  assertBannerLinks(options.links);
  const resolvedDocument = resolveDocument(
    options.document,
    "mountOpenCookie requires a browser Document. Pass document when using an isolated DOM.",
  );
  const element = <Tag extends keyof HTMLElementTagNameMap>(
    tagName: Tag,
    properties?: Partial<HTMLElementTagNameMap[Tag]>,
  ): HTMLElementTagNameMap[Tag] =>
    Object.assign(resolvedDocument.createElement(tagName), properties);
  const button = (
    label: string,
    action: string,
    className: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const control = element("button", {
      className: `oc-btn ${className}`,
      textContent: label,
      type: "button",
    });
    control.dataset["ocAction"] = action;
    control.addEventListener("click", onClick);
    return control;
  };
  const { client, nonce } = options;
  const host = resolvedDocument.body;
  const instanceId = `oc-${String(++mountSequence)}`;
  const barTitleId = `${instanceId}-bar-title`;
  const barDescriptionId = `${instanceId}-bar-description`;
  const titleId = `${instanceId}-title`;
  const descriptionId = `${instanceId}-description`;
  const exceptionsTitleId = `${instanceId}-exceptions-title`;
  const copy = resolveCopy(options.copy);
  let selectedPurposes = new Set<string>();
  const root = element("div", { className: "oc-root", lang: copy.lang });
  root.dataset["ocRoot"] = instanceId;
  const style = element("style", { textContent: STYLES });
  style.dataset["opencookie"] = instanceId;
  if (nonce !== undefined) style.setAttribute("nonce", nonce);
  // First in <head>, so a site rule of equal specificity wins by order.
  resolvedDocument.head.prepend(style);
  const surface = element("div");
  const dialog = element("dialog", { className: "oc-panel" });
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("aria-describedby", descriptionId);
  root.append(surface, dialog);
  host.append(root);

  // WCAG 2.4.11: while the fixed bar shows, the page scrolls focus clear of
  // it and has room at its end to do so. The page's own padding returns after.
  const page = resolvedDocument.documentElement;
  let reserve: HTMLElement | undefined;
  let reserveObserver: ResizeObserver | undefined;
  let pagePadding = "";
  const releaseBarSpace = (): void => {
    reserveObserver?.disconnect();
    reserveObserver = undefined;
    if (reserve === undefined) return;
    reserve.remove();
    reserve = undefined;
    page.style.scrollPaddingBottom = pagePadding;
  };
  const reserveBarSpace = (bar: HTMLElement): void => {
    const fit = (): void => {
      const space = `${String(Math.ceil(bar.getBoundingClientRect().height) + 32)}px`;
      if (reserve === undefined) return;
      reserve.style.height = space;
      page.style.scrollPaddingBottom = space;
    };
    releaseBarSpace();
    pagePadding = page.style.scrollPaddingBottom;
    reserve = element("div");
    reserve.dataset["ocReserve"] = "";
    reserve.setAttribute("aria-hidden", "true");
    host.append(reserve);
    fit();
    const Observer = resolvedDocument.defaultView?.ResizeObserver;
    if (Observer !== undefined) {
      reserveObserver = new Observer(fit);
      reserveObserver.observe(bar);
    }
  };

  let destroyed = false;
  let settingsVisible = false;
  let draftDirty = false;
  let settingsOpener: HTMLElement | undefined;
  let renderedPrompt: boolean | undefined;
  // Closing the bar hides it for this page view and records nothing.
  let barDismissed = false;
  let preferencesWereOpen = false;
  let promptActive = false;
  let synchronizedAccessConsent:
    OpenCookieSnapshot["runtime"]["accessConsent"] | undefined;
  let synchronizedPendingGrant: OpenCookieSnapshot["pendingGrant"] | undefined;
  const previouslyFocused = resolvedDocument.activeElement;

  // Without the launcher, the page's own entry point takes its place.
  const focusLauncher = (): void => {
    if (destroyed || dialog.open) return;
    (
      surface.querySelector<HTMLElement>('[data-oc-action="open"]') ??
      (renderedPrompt === false ? ownEntryPoint?.(resolvedDocument) : null)
    )?.focus({ preventScroll: true });
  };
  // Once, after the first paint: a first visit with nowhere else to keep
  // focus meets the choice. A stored record, an open dialog, or a page that
  // already focused something is left alone.
  let consideredFirstVisitFocus = false;
  const focusFirstVisitBar = (): void => {
    if (consideredFirstVisitFocus) return;
    consideredFirstVisitFocus = true;
    if (destroyed || renderedPrompt !== true || dialog.open) return;
    if (client.getSnapshot().record !== undefined) return;
    const active = resolvedDocument.activeElement;
    if (
      active !== null &&
      active !== resolvedDocument.body &&
      active !== resolvedDocument.documentElement
    ) {
      return;
    }
    surface
      .querySelector<HTMLElement>(".oc-bar")
      ?.focus({ preventScroll: true });
  };
  const decisionFailed = (error: unknown): void => {
    focusLauncher();
    options.onError?.(error);
  };

  const runDecision = (operation: () => Promise<unknown>): void => {
    let pending: Promise<unknown>;
    try {
      pending = operation();
    } catch (error: unknown) {
      decisionFailed(error);
      return;
    }
    focusLauncher();
    void pending.then(focusLauncher, decisionFailed);
  };

  const openSettingsFrom = (opener: HTMLElement): void => {
    settingsOpener = opener;
    settingsVisible = true;
    if (!client.getSnapshot().preferencesOpen) client.openPreferences();
    render();
  };

  const restoreOpenerFocus = (): void => {
    if (!destroyed && settingsOpener?.isConnected) settingsOpener.focus();
  };

  const closeDialog = (notifyClient: boolean): void => {
    settingsVisible = false;
    draftDirty = false;
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    restoreOpenerFocus();
    if (notifyClient) client.closePreferences();
    else render();
  };

  const barLinkRow = (): HTMLElement | undefined => {
    const links = options.links;
    if (links === undefined || links.length === 0) return undefined;
    const nav = element("nav", { className: "oc-bar-links" });
    for (const link of links) {
      const anchor = element("a", { className: "oc-link" });
      anchor.setAttribute("href", link.href.trim());
      anchor.textContent = link.label;
      nav.append(anchor);
    }
    return nav;
  };

  const render = (): void => {
    if (destroyed) return;
    const snapshot = client.getSnapshot();
    const runtime = snapshot.runtime;
    const accessConsent = runtime.accessConsent;
    const pendingGrant = snapshot.pendingGrant;
    const preferencesOpen = snapshot.preferencesOpen;
    const policy = snapshot.policySnapshot.policy;
    const text = resolveText?.(policy, copy.lang) ?? policy;
    // The text is in policy order: each purpose shows its text in the page's
    // language, and keeps its dependencies.
    const purposeById = new Map(
      policy.purposes.map((purpose, index) => [
        purpose.id,
        { ...purpose, ...text.purposes[index] },
      ]),
    );
    const requirements = (purposeId: string): readonly string[] =>
      resolveDependencies(policy, purposeId);
    // A restricted grant stays recorded but is never shown as granted.
    const restricted = new Set(runtime.restrictedPurposeIds);
    const shown = (purposeIds: ReadonlySet<string>): Set<string> =>
      new Set(
        [...purposeIds].filter((purposeId) => !restricted.has(purposeId)),
      );
    const supported = (purposeIds: Iterable<string>): Set<string> => {
      const selection = new Set(
        [...purposeIds].filter((purposeId) => purposeById.has(purposeId)),
      );
      return new Set(
        [...selection].filter((purposeId) =>
          requirements(purposeId).every((requiredId) =>
            selection.has(requiredId),
          ),
        ),
      );
    };
    const persistenceFailed =
      snapshot.lastPersistenceStatus?.startsWith("failed") === true;
    const persistenceFailure =
      pendingGrant?.phase === "persistence" || persistenceFailed;
    const failedMethod = persistenceFailed
      ? snapshot.record?.method
      : undefined;
    const preferencesJustOpened = preferencesOpen && !preferencesWereOpen;
    if (preferencesJustOpened) {
      draftDirty = false;
    }
    if (pendingGrant === undefined) synchronizedPendingGrant = undefined;
    if (
      pendingGrant !== undefined &&
      (pendingGrant.transitionId !== synchronizedPendingGrant?.transitionId ||
        pendingGrant.phase !== synchronizedPendingGrant.phase ||
        pendingGrant.grantedPurposeIds.length !==
          synchronizedPendingGrant.grantedPurposeIds.length ||
        pendingGrant.grantedPurposeIds.some(
          (purposeId, index) =>
            purposeId !== synchronizedPendingGrant?.grantedPurposeIds[index],
        ))
    ) {
      selectedPurposes = supported(pendingGrant.grantedPurposeIds);
      synchronizedPendingGrant = pendingGrant;
      draftDirty = false;
    } else if (
      pendingGrant === undefined &&
      !persistenceFailure &&
      (preferencesJustOpened ||
        !settingsVisible ||
        (!draftDirty && accessConsent !== synchronizedAccessConsent))
    ) {
      selectedPurposes = supported(
        accessConsent.decisions.flatMap((decision) =>
          decision.decision === "granted" ? [decision.purposeId] : [],
        ),
      );
      synchronizedAccessConsent = accessConsent;
    }
    const prompt =
      runtime.policyReconciliation?.prompt ?? runtime.consentEvaluation.prompt;
    promptActive = prompt;
    if (!prompt) barDismissed = false;
    const showBar = prompt && !barDismissed;
    const appendPersistenceFailure = (
      messageParent: HTMLElement,
      actionParent?: HTMLElement,
    ): void => {
      const alert = element("p", {
        className: "oc-alert",
        textContent: copy.persistenceFailure,
      });
      alert.setAttribute("role", "alert");
      messageParent.append(alert);
      if (pendingGrant?.phase === "persistence") {
        actionParent?.append(
          button(
            copy.retryPersistence,
            "retry-pending-grant",
            "oc-btn--save",
            () => {
              runDecision(client.retryPendingGrant);
            },
          ),
        );
      } else if (failedMethod === "withdrawal") {
        actionParent?.append(
          button(
            copy.retryPersistence,
            "retry-withdrawal",
            "oc-btn--save",
            () => {
              runDecision(client.withdrawConsent);
            },
          ),
        );
      } else if (failedMethod === "reject-all") {
        actionParent?.append(
          button(copy.rejectAll, "reject-all", "oc-btn--choice", () => {
            runDecision(client.rejectAll);
          }),
        );
      } else if (failedMethod === "granular") {
        // Resubmits exactly the choices that failed to save.
        const granted = (snapshot.record?.decisions ?? []).flatMap(
          (decision) =>
            decision.value === "granted" ? [decision.purposeId] : [],
        );
        actionParent?.append(
          button(copy.retryPersistence, "retry-save", "oc-btn--save", () => {
            runDecision(() => client.savePreferences(granted));
          }),
        );
      }
    };
    if (
      persistenceFailure &&
      !prompt &&
      !settingsVisible &&
      renderedPrompt !== undefined &&
      preferencesOpen
    ) {
      client.closePreferences();
      return;
    }
    if (!prompt && preferencesOpen && preferencesJustOpened) {
      settingsVisible = true;
    } else if (!prompt && !preferencesOpen) {
      settingsVisible = false;
    }

    if (
      renderedPrompt !== showBar &&
      (!settingsVisible || settingsOpener?.isConnected !== true)
    ) {
      surface.replaceChildren();
      if (showBar) {
        const bar = element("section", { className: "oc-bar" });
        bar.setAttribute("aria-labelledby", barTitleId);
        bar.setAttribute("aria-describedby", barDescriptionId);
        bar.setAttribute("tabindex", "-1");
        const barCopy = element("div", { className: "oc-bar-copy" });
        const barTitle = element("h2", {
          className: "oc-bar-title",
          id: barTitleId,
          textContent: copy.title,
        });
        const barDescription = element("p", {
          className: "oc-bar-description",
          id: barDescriptionId,
          textContent: copy.description,
        });
        const barActions = element("div", {
          className: "oc-actions oc-bar-actions",
        });
        const reject = button(
          copy.rejectAll,
          "reject-all",
          "oc-btn--choice",
          () => {
            runDecision(client.rejectAll);
          },
        );
        const accept = button(
          copy.acceptAll,
          "accept-all",
          "oc-btn--choice",
          () => {
            runDecision(client.acceptAll);
          },
        );
        const settings = button(
          copy.manage,
          "settings",
          "oc-btn--choice oc-btn--quiet",
          () => {
            openSettingsFrom(settings);
          },
        );
        const dismissBar = (): void => {
          barDismissed = true;
          render();
          focusLauncher();
        };
        const dismiss = button(
          copy.dismiss,
          "dismiss",
          "oc-btn--dismiss",
          dismissBar,
        );
        bar.addEventListener("keydown", (event) => {
          if (event.key === "Escape") dismissBar();
        });
        barActions.append(reject, accept, settings);
        barCopy.append(barTitle, barDescription);
        const links = barLinkRow();
        bar.append(dismiss, barCopy, barActions);
        if (links !== undefined) bar.append(links);
        surface.append(bar);
        reserveBarSpace(bar);
      } else {
        releaseBarSpace();
        if (!ownEntryPoint?.(resolvedDocument)) {
          const launcher = button(copy.open, "open", "oc-launcher", () => {
            openSettingsFrom(launcher);
          });
          surface.append(launcher);
        }
      }
      renderedPrompt = showBar;
    }
    surface.querySelector(".oc-notice")?.remove();
    if (persistenceFailure) {
      const notice = element("div", { className: "oc-notice" });
      appendPersistenceFailure(notice, settingsVisible ? undefined : notice);
      surface.append(notice);
    }

    preferencesWereOpen = preferencesOpen;
    if (!settingsVisible) {
      if (dialog.open) {
        dialog.close();
        restoreOpenerFocus();
      }
      dialog.replaceChildren();
      return;
    }

    const activeDialogElement = dialog.contains(resolvedDocument.activeElement)
      ? (resolvedDocument.activeElement as HTMLElement)
      : undefined;
    const focusedAction = activeDialogElement?.dataset["ocAction"];
    const focusedInput =
      activeDialogElement?.tagName === "INPUT"
        ? (activeDialogElement as HTMLInputElement)
        : undefined;
    const titleHadFocus = activeDialogElement?.classList.contains("oc-title");
    dialog.replaceChildren();

    const eyebrow = element("p", {
      className: "oc-meta",
      textContent: copy.eyebrow,
    });
    const title = element("h2", {
      className: "oc-title",
      id: titleId,
      tabIndex: -1,
      textContent: copy.title,
    });
    const description = element("p", {
      className: "oc-description",
      id: descriptionId,
      textContent: copy.description,
    });
    const actions = element("div", { className: "oc-actions" });

    dialog.append(eyebrow, title, description);
    const declaredExceptions = runtime.accessPolicy.resources.filter(
      (resource) => resource.access === "declared-exception",
    );
    if (declaredExceptions.length > 0) {
      const exceptions = element("section", { className: "oc-exceptions" });
      exceptions.dataset["ocExceptions"] = "";
      exceptions.setAttribute("aria-labelledby", exceptionsTitleId);
      const exceptionsTitle = element("h3", {
        id: exceptionsTitleId,
        textContent: copy.notControlled,
      });
      const exceptionList = element("ul");
      for (const resource of declaredExceptions) {
        const item = element("li");
        const resourceId = element("strong", {
          textContent: resource.label ?? resource.id,
        });
        const reason = element("small", {
          textContent: resource.exceptionReason,
        });
        item.append(resourceId, reason);
        exceptionList.append(item);
      }
      exceptions.append(exceptionsTitle, exceptionList);
      dialog.append(exceptions);
    }
    if (persistenceFailure) {
      appendPersistenceFailure(dialog, actions);
    }

    const purposes = element("div");
    const categoryInputs: HTMLInputElement[] = [];
    const purposeInputs: HTMLInputElement[] = [];
    const presentation = projectPresentationSections(
      policy,
      shown(selectedPurposes),
    );
    const shownCategoryLabel = (categoryId: string): string =>
      text.categories.find(({ id }) => id === categoryId)?.label ?? categoryId;
    // One purpose whose label is the category's is the section. The category
    // checkbox and legend would only repeat that name.
    const purposeStandsForCategory = (
      section: VanillaPolicyPresentationSection,
    ): boolean => {
      if (section.categoryId === null || section.purposeIds.length !== 1) {
        return false;
      }
      const purpose = purposeById.get(section.purposeIds[0] ?? "");
      if (purpose === undefined) return false;
      return (
        purpose.label.trim().toLocaleLowerCase(copy.lang) ===
        shownCategoryLabel(section.categoryId)
          .trim()
          .toLocaleLowerCase(copy.lang)
      );
    };
    const synchronizeChoices = (): void => {
      for (const input of purposeInputs) {
        input.checked =
          selectedPurposes.has(input.value) && !restricted.has(input.value);
      }
      let categoryIndex = 0;
      // Fresh projection: checked and indeterminate follow the selection.
      // A collapsed section has no category input, so it is skipped in the
      // same order the rows were built.
      for (const section of projectPresentationSections(
        policy,
        shown(selectedPurposes),
      )) {
        if (section.categoryId === null || purposeStandsForCategory(section)) {
          continue;
        }
        const input = categoryInputs[categoryIndex++] as HTMLInputElement;
        input.checked = section.checked;
        input.indeterminate = section.indeterminate;
      }
    };
    let purposeIndex = 0;
    for (const section of presentation) {
      const purposeGroup = element("fieldset", { className: "oc-purposes" });
      if (!purposeStandsForCategory(section)) {
        const purposeLegend = element("legend");
        if (section.categoryId === null) {
          purposeLegend.textContent = copy.eyebrow;
        } else {
          const categoryId = section.categoryId;
          const categoryLabel = element("label", {
            className: "oc-purpose oc-category",
          });
          const categoryInput = element("input", {
            checked: section.checked,
            indeterminate: section.indeterminate,
            name: "opencookie-category",
            type: "checkbox",
            value: categoryId,
          });
          categoryInputs.push(categoryInput);
          categoryInput.addEventListener("change", () => {
            draftDirty = true;
            const purposeIds = expandCategories(policy, [categoryId]);
            for (const purposeId of purposeIds) {
              if (restricted.has(purposeId)) continue;
              selectedPurposes[categoryInput.checked ? "add" : "delete"](
                purposeId,
              );
            }
            selectedPurposes = new Set(
              resolveCategoryDependencies(
                policy,
                [...selectedPurposes],
                categoryInput.checked ? "complete" : "supported",
              ),
            );
            synchronizeChoices();
          });
          categoryLabel.append(categoryInput, shownCategoryLabel(categoryId));
          purposeLegend.append(categoryLabel);
        }
        purposeGroup.append(purposeLegend);
      }
      for (const purposeId of section.purposeIds) {
        const purpose = purposeById.get(purposeId);
        if (purpose === undefined) continue;
        const purposeLabel = element("label", { className: "oc-purpose" });
        const input = element("input", {
          checked:
            selectedPurposes.has(purposeId) && !restricted.has(purposeId),
          disabled: restricted.has(purposeId),
          name: "opencookie-purpose",
          type: "checkbox",
          value: purposeId,
        });
        purposeInputs.push(input);
        input.addEventListener("change", () => {
          draftDirty = true;
          if (input.checked) {
            for (const requiredId of requirements(purposeId)) {
              selectedPurposes.add(requiredId);
            }
          } else {
            selectedPurposes.delete(purposeId);
            selectedPurposes = supported(selectedPurposes);
          }
          synchronizeChoices();
        });
        const purposeCopy = element("span");
        const purposeTitle = element("strong", {
          textContent: purpose.label,
        });
        purposeCopy.append(purposeTitle);
        const purposeDescription = element("small");
        // The name is the label alone; the disclosure is read as the
        // description, so it is not heard twice.
        const purposeKey = `${instanceId}-purpose-${String(purposeIndex++)}`;
        purposeTitle.id = `${purposeKey}-name`;
        purposeDescription.id = purposeKey;
        input.setAttribute("aria-labelledby", purposeTitle.id);
        input.setAttribute("aria-describedby", purposeDescription.id);
        const dependencyLabels = purpose.dependsOn.map(
          (dependencyId) =>
            purposeById.get(dependencyId)?.label ?? dependencyId,
        );
        purposeDescription.textContent = `${purpose.disclosure}${
          dependencyLabels.length
            ? ` ${copy.requires} ${dependencyLabels.join(", ")}.`
            : ""
        }${restricted.has(purposeId) ? ` ${copy.restricted}` : ""}`;
        purposeCopy.append(purposeDescription);
        purposeLabel.append(input, purposeCopy);
        purposeGroup.append(purposeLabel);
      }
      purposes.append(purposeGroup);
    }
    dialog.append(purposes, actions);
    actions.append(
      button(copy.save, "save", "oc-btn--save", () => {
        settingsVisible = false;
        draftDirty = false;
        if (dialog.open) dialog.close();
        dialog.replaceChildren();
        restoreOpenerFocus();
        runDecision(() => client.savePreferences([...selectedPurposes].sort()));
      }),
    );

    if (
      snapshot.record !== undefined &&
      snapshot.record.method !== "withdrawal" &&
      accessConsent.decisions.some(
        (decision) => decision.decision === "granted",
      )
    ) {
      actions.append(
        button(copy.withdrawConsent, "withdraw", "oc-btn--withdraw", () => {
          runDecision(client.withdrawConsent);
        }),
      );
    }

    actions.append(
      button(copy.close, "close", "oc-btn--close", () => {
        closeDialog(!prompt);
      }),
    );

    if (!dialog.open) {
      dialog.showModal();
      title.focus();
    } else if (activeDialogElement !== undefined) {
      let focusTarget: HTMLElement | undefined;
      if (titleHadFocus) {
        focusTarget = title;
      } else if (focusedInput !== undefined) {
        focusTarget = [
          ...dialog.querySelectorAll<HTMLInputElement>("input"),
        ].find(
          ({ name, value }) =>
            name === focusedInput.name && value === focusedInput.value,
        );
      } else if (focusedAction !== undefined) {
        focusTarget = [
          ...dialog.querySelectorAll<HTMLElement>("[data-oc-action]"),
        ].find(({ dataset }) => dataset["ocAction"] === focusedAction);
      }
      (focusTarget ?? title).focus();
    }
  };

  const handleDialogCancel = (event: Event): void => {
    event.preventDefault();
    closeDialog(!promptActive);
  };
  const handleDialogTab = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const focusables = [
      ...dialog.querySelectorAll<HTMLElement>("button,input"),
    ];
    const backwards = event.shiftKey;
    if (
      resolvedDocument.activeElement === focusables.at(backwards ? 0 : -1) ||
      (backwards &&
        resolvedDocument.activeElement === dialog.querySelector(".oc-title"))
    ) {
      event.preventDefault();
      focusables.at(backwards ? -1 : 0)?.focus();
    }
  };
  dialog.addEventListener("cancel", handleDialogCancel);
  dialog.addEventListener("keydown", handleDialogTab);

  // The site's tabs announce each decision to each other once it is stored. A
  // tab holding a different one checks its own stored decision and reloads if
  // it changed, which stops what a withdrawal elsewhere ended; another install
  // on the origin keeps another store, so its decisions change nothing here. A
  // withdrawal takes effect here before it is stored, so announcing it then
  // would reload the others onto the decision it replaces. A tab that only
  // restores its stored decision announces nothing.
  const decisionIdentity = (): string => {
    const { record } = client.getSnapshot();
    return record === undefined
      ? ""
      : `${record.recordId}:${String(record.revision)}`;
  };
  const Channel = resolvedDocument.defaultView?.BroadcastChannel;
  const decisionChannel =
    Channel === undefined ? undefined : new Channel("opencookie-decision");
  let announcedDecision = decisionIdentity();
  // Identities another tab already announced. Adopting one is not announced
  // again; a decision this tab makes has a different identity and is.
  const heardDecisions = new Set<string>();
  let restored = false;
  // What the visitor permits is announced as soon as this tab enforces it: a
  // narrowing before it is stored, a grant once it is.
  let announcedPermitted: readonly string[] | undefined;
  const announcePermitted = (): void => {
    const { permittedPurposeIds } = client.getSnapshot().runtime;
    const previous = announcedPermitted;
    if (
      previous?.length === permittedPurposeIds.length &&
      previous.every(
        (purposeId, index) => purposeId === permittedPurposeIds[index],
      )
    ) {
      return;
    }
    announcedPermitted = permittedPurposeIds;
    const View = resolvedDocument.defaultView;
    if (View === null) return;
    resolvedDocument.dispatchEvent(
      new View.CustomEvent<OpenCookieChangeDetail>(OPENCOOKIE_CHANGE_EVENT, {
        detail: Object.freeze({
          permitted: permittedPurposeIds,
          restored: previous === undefined,
          revoked: Object.freeze(
            (previous ?? []).filter(
              (purposeId) => !permittedPurposeIds.includes(purposeId),
            ),
          ),
        }),
      }),
    );
  };
  // A site's own "Cookie settings" link, on any entry point and added at any
  // time, opens the choices through the same path as the launcher. It listens
  // in the capture phase, so a client-side router that handles link clicks on
  // document, registered earlier, sees the default already prevented.
  const openFromLink = (event: Event): void => {
    const link = (event.target as Element | null)?.closest<HTMLElement>(
      "[data-oc-open-preferences]",
    );
    if (link == null || !restored) return;
    event.preventDefault();
    openSettingsFrom(link);
  };
  resolvedDocument.addEventListener("click", openFromLink, true);
  // The channel can arrive before the other tab's write is visible. Keep
  // adopting for up to 2 s. When the window ends, reload only if this tab
  // still holds a record it cannot take. A store left unchanged, including
  // another install's announcement, never reloads. A choice of this tab's
  // own moves the identity and ends the window without a reload.
  const CONVERGENCE_CHECKS = 8;
  const CONVERGENCE_INTERVAL_MS = 250;
  let convergenceTimer: number | undefined;
  let convergenceGeneration = 0;
  let pendingAdoptions = 0;
  let windowClosed = false;
  let lastAdoption: "adopted" | "unchanged" | "unavailable" | undefined;
  const clearConvergenceTimer = (): void => {
    if (convergenceTimer === undefined) return;
    resolvedDocument.defaultView?.clearTimeout(convergenceTimer);
    convergenceTimer = undefined;
  };
  const reloadForElsewhere = (): void => {
    resolvedDocument.defaultView?.location.reload();
  };
  const convergencePending = (generation: number, before: string): boolean =>
    !destroyed &&
    generation === convergenceGeneration &&
    decisionIdentity() === before;
  const endConvergence = (generation: number): void => {
    if (generation !== convergenceGeneration) return;
    clearConvergenceTimer();
    convergenceGeneration += 1;
  };
  const reloadFromConvergence = (generation: number): void => {
    if (generation !== convergenceGeneration) return;
    endConvergence(generation);
    reloadForElsewhere();
  };
  const finishConvergenceWindow = (
    generation: number,
    before: string,
  ): void => {
    if (!convergencePending(generation, before) || pendingAdoptions > 0) {
      return;
    }
    // A stuck grant, or a record from another policy version. "unchanged"
    // never reloads, and a tab with no record keeps what it has.
    if (lastAdoption === "unavailable" && before !== "") {
      reloadFromConvergence(generation);
      return;
    }
    endConvergence(generation);
  };
  const applyAnnouncedDecision = (generation: number, before: string): void => {
    if (!convergencePending(generation, before)) return;
    if (onDecisionElsewhere !== undefined) {
      onDecisionElsewhere();
      return;
    }
    // A hand-wired client has no storage watch. Every result retries through
    // the window. Only its end reloads, and only for a record still held.
    const adopt = client.adoptStoredDecision;
    if (adopt === undefined) {
      reloadFromConvergence(generation);
      return;
    }
    pendingAdoptions += 1;
    void adopt().then(
      (result) => {
        if (generation !== convergenceGeneration) return;
        pendingAdoptions -= 1;
        lastAdoption = result;
        if (windowClosed) finishConvergenceWindow(generation, before);
      },
      () => {
        if (generation === convergenceGeneration) pendingAdoptions -= 1;
        // A rejected read still reloads, as it did before the retries.
        if (convergencePending(generation, before)) {
          reloadFromConvergence(generation);
        }
      },
    );
  };
  const convergeOnAnnouncedDecision = (): void => {
    clearConvergenceTimer();
    convergenceGeneration += 1;
    const generation = convergenceGeneration;
    const before = decisionIdentity();
    pendingAdoptions = 0;
    windowClosed = false;
    lastAdoption = undefined;
    applyAnnouncedDecision(generation, before);
    let checks = 0;
    const checkAgain = (): void => {
      convergenceTimer = undefined;
      if (!convergencePending(generation, before)) return;
      checks += 1;
      if (checks >= CONVERGENCE_CHECKS) {
        windowClosed = true;
        finishConvergenceWindow(generation, before);
        return;
      }
      applyAnnouncedDecision(generation, before);
      if (!convergencePending(generation, before)) return;
      convergenceTimer = resolvedDocument.defaultView?.setTimeout(
        checkAgain,
        CONVERGENCE_INTERVAL_MS,
      );
    };
    if (!convergencePending(generation, before)) return;
    convergenceTimer = resolvedDocument.defaultView?.setTimeout(
      checkAgain,
      CONVERGENCE_INTERVAL_MS,
    );
  };
  if (decisionChannel !== undefined) {
    decisionChannel.onmessage = (event: MessageEvent) => {
      if (destroyed || event.data === decisionIdentity()) return;
      if (typeof event.data === "string") heardDecisions.add(event.data);
      convergeOnAnnouncedDecision();
    };
  }
  // A hand-wired client runs its own controllers, so without the runtime's
  // hook the mount reloads when a decision stored in this tab blocks a
  // resource the last stored decision allowed (Pass B's M-C), or revokes a
  // purpose of one that stays allowed for another, as a container that
  // matches any does.
  const allowedResources = (): readonly string[] =>
    client
      .getSnapshot()
      .runtime.effectiveAccess.resources.filter(
        (resource) => resource.access === "allowed",
      )
      .map((resource) => resource.resourceId);
  let allowedWhenStored: readonly string[] = [];
  let permittedWhenStored: readonly string[] = [];
  const reloadIfRevoked = (revokedPurposeIds: readonly string[]): void => {
    const allowed = allowedResources();
    const { resources } = client.getSnapshot().runtime.accessPolicy;
    if (
      allowedWhenStored.some(
        (resourceId) =>
          !allowed.includes(resourceId) ||
          resources.some(
            (resource) =>
              resource.id === resourceId &&
              resource.purposeIds.some((purposeId) =>
                revokedPurposeIds.includes(purposeId),
              ),
          ),
      )
    ) {
      resolvedDocument.defaultView?.location.reload();
    }
    allowedWhenStored = allowed;
  };
  const unsubscribe = client.subscribe(() => {
    render();
    if (restored) announcePermitted();
    if (client.getSnapshot().lastPersistenceStatus !== "confirmed") return;
    const identity = decisionIdentity();
    if (identity === announcedDecision) return;
    announcedDecision = identity;
    if (!restored) return;
    // An identity another tab announced is not posted again. Any other
    // identity, including a decision made here during that adoption, is.
    if (!heardDecisions.has(identity)) decisionChannel?.postMessage(identity);
    const { permittedPurposeIds } = client.getSnapshot().runtime;
    const revoked = permittedWhenStored.filter(
      (purposeId) => !permittedPurposeIds.includes(purposeId),
    );
    permittedWhenStored = permittedPurposeIds;
    (onDecisionStored ?? reloadIfRevoked)(revoked);
  });
  const ready = client.initialize().then(() => {
    restored = true;
    allowedWhenStored = allowedResources();
    permittedWhenStored = client.getSnapshot().runtime.permittedPurposeIds;
    if (renderedPrompt === undefined) render();
    focusFirstVisitBar();
    if (!destroyed) announcePermitted();
  });

  let entryObserver: MutationObserver | undefined;
  let watchedBody: HTMLElement | null = null;
  let syncingEntry = false;
  // Under launcher: false the page's own link stands in for the button. A
  // single-page app can take that link away without a reload.
  const syncPageEntry = (): void => {
    if (
      syncingEntry ||
      destroyed ||
      ownEntryPoint === undefined ||
      !root.isConnected
    )
      return;
    syncingEntry = true;
    try {
      if (renderedPrompt !== false) return;
      const entry = ownEntryPoint(resolvedDocument);
      const launcher = surface.querySelector<HTMLElement>(
        '[data-oc-action="open"]',
      );
      if (entry !== null) {
        launcher?.remove();
        return;
      }
      if (launcher !== null) return;
      const created = button(copy.open, "open", "oc-launcher", () => {
        openSettingsFrom(created);
      });
      surface.append(created);
    } finally {
      syncingEntry = false;
    }
  };
  if (ownEntryPoint !== undefined) {
    const Observer = resolvedDocument.defaultView?.MutationObserver;
    if (Observer !== undefined) {
      const pageBody = (): HTMLBodyElement | null =>
        resolvedDocument.getElementsByTagName("body").item(0);
      const onEntryMutations = (mutations: MutationRecord[]): void => {
        if (syncingEntry || destroyed) return;
        const bodyNow = pageBody();
        if (entryObserver !== undefined && bodyNow !== watchedBody) {
          watchedBody = bodyNow;
          if (bodyNow !== null) {
            entryObserver.observe(bodyNow, {
              childList: true,
              subtree: true,
            });
          }
        }
        if (bodyNow === null || !root.isConnected) return;
        const outside = mutations.some(
          (mutation) => !root.contains(mutation.target),
        );
        if (outside) syncPageEntry();
      };
      entryObserver = new Observer(onEntryMutations);
      const body = pageBody();
      watchedBody = body;
      if (body !== null) {
        entryObserver.observe(body, { childList: true, subtree: true });
      }
      entryObserver.observe(resolvedDocument.documentElement, {
        childList: true,
      });
    }
  }

  return Object.freeze({
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearConvergenceTimer();
      convergenceGeneration += 1;
      entryObserver?.disconnect();
      entryObserver = undefined;
      dialog.removeEventListener("cancel", handleDialogCancel);
      dialog.removeEventListener("keydown", handleDialogTab);
      resolvedDocument.removeEventListener("click", openFromLink, true);
      unsubscribe();
      decisionChannel?.close();
      if (dialog.open) dialog.close();
      releaseBarSpace();
      root.remove();
      style.remove();
      if (
        previouslyFocused !== null &&
        "focus" in previouslyFocused &&
        previouslyFocused.isConnected
      ) {
        (previouslyFocused as HTMLElement).focus();
      }
    },
    ready,
  });
}
