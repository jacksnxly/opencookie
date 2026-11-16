import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const CONSUMER_PATH_PATTERN =
  /^\/\/ docs:consumer-path: ([a-zA-Z\d][a-zA-Z\d./_-]*)$/mu;
const DISPLAY_START = "// docs:display:start";
const DISPLAY_END = "// docs:display:end";

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const candidate = path.join(root, entry.name);
        return entry.isDirectory() ? walk(candidate) : [candidate];
      }),
    )
  ).flat();
}

export function extractDisplayedSample(source, fileName) {
  const consumerPath = source.match(CONSUMER_PATH_PATTERN)?.[1];
  if (!consumerPath) {
    throw new TypeError(`${fileName} is missing docs:consumer-path metadata.`);
  }
  if (
    path.isAbsolute(consumerPath) ||
    consumerPath.split("/").includes("..") ||
    !/\.(?:html|ts|tsx)$/u.test(consumerPath)
  ) {
    throw new TypeError(`${fileName} has an unsafe consumer path.`);
  }
  const startIndex = source.indexOf(DISPLAY_START);
  const endIndex = source.indexOf(DISPLAY_END);
  if (startIndex === -1 || endIndex <= startIndex) {
    throw new TypeError(`${fileName} has invalid display markers.`);
  }
  const displayed = source
    .slice(startIndex + DISPLAY_START.length, endIndex)
    .replace(/^\s*\n/u, "")
    .trimEnd();
  if (consumerPath.endsWith(".html")) {
    const template = displayed.match(/String\.raw`([\s\S]*)`;?$/u)?.[1];
    if (!template) {
      throw new TypeError(
        `${fileName} must expose HTML through one String.raw template.`,
      );
    }
    return { consumerPath, source: `${template.trim()}\n` };
  }
  return { consumerPath, source: `${displayed}\n` };
}

export async function collectDisplayedSampleIssues(samplesRoot) {
  const sampleFiles = (await walk(samplesRoot))
    .filter((file) => file.endsWith(".sample.ts"))
    .sort();
  const issues = [];
  const consumerPaths = new Map();

  for (const sampleFile of sampleFiles) {
    const relative = path.relative(samplesRoot, sampleFile);
    try {
      const sample = extractDisplayedSample(
        await readFile(sampleFile, "utf8"),
        relative,
      );
      const owner = consumerPaths.get(sample.consumerPath);
      if (owner) {
        issues.push(
          `${relative} and ${owner} share consumer path ${sample.consumerPath}.`,
        );
      } else {
        consumerPaths.set(sample.consumerPath, relative);
      }
      if (sample.source.includes("_support")) {
        issues.push(
          `${relative} exposes the private docs support module to consumers.`,
        );
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  return issues.sort();
}
