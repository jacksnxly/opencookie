import { CONFIGURATION_PATH } from "./configuration-bindings.js";
import type { FileSystemPort } from "./contracts.js";

/** The pages init wires the drop-in into on a plain-HTML project. */
const PAGES = ["index.html", ".opencookie/snippet.html"] as const;

/** The version the drop-in enforces when a page names none. */
const DEFAULT_POLICY_VERSION = "policy-1";

/**
 * The policy versions a plain-HTML project's drop-in enforces, or undefined
 * when the project is not one.
 *
 * The drop-in never loads a policy module. It enforces the one purpose its
 * `data-oc-*` attributes describe, under the version they name. A project is
 * plain HTML when one of its pages loads the drop-in and it has no generated
 * configuration.
 */
export async function plainHtmlPolicyVersions(
  fileSystem: FileSystemPort,
): Promise<readonly string[] | undefined> {
  if (await fileSystem.exists(CONFIGURATION_PATH)) return undefined;
  const versions = new Set<string>();
  for (const page of PAGES) {
    if (!(await fileSystem.exists(page))) continue;
    const html = await fileSystem.readFile(page);
    for (const [tag] of html.matchAll(/<script\b[^>]*>/giu)) {
      if (!/auto\.iife\.js/u.test(tag)) continue;
      versions.add(
        /\bdata-oc-policy-version\s*=\s*"([^"]*)"/iu.exec(tag)?.[1] ??
          DEFAULT_POLICY_VERSION,
      );
    }
  }
  return versions.size === 0 ? undefined : [...versions].sort();
}

/** Why no published policy reaches a plain-HTML page's visitors. */
export function plainHtmlLimitation(versions: readonly string[]): string {
  return `This is a plain-HTML project. Its drop-in enforces the one purpose its data-oc-* attributes describe, under policy version ${versions.join(", ")}, and never loads a published policy. OpenCookie cannot yet install a published policy into a plain-HTML page.`;
}

/**
 * Whether the project directory is itself the site's web root: a plain-HTML
 * project whose index.html loads the drop-in. Anything written under it,
 * including OpenCookie's own data, is then served to anyone.
 */
export async function servesProjectDirectory(
  fileSystem: FileSystemPort,
): Promise<boolean> {
  if (
    (await fileSystem.exists(CONFIGURATION_PATH)) ||
    !(await fileSystem.exists("index.html"))
  ) {
    return false;
  }
  return /<script\b[^>]*auto\.iife\.js/iu.test(
    await fileSystem.readFile("index.html"),
  );
}
