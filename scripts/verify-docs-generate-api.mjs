import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packagesRoot = path.join(repoRoot, "packages");
const outputFile = path.join(
  repoRoot,
  "apps/docs/src/content/docs/reference/api.mdx",
);

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const candidate = path.join(root, entry.name);
        if (
          entry.isDirectory() &&
          ["dist", "node_modules", "temp"].includes(entry.name)
        ) {
          return [];
        }
        return entry.isDirectory() ? walk(candidate) : [candidate];
      }),
    )
  ).flat();
}

export function exportedSymbols(source) {
  const symbols = new Map();
  for (const line of source.split("\n")) {
    const declaration = line.match(
      /^export\s+(?:declare\s+)?(class|const|enum|function|interface|type)\s+([A-Za-z_$][\w$]*)/u,
    );
    if (declaration) {
      symbols.set(declaration[2], declaration[1]);
      continue;
    }
    const named = line.match(/^export\s+\{\s*([A-Za-z_$][\w$]*)\s*\}/u);
    if (named) {
      symbols.set(named[1], "re-export");
      continue;
    }
    if (/^export\s+default\s+/u.test(line)) {
      symbols.set("default", "default");
    }
  }
  return [...symbols]
    .map(([name, kind]) => ({ kind, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function packageEntryNameFor(apiFile) {
  const packageRoot = path.dirname(path.dirname(apiFile));
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (typeof manifest.name !== "string") {
    throw new Error(`Package name is missing for ${apiFile}`);
  }
  const packageBaseName = manifest.name.split("/").at(-1);
  const reportBaseName = path.basename(apiFile, ".api.md");
  if (reportBaseName === packageBaseName) return manifest.name;

  const subpathPrefix = `${packageBaseName}-`;
  if (!reportBaseName.startsWith(subpathPrefix)) {
    throw new Error(
      `API report ${path.basename(apiFile)} does not map to package ${manifest.name}.`,
    );
  }
  return `${manifest.name}/${reportBaseName.slice(subpathPrefix.length)}`;
}

export async function generateApiReference(options = {}) {
  const resolvedPackagesRoot = options.packagesRoot ?? packagesRoot;
  const apiFiles = (await walk(resolvedPackagesRoot))
    .filter(
      (file) =>
        file.endsWith(".api.md") && path.basename(path.dirname(file)) === "etc",
    )
    .sort();
  const packages = [];

  for (const apiFile of apiFiles) {
    const source = await readFile(apiFile, "utf8");
    packages.push({
      name: await packageEntryNameFor(apiFile),
      symbols: exportedSymbols(source),
    });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));

  const lines = [
    "---",
    "title: API index",
    "description: Public OpenCookie package exports generated from API Extractor snapshots.",
    "---",
    "",
    "This page is generated from the committed API Extractor snapshots. Run `node scripts/verify-docs-generate-api.mjs` after an intentional public API change.",
    "",
  ];

  for (const entry of packages) {
    lines.push(
      `## \`${entry.name}\``,
      "",
      "| Export | Kind |",
      "| --- | --- |",
    );
    for (const symbol of entry.symbols) {
      lines.push(`| \`${symbol.name}\` | ${symbol.kind} |`);
    }
    lines.push("");
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const generated = await generateApiReference();
  if (process.argv.includes("--check")) {
    const current = await readFile(outputFile, "utf8").catch(() => "");
    if (current !== generated) {
      throw new Error(
        "Generated API reference is stale. Run node scripts/verify-docs-generate-api.mjs.",
      );
    }
    console.log("Generated API reference matches package snapshots.");
    return;
  }
  await writeFile(outputFile, generated);
  console.log(`Generated ${path.relative(repoRoot, outputFile)}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
