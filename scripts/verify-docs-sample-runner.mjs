import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const samplesRoot = path.resolve(process.argv[2] ?? "apps/docs/samples");
const sampleFiles = (await readdir(samplesRoot))
  .filter((name) => name.endsWith(".sample.ts"))
  .sort();

for (const sampleFile of sampleFiles) {
  const module = await import(
    pathToFileURL(path.join(samplesRoot, sampleFile)).href
  );
  if (typeof module.run !== "function") {
    throw new TypeError(`${sampleFile} does not export run().`);
  }
  await module.run();
  console.log(`EXECUTED ${sampleFile}`);
}

console.log(`Executed ${sampleFiles.length} documentation samples.`);
