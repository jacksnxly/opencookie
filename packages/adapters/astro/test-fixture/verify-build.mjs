import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = path.join(fixtureRoot, "dist");

function referencedScripts(html) {
  const scripts = [];
  const sourcePattern = /<script\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>/giu;

  for (const match of html.matchAll(sourcePattern)) {
    const source = match[2];
    if (source === undefined) continue;

    const url = new URL(source, "https://fixture.opencookie.dev/");
    if (url.origin !== "https://fixture.opencookie.dev") continue;

    const candidate = path.resolve(
      outputRoot,
      `.${decodeURIComponent(url.pathname)}`,
    );
    if (!candidate.startsWith(`${outputRoot}${path.sep}`)) {
      throw new Error(
        `Built Astro page references an unsafe script: ${source}`,
      );
    }
    scripts.push(candidate);
  }

  return scripts;
}

async function verifyBuild() {
  const html = await readFile(path.join(outputRoot, "index.html"), "utf8");

  for (const marker of [
    'data-oc-framework="astro"',
    'data-oc-interactive="false"',
    'data-oc-state="server"',
  ]) {
    if (!html.includes(marker)) {
      throw new Error(`Built Astro page is missing ${marker}.`);
    }
  }

  if (html.includes("<astro-island")) {
    throw new Error("The server-only fixture unexpectedly contains an island.");
  }

  const browserOutput = [html];
  for (const file of referencedScripts(html)) {
    browserOutput.push(await readFile(file, "utf8"));
  }

  if (!browserOutput.join("\n").includes("data-opencookie-client")) {
    throw new Error(
      "The no-island build did not include the OpenCookie browser entrypoint.",
    );
  }

  console.log(
    "Astro fixture verification passed: server snapshot rendered, zero islands, browser entrypoint bundled.",
  );
}

try {
  await verifyBuild();
} finally {
  await Promise.all([
    rm(path.join(fixtureRoot, ".astro"), { force: true, recursive: true }),
    rm(outputRoot, { force: true, recursive: true }),
  ]);
}
