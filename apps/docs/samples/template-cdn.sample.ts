import { access } from "node:fs/promises";
import { resolveVanillaExport } from "./_support.js";

// docs:consumer-path: snippets/template-cdn.html
// docs:display:start
export const templateLink = String.raw`<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@<version>/templates/soft.css"
/>`;
// docs:display:end

export async function run(): Promise<void> {
  const file = /@<version>\/(templates\/[a-z]+\.css)/u.exec(templateLink)?.[1];
  if (file === undefined) throw new Error("The sample links no template.");
  // The CDN serves the published package's files, so the linked path must be
  // one the package ships.
  await access(await resolveVanillaExport(`./${file}`));
}
