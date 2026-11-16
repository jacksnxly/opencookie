import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Window } from "happy-dom";

const DOC_EXTENSIONS = new Set([".md", ".mdx"]);
const ALLOWED_MDX_COMPONENTS = new Set([
  "Aside",
  "Card",
  "CardGrid",
  "ConsentPlayground",
  "RunnableSample",
  "Steps",
]);
const SAMPLE_COMPONENT_PATTERN =
  /<RunnableSample\s+[^>]*\bid=["']([^"']+)["'][^>]*\/?>(?:<\/RunnableSample>)?/g;

function containsIndentedCode(source) {
  const lines = source.split("\n");
  let inFrontmatter = lines.at(0)?.trim() === "---";
  let inMultilineComponentTag = false;
  let inCard = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();
    if (inFrontmatter) {
      if (index > 0 && trimmed === "---") inFrontmatter = false;
      continue;
    }
    if (inMultilineComponentTag) {
      if (trimmed.includes(">")) inMultilineComponentTag = false;
      continue;
    }
    if (/^<\/Card>/u.test(trimmed)) {
      inCard = false;
      continue;
    }
    if (/^<Card(?:\s|>)/u.test(trimmed)) {
      inCard = !trimmed.includes("</Card>") && !trimmed.endsWith("/>");
      continue;
    }
    if (/^<[A-Z][A-Za-z\d]*\b/u.test(trimmed) && !trimmed.includes(">")) {
      inMultilineComponentTag = true;
      continue;
    }

    const indentation = line.length - trimmed.length;
    if (indentation >= 4 && !(inCard && indentation === 4)) return true;
  }

  return false;
}

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(root, entry.name);
      return entry.isDirectory() ? walkFiles(absolute) : [absolute];
    }),
  );
  return nested.flat().sort();
}

export function collectRunnableSampleIds(source) {
  return [...source.matchAll(SAMPLE_COMPONENT_PATTERN)].map(
    (match) => match[1],
  );
}

function routeForDoc(docsRoot, file) {
  const relative = path.relative(docsRoot, file).replaceAll(path.sep, "/");
  return relative.replace(/\.(?:md|mdx)$/u, "");
}

