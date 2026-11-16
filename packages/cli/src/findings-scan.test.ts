import { describe, expect, it } from "vitest";

import {
  FINDINGS_INVENTORY_PATH,
  runFindingsCommand,
  type FileSystemPort,
} from "./index.js";

function harness(initial: Readonly<Record<string, string>>) {
  const files = new Map<string, string>(Object.entries(initial));
  const lines: string[] = [];
  const fileSystem: FileSystemPort = {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing file: ${path}`);
      return Promise.resolve(value);
    },
    replaceFile: (path, previous, content) => {
      if (files.get(path) !== previous) throw new Error("stale");
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (_path, operation) => operation(),
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
  };
  return {
    files,
    lines,
    ports: {
      fileSystem,
      now: () => Date.UTC(2026, 8, 21),
      writeLine: (line: string) => lines.push(line),
    },
  };
}

const PAGE_HTML = `<!doctype html><html><head>
  <script src="https://tracker.example-ads.test/tag.js"></script>
</head><body><iframe src="https://video.example-host.test/embed/1"></iframe></body></html>`;

type Inventory = {
  findings: {
    kind: string;
    name: string;
    classification: string;
    uncertainty: string;
  }[];
};
const inventory = (files: Map<string, string>) =>
  JSON.parse(
    files.get(FINDINGS_INVENTORY_PATH) ?? '{"findings":[]}',
  ) as Inventory;

describe("opencookie findings scan", () => {
  it("records what a page declares as unclassified, inferred findings", async () => {
    const test = harness({ "page.html": PAGE_HTML });

    const result = await runFindingsCommand(test.ports, [
      "scan",
      "--html",
      "page.html",
      "--page",
      "https://shop.example.test/",
    ]);

    expect(result.ok).toBe(true);
    const findings = inventory(test.files).findings;
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.classification).toBe("unclassified");
      expect(finding.uncertainty).toBe("inferred");
    }
  });

  it("requires the page address so relative URLs resolve correctly", async () => {
    const test = harness({ "page.html": PAGE_HTML });
    const result = await runFindingsCommand(test.ports, [
      "scan",
      "--html",
      "page.html",
    ]);
    expect(result.ok).toBe(false);
    expect(test.files.has(FINDINGS_INVENTORY_PATH)).toBe(false);
    expect(result.message).toMatch(/--page/u);
  });

  it("refuses a page address that is not http or https", async () => {
    const test = harness({ "page.html": PAGE_HTML });
    const result = await runFindingsCommand(test.ports, [
      "scan",
      "--html",
      "page.html",
      "--page",
      "file:///etc/passwd",
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/http/u);
  });

  it("says plainly that a scan of markup cannot see runtime behaviour", async () => {
    const test = harness({ "page.html": PAGE_HTML });
    await runFindingsCommand(test.ports, [
      "scan",
      "--html",
      "page.html",
      "--page",
      "https://shop.example.test/",
    ]);
    expect(test.lines.join("\n")).toMatch(/cookies|storage|JavaScript/iu);
  });
});
