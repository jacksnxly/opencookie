import { parse } from "parse5";

import type { FindingKind, FindingUncertainty } from "./findings.js";

/** One resource a page's HTML declares, in the shape `findings import` accepts. @public */
export interface HtmlScanObservation {
  readonly browser: "static-html";
  readonly kind: FindingKind;
  readonly name: string;
  readonly observedAt: string;
  readonly source: string;
  readonly trigger: "declared-in-html";
  readonly uncertainty: Exclude<FindingUncertainty, "observed">;
}

interface MarkupNode {
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly MarkupNode[];
  /** A template's children live here rather than in `childNodes`. */
  readonly content?: MarkupNode;
  readonly nodeName: string;
}

const PRECONNECT = new Set(["dns-prefetch", "preconnect"]);

function attributes(node: MarkupNode): ReadonlyMap<string, string> {
  return new Map((node.attrs ?? []).map(({ name, value }) => [name, value]));
}

function resolve(value: string | undefined, page: URL): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const url = new URL(value.trim(), page);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function isCrossOrigin(value: string | undefined, page: URL): boolean {
  const resolved = resolve(value, page);
  return resolved !== undefined && new URL(resolved).origin !== page.origin;
}

function isPixelSized(attrs: ReadonlyMap<string, string>): boolean {
  const size = (name: string) => Number(attrs.get(name));
  return (
    attrs.has("width") &&
    attrs.has("height") &&
    size("width") <= 1 &&
    size("height") <= 1
  );
}

/**
 * Lists the external resources a page's HTML declares.
 *
 * This reads markup; it does not run the page. So it can find scripts,
 * iframes, preconnected destinations and likely tracking pixels that the HTML
 * names, including ones OpenCookie already holds back through `data-src`, but
 * it cannot see cookies, storage writes or anything injected by JavaScript.
 * Every result is therefore `inferred`, or `uncertain` where it rests on a
 * heuristic, and never `observed`.
 *
 * @public
 */
export function scanHtml(
  html: string,
  pageUrl: string,
  observedAt: string,
): readonly HtmlScanObservation[] {
  const page = new URL(pageUrl);
  // With scripting disabled, noscript content is parsed as markup, which is
  // where pixel fallbacks for script-based trackers usually live.
  const root = parse(html, {
    scriptingEnabled: false,
  }) as unknown as MarkupNode;
  const found = new Map<string, HtmlScanObservation>();
  const record = (
    kind: FindingKind,
    raw: string | undefined,
    uncertainty: HtmlScanObservation["uncertainty"],
  ) => {
    const name = resolve(raw, page);
    if (name === undefined) return;
    const key = `${kind} ${name}`;
    if (found.has(key)) return;
    found.set(key, {
      browser: "static-html",
      kind,
      name,
      observedAt,
      source: page.href,
      trigger: "declared-in-html",
      uncertainty,
    });
  };

  const pending: MarkupNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    const attrs = attributes(node);
    const target = attrs.get("src") ?? attrs.get("data-src");
    if (node.nodeName === "script") record("script", target, "inferred");
    else if (node.nodeName === "iframe") record("iframe", target, "inferred");
    else if (node.nodeName === "template" && attrs.has("data-oc-iframe")) {
      // OpenCookie holds an iframe back as an empty template carrying the URL.
      record("iframe", attrs.get("data-src"), "inferred");
    } else if (node.nodeName === "img" && isPixelSized(attrs)) {
      record("beacon", target, "uncertain");
    } else if (node.nodeName === "link") {
      const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/u);
      const href = attrs.get("href");
      if (rels.some((rel) => PRECONNECT.has(rel))) {
        record("network-destination", href, "inferred");
      } else if (
        (rels.includes("stylesheet") ||
          (rels.includes("preload") && attrs.get("as") === "font")) &&
        isCrossOrigin(href, page)
      ) {
        // Fetching a third-party stylesheet or font sends the visitor's
        // address to its provider. A same-origin one cannot, so it is skipped.
        record("network-destination", href, "inferred");
      }
    }
    if (node.content !== undefined) pending.push(node.content);
    for (const child of node.childNodes ?? []) pending.push(child);
  }
  return [...found.values()];
}
