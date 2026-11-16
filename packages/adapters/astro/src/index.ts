/** @packageDocumentation */

import type { OpenCookieExternalStore } from "@opencookie-dev/core";

/** @public */
export type AstroOpenCookieScriptStage = "before-hydration" | "page";

/** @public */
export interface AstroOpenCookieIntegrationOptions {
  /**
   * A Vite-resolvable browser module that creates the OpenCookie client and
   * mounts either the vanilla interface or a framework island.
   */
  readonly entrypoint: string;
  /**
   * `page` runs on pages with or without hydrated islands. Choose
   * `before-hydration` when the entrypoint must run before island hydration.
   *
   * @defaultValue `"page"`
   */
  readonly stage?: AstroOpenCookieScriptStage;
}

/** @public */
export interface AstroOpenCookieConfigSetupContext {
  readonly injectScript: (
    stage: AstroOpenCookieScriptStage,
    content: string,
  ) => void;
}

/**
 * The structural subset of Astro's integration contract used by OpenCookie.
 * Astro passes additional setup fields, which this integration intentionally
 * ignores.
 *
 * @public
 */
export interface AstroOpenCookieIntegration {
  readonly hooks: {
    readonly "astro:config:setup": (
      context: AstroOpenCookieConfigSetupContext,
    ) => void | Promise<void>;
  };
  readonly name: "@opencookie-dev/astro";
}

/** @public */
export interface AstroOpenCookieServerBinding<Snapshot> {
  readonly framework: "astro";
  readonly interactive: false;
  readonly snapshot: Snapshot;
}

function entrypointImport(entrypoint: string): string {
  if (entrypoint.trim().length === 0) {
    throw new TypeError("OpenCookie's Astro entrypoint must not be empty.");
  }

  return `import ${JSON.stringify(entrypoint)};`;
}

/**
 * Creates the Astro integration that loads an application-owned OpenCookie
 * browser entrypoint. The entrypoint is emitted as source for Astro and Vite
 * to resolve, and is never evaluated while the integration runs on the server.
 *
 * @public
 */
export function createAstroOpenCookieIntegration(
  options: AstroOpenCookieIntegrationOptions,
): AstroOpenCookieIntegration {
  const source = entrypointImport(options.entrypoint);
  const stage = options.stage ?? "page";

  return Object.freeze({
    name: "@opencookie-dev/astro",
    hooks: Object.freeze({
      "astro:config:setup": ({
        injectScript,
      }: AstroOpenCookieConfigSetupContext): void => {
        injectScript(stage, source);
      },
    }),
  });
}

/**
 * Reads an external store's deterministic server snapshot without subscribing
 * or touching browser globals. Use the result directly in an `.astro`
 * component that intentionally ships no hydrated framework component.
 *
 * @public
 */
export function createAstroServerBinding<Snapshot>(
  store: OpenCookieExternalStore<Snapshot>,
): AstroOpenCookieServerBinding<Snapshot> {
  return Object.freeze({
    framework: "astro",
    interactive: false,
    snapshot: store.getServerSnapshot(),
  });
}

export default createAstroOpenCookieIntegration;
