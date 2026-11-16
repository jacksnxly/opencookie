import { readFile } from "node:fs/promises";
import { resolveVanillaExport } from "./_support.js";

// docs:consumer-path: snippets/template-import.ts
// docs:display:start
export const templateImport = String.raw`import "@opencookie-dev/vanilla/templates/soft.css";`;
// docs:display:end

export async function run(): Promise<void> {
  const specifier = /"@opencookie-dev\/vanilla\/([^"]+)"/u.exec(
    templateImport,
  )?.[1];
  if (specifier === undefined) throw new Error("The sample names no module.");
  // Resolved through the package's exports, as a bundler resolves it.
  const css = await readFile(
    await resolveVanillaExport(`./${specifier}`),
    "utf8",
  );
  if (!css.includes(".oc-root")) {
    throw new Error(`${specifier} is not an OpenCookie template.`);
  }
}