export async function collectDocsContractIssues({
  docsRoot,
  requiredRoutes,
  samplesRoot,
}) {
  const issues = [];
  const docsFiles = (await walkFiles(docsRoot)).filter((file) =>
    DOC_EXTENSIONS.has(path.extname(file)),
  );
  const routes = new Set(docsFiles.map((file) => routeForDoc(docsRoot, file)));
  const referencedSamples = new Set();

  for (const route of requiredRoutes) {
    if (!routes.has(route)) {
      issues.push(`Required documentation route is missing: ${route}`);
    }
  }

  for (const file of docsFiles) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(docsRoot, file);
    if (/^ {0,3}(?:`{3,}|~{3,})/mu.test(source)) {
      issues.push(
        `${relative} contains raw fenced code. Use RunnableSample so code is typechecked and executed.`,
      );
    }
    if (/<(?:pre|code)(?:\s|>)/u.test(source)) {
      issues.push(
        `${relative} contains a raw pre or code element. Use RunnableSample so code is typechecked and executed.`,
      );
    }
    if (containsIndentedCode(source)) {
      issues.push(
        `${relative} contains indented code. Use RunnableSample so code is typechecked and executed.`,
      );
    }
    for (const match of source.matchAll(/<([A-Z][A-Za-z\d]*)\b/gu)) {
      const component = match[1];
      if (!ALLOWED_MDX_COMPONENTS.has(component)) {
        issues.push(
          `${relative} uses an unapproved MDX component: ${component}. Add executable examples through RunnableSample.`,
        );
      }
    }
    for (const id of collectRunnableSampleIds(source)) {
      referencedSamples.add(id);
      const sampleFile = path.join(samplesRoot, `${id}.sample.ts`);
      try {
        const sampleSource = await readFile(sampleFile, "utf8");
        if (!/export\s+(?:async\s+)?function\s+run\s*\(/u.test(sampleSource)) {
          issues.push(`${id}.sample.ts must export a run function.`);
        }
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          issues.push(`Referenced sample is missing: ${id}.sample.ts`);
        } else {
          throw error;
        }
      }
    }
  }

  let sampleFiles = [];
  try {
    sampleFiles = (await walkFiles(samplesRoot)).filter((file) =>
      file.endsWith(".sample.ts"),
    );
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  for (const sampleFile of sampleFiles) {
    const id = path.basename(sampleFile, ".sample.ts");
    if (!referencedSamples.has(id)) {
      issues.push(`Runnable sample is not referenced by the docs: ${id}`);
    }
  }

  return issues.sort();
}

function routeForHtml(distRoot, file) {
  const relative = path.relative(distRoot, file).replaceAll(path.sep, "/");
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) {
    return `/${relative.slice(0, -"index.html".length)}`;
  }
  return `/${relative}`;
}

function decodedFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function collectIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/\s(?:id|name)=["']([^"']+)["']/giu)) {
    ids.add(match[1]);
  }
  return ids;
}

function collectLinkedValues(html) {
  return [...html.matchAll(/\s(?:href|src)=["']([^"']+)["']/giu)].map(
    (match) => match[1],
  );
}

export async function collectInternalLinkIssues(distRoot) {
  const files = await walkFiles(distRoot);
  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  const knownFiles = new Set(
    files.map(
      (file) => `/${path.relative(distRoot, file).replaceAll(path.sep, "/")}`,
    ),
  );
  const pages = new Map();
  const pageEntries = [];

  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    const route = routeForHtml(distRoot, file);
    const literalPath = `/${path.relative(distRoot, file).replaceAll(path.sep, "/")}`;
    const page = {
      file,
      html,
      ids: collectIds(html),
      route,
    };
    pages.set(route, page);
    pages.set(literalPath, page);
    pageEntries.push(page);
  }

  const issues = [];
  for (const page of pageEntries) {
    const { route } = page;
    for (const value of collectLinkedValues(page.html)) {
      if (
        /^(?:[a-z][a-z\d+.-]*:)?\/\//iu.test(value) ||
        /^(?:data|mailto|tel):/iu.test(value)
      ) {
        continue;
      }
      const url = new URL(value, `https://opencookie.dev${route}`);
      const pathname = decodeURI(url.pathname);
      const targetPage =
        pages.get(pathname) ??
        pages.get(pathname.endsWith("/") ? pathname : `${pathname}/`);
      const targetExists = targetPage !== undefined || knownFiles.has(pathname);

      if (!targetExists) {
        issues.push(`${route} links to missing internal target ${value}`);
        continue;
      }
      if (url.hash && targetPage !== undefined) {
        const id = decodedFragment(url.hash.slice(1));
        if (!targetPage.ids.has(id)) {
          issues.push(`${route} links to missing fragment ${value}`);
        }
      }
    }
  }

  return issues.sort();
}

export async function collectPageStructureIssues(distRoot) {
  const htmlFiles = (await walkFiles(distRoot)).filter((file) =>
    file.endsWith(".html"),
  );
  const issues = [];

  for (const file of htmlFiles) {
    const html = await readFile(file, "utf8");
    const route = routeForHtml(distRoot, file);
    const window = new Window({
      url: `https://opencookie.dev${route}`,
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
        enableImageFileLoading: false,
        navigation: {
          disableChildFrameNavigation: true,
          disableChildPageNavigation: true,
          disableMainFrameNavigation: true,
        },
      },
    });
    let primaryHeadingCount;
    try {
      const document = new window.DOMParser().parseFromString(
        html,
        "text/html",
      );
      primaryHeadingCount = document.querySelectorAll("h1").length;
    } finally {
      await window.happyDOM.close();
    }
    if (primaryHeadingCount === 0) {
      issues.push(`${route} has no primary heading; expected exactly one.`);
    } else if (primaryHeadingCount > 1) {
      issues.push(
        `${route} has ${primaryHeadingCount} primary headings; expected exactly one.`,
      );
    }
  }

  return issues.sort();
}

export async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
