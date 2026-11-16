import type { FileSystemPort } from "./contracts.js";

/** The configuration init generates, which binds resources to purposes. */
export const CONFIGURATION_PATH = "opencookie.config.ts";

/**
 * The purposes the project's configuration binds resources to that a policy
 * does not declare, sorted.
 *
 * The configuration throws when the application imports it against a policy
 * without one of them. It is the project's own code, so it is read rather than
 * run: every `purposeIds` list in it counts as a binding. A binding written
 * some other way is not seen here and still fails when the application loads.
 */
export async function purposesMissingForConfiguration(
  fileSystem: FileSystemPort,
  declaredPurposeIds: Iterable<string>,
): Promise<readonly string[]> {
  if (!(await fileSystem.exists(CONFIGURATION_PATH))) return [];
  const source = await fileSystem.readFile(CONFIGURATION_PATH);
  const declared = new Set(declaredPurposeIds);
  const bound = new Set<string>();
  for (const [, list = ""] of source.matchAll(
    /purposeIds\s*:\s*\[([^\]]*)\]/gu,
  )) {
    for (const [, id = ""] of list.matchAll(/["'`]([^"'`]+)["'`]/gu)) {
      bound.add(id);
    }
  }
  return [...bound].filter((id) => !declared.has(id)).sort();
}
