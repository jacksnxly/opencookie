import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createNodeCliPorts,
  runFindingsCommand,
  type FileSystemPort,
} from "./index.js";

const INVENTORY = "opencookie/findings.json";
const OBSERVATIONS = "observations.json";

function observationsDocument(): string {
  return JSON.stringify([
    {
      browser: "chromium-141",
      kind: "cookie",
      name: "_ga",
      observedAt: "2026-09-21T10:00:00.000Z",
      source: "https://example.test/",
      trigger: "page-load",
      uncertainty: "observed",
    },
    {
      browser: "chromium-141",
      kind: "script",
      name: "https://cdn.example.test/tag.js",
      observedAt: "2026-09-21T10:00:01.000Z",
      source: "https://example.test/",
      trigger: "page-load",
      uncertainty: "uncertain",
    },
  ]);
}

interface Harness {
  readonly files: Map<string, string>;
  readonly lines: string[];
  readonly ports: {
    readonly fileSystem: FileSystemPort;
    readonly writeLine: (line: string) => void;
  };
}

function harness(initial: Readonly<Record<string, string>> = {}): Harness {
  const files = new Map<string, string>(Object.entries(initial));
  const directories = new Set<string>();
  const lines: string[] = [];
  return {
    files,
    lines,
    ports: {
      fileSystem: {
        exists: (path) => Promise.resolve(files.has(path)),
        mkdir: (path) => {
          directories.add(path);
          return Promise.resolve();
        },
        readFile: (path) => {
          const value = files.get(path);
          if (value === undefined) throw new Error(`Missing file: ${path}`);
          return Promise.resolve(value);
        },
        replaceFile: (path, expectedContent, content) => {
          if (files.get(path) !== expectedContent) {
            throw new Error(`Refusing to replace ${path}; it changed.`);
          }
          files.set(path, content);
          return Promise.resolve();
        },
        withLock: async (path, operation) => {
          if (files.has(path)) throw new Error("Already running.");
          files.set(path, "");
          try {
            return await operation();
          } finally {
            files.delete(path);
          }
        },
        writeFile: (path, content) => {
          const parent = path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : "";
          if (parent !== "" && !directories.has(parent)) {
            throw new Error(
              `ENOENT: no such file or directory, open '${path}'`,
            );
          }
          if (files.has(path)) {
            throw new Error(`EEXIST: file already exists, open '${path}'`);
          }
          files.set(path, content);
          return Promise.resolve();
        },
      },
      writeLine: (line) => lines.push(line),
    },
  };
}

const DECISION_FLAGS = [
  "--vendor",
  "google-llc",
  "--service",
  "google-analytics",
  "--category",
  "usage-data",
  "--disclosure",
  "Counts visits so we can see which pages are read.",
  "--retention",
  "thirteen-months",
  "--cleanup",
  "reblocked",
];

describe("findings command", () => {
  // A file outside the project is refused on purpose, but the command said it
  // "could not be read", which sent an operator looking for a broken file.
  it("names a refused path outside the project instead of calling it unreadable", async () => {
    const project = await mkdtemp(
      join(tmpdir(), "opencookie-findings-project-"),
    );
    const elsewhere = await mkdtemp(join(tmpdir(), "opencookie-findings-har-"));
    const har = join(elsewhere, "visit.har");
    await writeFile(har, JSON.stringify({ log: { entries: [] } }));
    const lines: string[] = [];
    try {
      const result = await runFindingsCommand(
        {
          fileSystem: createNodeCliPorts(project).fileSystem,
          writeLine: (line) => lines.push(line),
        },
        ["session", "--har", har],
      );

      expect(result.ok).toBe(false);
      const message = result.message ?? "";
      expect(message).toMatch(/outside the project/u);
      expect(message).not.toMatch(/could not be read/u);
    } finally {
      await rm(project, { force: true, recursive: true });
      await rm(elsewhere, { force: true, recursive: true });
    }
  });

  it("reports an empty inventory before anything is imported", async () => {
    const test = harness();

    const result = await runFindingsCommand(test.ports, ["list"]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toContain("No findings");
  });

  it("refuses an option it does not know rather than ignoring it", async () => {
    const test = harness();

    const result = await runFindingsCommand(test.ports, ["list", "--all"]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/--all/u);
  });

  it("imports observations and lists them as unclassified", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });

    const imported = await runFindingsCommand(test.ports, [
      "import",
      "--from",
      OBSERVATIONS,
    ]);
    const listed = await runFindingsCommand(test.ports, ["list"]);

    expect(imported.ok).toBe(true);
    expect(listed.ok).toBe(true);
    expect(test.files.has(INVENTORY)).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("_ga");
    expect(output).toContain("unclassified");
  });

  // The count after an import is what still needs a decision, not the
  // inventory's size: an import that adds nothing to a fully classified
  // inventory leaves nothing unclassified.
  it("reports what is new and what is still unclassified after an import", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });

    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);
    expect(test.lines.at(-1)).toBe(
      "Imported 2 observation(s): 2 new finding(s); 2 of 2 finding(s) unclassified.",
    );
    for (const [kind, name] of [
      ["cookie", "_ga"],
      ["script", "https://cdn.example.test/tag.js"],
    ] as const) {
      const classified = await runFindingsCommand(test.ports, [
        "classify",
        "--kind",
        kind,
        "--name",
        name,
        "--purpose",
        "analytics",
        ...DECISION_FLAGS,
      ]);
      if (!classified.ok) throw new Error(classified.message);
    }

    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    expect(test.lines.at(-1)).toBe(
      "Imported 2 observation(s): 0 new finding(s); 0 of 2 finding(s) unclassified.",
    );
  });

  it("shows provenance and uncertainty for every finding", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    await runFindingsCommand(test.ports, ["list"]);

    const output = test.lines.join("\n");
    expect(output).toContain("chromium-141");
    expect(output).toContain("page-load");
    expect(output).toContain("uncertain");
  });

  it("refuses a malformed observation document and writes nothing", async () => {
    const test = harness({ [OBSERVATIONS]: "{not json" });

    const result = await runFindingsCommand(test.ports, [
      "import",
      "--from",
      OBSERVATIONS,
    ]);

    expect(result.ok).toBe(false);
    expect(test.files.has(INVENTORY)).toBe(false);
  });

  it("rejects an unknown findings subcommand", async () => {
    const test = harness();

    const result = await runFindingsCommand(test.ports, [
      "classify-everything",
    ]);

    expect(result.ok).toBe(false);
  });
});

describe("findings classify command", () => {
  it("classifies an imported finding and shows the decision when listing", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    const classified = await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);
    test.lines.length = 0;
    await runFindingsCommand(test.ports, ["list"]);

    expect(classified.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("analytics");
    expect(output).toContain("classified");
  });

  it("refuses to classify a finding that was never observed", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    const result = await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_unseen",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);

    expect(result.ok).toBe(false);
  });

  it("requires kind, name and purpose", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    const result = await runFindingsCommand(test.ports, [
      "classify",
      "--name",
      "_ga",
    ]);

    expect(result.ok).toBe(false);
  });
});

describe("findings list summary", () => {
  it("does not claim findings are unclassified once they are classified", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);
    await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);
    test.lines.length = 0;

    await runFindingsCommand(test.ports, ["list"]);

    const summary = test.lines[0] ?? "";
    expect(summary).toContain("1 classified");
    expect(summary).toContain("1 unclassified");
    expect(summary).not.toContain("none classified");
  });
});

describe("findings draft-policy command", () => {
  it("refuses to draft before anything is classified", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    const result = await runFindingsCommand(test.ports, ["draft-policy"]);

    expect(result.ok).toBe(false);
    expect(test.files.has("opencookie/policy-draft.json")).toBe(false);
  });

  it("writes a draft that is explicitly not publishable", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);
    await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);

    const result = await runFindingsCommand(test.ports, ["draft-policy"]);

    expect(result.ok).toBe(true);
    const written = test.files.get("opencookie/policy-draft.json");
    if (written === undefined) throw new Error("draft must be written");
    const draft = JSON.parse(written) as {
      publishable: boolean;
      purposes: { id: string; missing: string[] }[];
      excludedUnclassified: { name: string }[];
    };
    expect(draft.publishable).toBe(false);
    expect(draft.purposes[0]?.id).toBe("analytics");
    expect(draft.purposes[0]?.missing).toContain("label");
    expect(draft.purposes[0]?.missing).not.toContain("disclosure");
    expect(draft.excludedUnclassified).toHaveLength(1);
  });

  it("writes a draft at the project root without creating a directory", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);
    await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);
    const created: string[] = [];
    const ports = {
      ...test.ports,
      fileSystem: {
        ...test.ports.fileSystem,
        mkdir: (path: string) => {
          created.push(path);
          return test.ports.fileSystem.mkdir(path);
        },
      },
    };

    const result = await runFindingsCommand(ports, [
      "draft-policy",
      "--out",
      "draft.json",
    ]);

    expect(result.ok).toBe(true);
    expect(created).not.toContain("draft.jso");
  });

  it("refuses to replace a file that is not a policy draft", async () => {
    const test = harness({
      [OBSERVATIONS]: observationsDocument(),
      "package.json": '{ "name": "site" }\n',
    });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);
    await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);

    const result = await runFindingsCommand(test.ports, [
      "draft-policy",
      "--out",
      "package.json",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("package.json");
    expect(test.files.get("package.json")).toBe('{ "name": "site" }\n');
  });

  it("shows the vendor, service, retention and cleanup when listing", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);
    await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);
    test.lines.length = 0;

    await runFindingsCommand(test.ports, ["list"]);

    const output = test.lines.join("\n");
    expect(output).toContain("google-llc");
    expect(output).toContain("google-analytics");
    expect(output).toContain("thirteen-months");
    expect(output).toContain("reblocked");
  });

  // A decision missing any of these would leave a published declaration unable
  // to say who receives the data or for how long it is kept.
  it("names every part of a decision it still needs", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    const result = await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("--vendor");
    expect(result.message).toContain("--service");
    expect(result.message).toContain("--category");
    expect(result.message).toContain("--disclosure");
    expect(result.message).toContain("--retention");
    expect(result.message).toContain("--cleanup");
  });

  it("refuses a cleanup behavior the runtime does not have", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);

    const result = await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      "--vendor",
      "google-llc",
      "--service",
      "google-analytics",
      "--category",
      "usage-data",
      "--disclosure",
      "Counts visits.",
      "--retention",
      "thirteen-months",
      "--cleanup",
      "erased-everywhere",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("erased-everywhere");
  });

  // A decision stored before it carried a vendor, a retention or a cleanup
  // behavior would otherwise be listed with those parts blank, and drafted into
  // a policy as if they had been decided.
  it("refuses an inventory whose decision is missing its parts", async () => {
    const incomplete = JSON.stringify({
      findings: [
        {
          classification: "classified",
          decision: {
            decidedAt: "2026-09-21T12:00:00.000Z",
            necessary: false,
            purposeId: "analytics",
          },
          kind: "cookie",
          name: "_ga",
          observations: [
            {
              browser: "chromium-141",
              observedAt: "2026-09-21T10:00:00.000Z",
              source: "https://example.test/",
              trigger: "page-load",
            },
          ],
          uncertainty: "observed",
        },
      ],
    });
    const test = harness({ [INVENTORY]: incomplete });

    const listed = await runFindingsCommand(test.ports, ["list"]);

    expect(listed.ok).toBe(false);
    expect(test.files.get(INVENTORY)).toBe(incomplete);
  });

  // The summary and the file it just wrote must agree, or an operator is told
  // to supply what they already decided.
  it("summarises the parts the draft actually still needs", async () => {
    const test = harness({ [OBSERVATIONS]: observationsDocument() });
    await runFindingsCommand(test.ports, ["import", "--from", OBSERVATIONS]);
    await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "cookie",
      "--name",
      "_ga",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);
    test.lines.length = 0;

    await runFindingsCommand(test.ports, ["draft-policy"]);

    const output = test.lines.join("\n");
    expect(output).toContain("label");
    expect(output).toContain("operationIds");
    expect(output).not.toContain("retentionIds");
    expect(output).not.toContain("providerIds");
  });
});

describe("importing a recorded session", () => {
  const HAR = "session.har";
  const recording = JSON.stringify({
    log: {
      browser: { name: "Safari", version: "26.0" },
      entries: [
        {
          pageref: "page_1",
          request: { method: "GET", url: "https://cdn.tracker.test/tag.js" },
          response: {
            content: { mimeType: "application/javascript" },
            cookies: [{ domain: ".tracker.test", name: "_tr", value: "1" }],
            status: 200,
          },
          startedDateTime: "2026-09-21T10:00:01.000Z",
        },
      ],
      pages: [{ id: "page_1", title: "https://shop.example.test/" }],
      version: "1.2",
    },
  });

  it("records what a session actually loaded and set", async () => {
    const test = harness({ [HAR]: recording });

    const result = await runFindingsCommand(test.ports, [
      "session",
      "--har",
      HAR,
    ]);
    test.lines.length = 0;
    await runFindingsCommand(test.ports, ["list"]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("https://cdn.tracker.test/tag.js");
    expect(output).toContain("_tr");
    expect(output).toContain("observed");
    expect(output).toContain("Safari 26.0");
  });

  // A recording never carries Web Storage, because those writes never reach the
  // network, so the command says so rather than letting silence imply there
  // were none.
  it("says what a recording cannot show", async () => {
    const test = harness({ [HAR]: recording });

    await runFindingsCommand(test.ports, ["session", "--har", HAR]);

    expect(test.lines.join("\n")).toMatch(/storage/iu);
  });

  // WebKit's recorder splits a Set-Cookie header at the comma in its Expires
  // date. The fragment is no cookie, so it is named rather than imported.
  it("names a cookie entry that is not a cookie name instead of importing it", async () => {
    const split = JSON.parse(recording) as {
      log: { entries: { response: { cookies: object[] } }[] };
    };
    split.log.entries[0]?.response.cookies.push({
      name: "21 Oct 2027 07:28:00 GMT",
      value: "",
    });
    const test = harness({ [HAR]: JSON.stringify(split) });

    const result = await runFindingsCommand(test.ports, [
      "session",
      "--har",
      HAR,
    ]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toMatch(
      /skipped "21 Oct 2027 07:28:00 GMT": not a cookie name/u,
    );
    expect(test.files.get(INVENTORY)).not.toContain("21 Oct 2027");
    expect(test.files.get(INVENTORY)).toContain("_tr");
  });

  it("refuses a file that is not a recording and imports nothing", async () => {
    const test = harness({ [HAR]: "{ not json" });

    const result = await runFindingsCommand(test.ports, [
      "session",
      "--har",
      HAR,
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/recording/iu);
    expect(test.files.has(INVENTORY)).toBe(false);
  });

  it("requires the recording", async () => {
    const test = harness();

    const result = await runFindingsCommand(test.ports, ["session"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("--har");
  });
});

describe("checking what a rejected session still loaded", () => {
  const REJECTED = "rejected.har";

  function recordingOf(urls: readonly string[]): string {
    return JSON.stringify({
      log: {
        browser: { name: "Safari", version: "26.0" },
        entries: urls.map((url) => ({
          pageref: "page_1",
          request: { method: "GET", url },
          response: {
            content: { mimeType: "application/javascript" },
            cookies: [],
            status: 200,
          },
          startedDateTime: "2026-09-21T10:00:01.000Z",
        })),
        pages: [{ id: "page_1", title: "https://shop.example.test/" }],
        version: "1.2",
      },
    });
  }

  async function classified(
    test: ReturnType<typeof harness>,
    url: string,
    necessary: boolean,
  ): Promise<void> {
    await runFindingsCommand(test.ports, ["session", "--har", REJECTED]);
    const args = [
      "classify",
      "--kind",
      "script",
      "--name",
      url,
      "--purpose",
      necessary ? "strictly-necessary" : "analytics",
      ...DECISION_FLAGS,
    ];
    if (necessary) args.push("--necessary");
    const result = await runFindingsCommand(test.ports, args);
    if (!result.ok) throw new Error(result.message);
  }

  // This is the check that says whether rejection actually worked: an optional
  // resource that still reached the network after a visitor rejected is a
  // failure of enforcement, not a finding to classify.
  it("fails when an optional resource loaded anyway", async () => {
    const url = "https://cdn.tracker.test/tag.js";
    const test = harness({ [REJECTED]: recordingOf([url]) });
    await classified(test, url, false);
    test.lines.length = 0;

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      REJECTED,
    ]);

    expect(result.ok).toBe(false);
    expect(test.lines.join("\n")).toContain(url);
  });

  // The kind of a loaded resource is read from its MIME type, which a tracker
  // can omit or disguise. A URL classified as optional is the same resource
  // whatever type it arrived with, so loading it after rejection still fails.
  it.each(["application/octet-stream", undefined])(
    "fails when a classified tracker loads after rejection as %s",
    async (mimeType) => {
      const url = "https://cdn.tracker.test/tag.js";
      const test = harness({ [REJECTED]: recordingOf([url]) });
      await classified(test, url, false);
      const disguised = JSON.parse(recordingOf([url])) as {
        log: { entries: { response: { content: { mimeType?: string } } }[] };
      };
      for (const entry of disguised.log.entries) {
        if (mimeType === undefined) delete entry.response.content.mimeType;
        else entry.response.content.mimeType = mimeType;
      }
      test.files.set("disguised.har", JSON.stringify(disguised));
      test.lines.length = 0;

      const result = await runFindingsCommand(test.ports, [
        "check",
        "--har",
        "disguised.har",
      ]);

      expect(result.ok).toBe(false);
      expect(test.lines.join("\n")).toContain(`loaded after rejection`);
    },
  );

  it("passes when only a necessary resource loaded", async () => {
    const url = "https://shop.example.test/session.js";
    const test = harness({ [REJECTED]: recordingOf([url]) });
    await classified(test, url, true);
    test.lines.length = 0;

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      REJECTED,
    ]);

    expect(result.ok).toBe(true);
  });

  // A site's own requests are left out by default, which hid a first-party
  // proxy relaying a vendor's events. Imported with --same-origin, the relay
  // can be decided, and the check then catches it after rejection; an
  // undecided same-origin request, such as the site's own API, still passes.
  describe("a first-party relay", () => {
    const RELAY = "https://shop.example.test/relay/e/";
    const recording = (url: string) =>
      JSON.stringify({
        log: {
          browser: { name: "Safari", version: "26.0" },
          entries: [
            {
              pageref: "page_1",
              request: { method: "POST", url },
              response: {
                content: { mimeType: "application/json" },
                cookies: [],
                status: 200,
              },
              startedDateTime: "2026-09-21T10:00:01.000Z",
            },
          ],
          pages: [{ id: "page_1", title: "https://shop.example.test/" }],
          version: "1.2",
        },
      });

    it("is imported with --same-origin so it can be decided", async () => {
      const test = harness({ [REJECTED]: recording(RELAY) });

      const result = await runFindingsCommand(test.ports, [
        "session",
        "--har",
        REJECTED,
        "--same-origin",
      ]);

      expect(result.ok).toBe(true);
      expect(test.files.get(INVENTORY)).toContain(RELAY);
    });

    it("fails the check once decided optional and seen after rejection", async () => {
      const test = harness({ [REJECTED]: recording(RELAY) });
      await runFindingsCommand(test.ports, [
        "session",
        "--har",
        REJECTED,
        "--same-origin",
      ]);
      const classified = await runFindingsCommand(test.ports, [
        "classify",
        "--kind",
        "network-destination",
        "--name",
        RELAY,
        "--purpose",
        "analytics",
        ...DECISION_FLAGS,
      ]);
      if (!classified.ok) throw new Error(classified.message);
      test.lines.length = 0;

      const result = await runFindingsCommand(test.ports, [
        "check",
        "--har",
        REJECTED,
      ]);

      expect(result.ok).toBe(false);
      expect(test.lines.join("\n")).toContain(
        `loaded after rejection: network-destination ${RELAY}`,
      );
    });

    it("leaves an undecided same-origin request out of the check", async () => {
      const test = harness({
        [REJECTED]: recording("https://shop.example.test/api/cart"),
      });

      const result = await runFindingsCommand(test.ports, [
        "check",
        "--har",
        REJECTED,
      ]);

      expect(result.ok).toBe(true);
    });
  });

  it("does not count a split cookie header as a resource", async () => {
    const url = "https://shop.example.test/session.js";
    const split = JSON.parse(recordingOf([url])) as {
      log: { entries: { response: { cookies: object[] } }[] };
    };
    split.log.entries[0]?.response.cookies.push({
      name: "21 Oct 2027 07:28:00 GMT",
      value: "",
    });
    const test = harness({ [REJECTED]: JSON.stringify(split) });
    await classified(test, url, true);
    test.lines.length = 0;

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      REJECTED,
    ]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).not.toContain("not decided");
    expect(output).toMatch(
      /skipped "21 Oct 2027 07:28:00 GMT": not a cookie name/u,
    );
  });

  // A release gate has to fail closed. A resource nobody has classified may be
  // a vendor added since the last review, so the recording cannot show that
  // rejection worked until it is decided, whichever way.
  it("fails when a resource nobody has decided about loaded", async () => {
    const test = harness({
      [REJECTED]: recordingOf(["https://cdn.unknown.test/x.js"]),
    });

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      REJECTED,
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/1 resource had no decision.*Classify/u);
    expect(test.lines.join("\n")).toContain(
      "not decided: script https://cdn.unknown.test/x.js",
    );
  });

  it("names the enforcement failure first when both kinds occur", async () => {
    const url = "https://cdn.tracker.test/tag.js";
    const test = harness({
      [REJECTED]: recordingOf([url, "https://cdn.unknown.test/x.js"]),
    });
    await classified(test, url, false);

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      REJECTED,
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(
      /^1 optional resource loaded although the visitor rejected.*1 resource had no decision/u,
    );
  });

  it("requires the recording", async () => {
    const test = harness();

    const result = await runFindingsCommand(test.ports, ["check"]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("--har");
  });
});

describe("matching a recording against decisions", () => {
  const REJECTED = "rejected.har";

  function recordingOf(urls: readonly string[]): string {
    return JSON.stringify({
      log: {
        browser: { name: "Safari", version: "26.0" },
        entries: urls.map((url) => ({
          pageref: "page_1",
          request: { method: "GET", url },
          response: {
            content: { mimeType: "application/javascript" },
            cookies: [],
            status: 200,
          },
          startedDateTime: "2026-09-21T10:00:01.000Z",
        })),
        pages: [{ id: "page_1", title: "https://shop.example.test/" }],
        version: "1.2",
      },
    });
  }

  // Tags are routinely cache-busted. Matching the whole address would report
  // every visit as undecided and make the check useless on a real site.
  it("matches a decided resource whose query string changed", async () => {
    const test = harness({
      [REJECTED]: recordingOf(["https://cdn.tracker.test/tag.js?v=1"]),
    });
    await runFindingsCommand(test.ports, ["session", "--har", REJECTED]);
    const classified = await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "script",
      "--name",
      "https://cdn.tracker.test/tag.js?v=1",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);
    if (!classified.ok) throw new Error(classified.message);
    test.files.set(
      "later.har",
      recordingOf(["https://cdn.tracker.test/tag.js?v=2"]),
    );
    test.lines.length = 0;

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      "later.har",
    ]);

    expect(result.ok).toBe(false);
    expect(test.lines.join("\n")).toContain("loaded after rejection");
    expect(test.lines.join("\n")).not.toContain("not decided");
  });

  // Some loaders carry a cache-busting segment in the path itself, so neither
  // the address nor the path matched and each visit was "not decided". The
  // operator declares the varying segment with * when deciding.
  const LOADER = "https://chat.example.test/include/1727300000/loader.js";
  const classifyLoader = (test: Harness, match: string) =>
    runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "script",
      "--name",
      LOADER,
      "--purpose",
      "support-chat",
      "--match",
      match,
      ...DECISION_FLAGS,
    ]);

  it("matches a changed path segment through the decision's declared pattern", async () => {
    const test = harness({ [REJECTED]: recordingOf([LOADER]) });
    await runFindingsCommand(test.ports, ["session", "--har", REJECTED]);
    const classified = await classifyLoader(
      test,
      "https://chat.example.test/include/*/loader.js",
    );
    if (!classified.ok) throw new Error(classified.message);
    test.files.set(
      "later.har",
      recordingOf(["https://chat.example.test/include/1727300300/loader.js"]),
    );
    test.lines.length = 0;

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      "later.har",
    ]);

    expect(result.ok).toBe(false);
    expect(test.lines.join("\n")).toContain("loaded after rejection");
    expect(test.lines.join("\n")).not.toContain("not decided");
  });

  it("refuses a pattern that does not match the finding it decides", async () => {
    const test = harness({ [REJECTED]: recordingOf([LOADER]) });
    await runFindingsCommand(test.ports, ["session", "--har", REJECTED]);

    const result = await classifyLoader(
      test,
      "https://chat.example.test/embed/*/loader.js",
    );

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/pattern/u);
  });

  it.each([
    "https://*.example.test/include/*/loader.js",
    "https://chat.example.test/*/*/*",
    "chat.example.test/include/*/loader.js",
  ])("refuses the pattern %s", async (match) => {
    const test = harness({ [REJECTED]: recordingOf([LOADER]) });
    await runFindingsCommand(test.ports, ["session", "--har", REJECTED]);

    const result = await classifyLoader(test, match);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/pattern/u);
  });

  // A different path is a different resource, whatever the origin.
  it("does not match a different path on the same origin", async () => {
    const test = harness({
      [REJECTED]: recordingOf(["https://cdn.tracker.test/tag.js"]),
    });
    await runFindingsCommand(test.ports, ["session", "--har", REJECTED]);
    await runFindingsCommand(test.ports, [
      "classify",
      "--kind",
      "script",
      "--name",
      "https://cdn.tracker.test/tag.js",
      "--purpose",
      "analytics",
      ...DECISION_FLAGS,
    ]);
    test.files.set(
      "other.har",
      recordingOf(["https://cdn.tracker.test/other.js"]),
    );
    test.lines.length = 0;

    const result = await runFindingsCommand(test.ports, [
      "check",
      "--har",
      "other.har",
    ]);

    expect(result.ok).toBe(false);
    expect(test.lines.join("\n")).toContain("not decided");
  });
});

describe("importing what the browser stored", () => {
  const SNAPSHOT = "storage.json";
  const document = JSON.stringify({
    local: ["_ga"],
    page: "https://shop.example.test/",
    recordedAt: "2026-09-21T10:00:00.000Z",
    session: ["step"],
  });

  it("records the keys as observed findings in the named browser", async () => {
    const test = harness({ [SNAPSHOT]: document });

    const result = await runFindingsCommand(test.ports, [
      "storage",
      "--from",
      SNAPSHOT,
      "--browser",
      "Safari 26.0",
    ]);
    test.lines.length = 0;
    await runFindingsCommand(test.ports, ["list"]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("local:_ga");
    expect(output).toContain("session:step");
    expect(output).toContain("Safari 26.0");
  });

  it("requires the browser the snapshot was taken in", async () => {
    const test = harness({ [SNAPSHOT]: document });

    const result = await runFindingsCommand(test.ports, [
      "storage",
      "--from",
      SNAPSHOT,
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("--browser");
    expect(test.files.has(INVENTORY)).toBe(false);
  });

  it("refuses a file that is not a snapshot and imports nothing", async () => {
    const test = harness({ [SNAPSHOT]: "{ broken" });

    const result = await runFindingsCommand(test.ports, [
      "storage",
      "--from",
      SNAPSHOT,
      "--browser",
      "Safari 26.0",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Web Storage snapshot/u);
    expect(test.files.has(INVENTORY)).toBe(false);
  });
});

describe("naming the browser of a recording", () => {
  const HAR = "devtools.har";
  const withoutBrowser = JSON.stringify({
    log: {
      entries: [
        {
          pageref: "page_1",
          request: { method: "GET", url: "https://cdn.tracker.test/tag.js" },
          response: {
            content: { mimeType: "application/javascript" },
            cookies: [],
            status: 200,
          },
          startedDateTime: "2026-09-21T10:00:01.000Z",
        },
      ],
      pages: [{ id: "page_1", title: "https://shop.example.test/" }],
      version: "1.2",
    },
  });

  it("uses the browser the operator names when the file does not", async () => {
    const test = harness({ [HAR]: withoutBrowser });

    await runFindingsCommand(test.ports, [
      "session",
      "--har",
      HAR,
      "--browser",
      "Safari 26.0",
    ]);
    test.lines.length = 0;
    await runFindingsCommand(test.ports, ["list"]);

    expect(test.lines.join("\n")).toContain("Safari 26.0");
  });

  it("refuses to relabel a recording that names its own browser", async () => {
    const test = harness({
      [HAR]: JSON.stringify({
        ...(JSON.parse(withoutBrowser) as { log: Record<string, unknown> }),
        log: {
          ...(JSON.parse(withoutBrowser) as { log: Record<string, unknown> })
            .log,
          browser: { name: "chromium", version: "151" },
        },
      }),
    });

    const result = await runFindingsCommand(test.ports, [
      "session",
      "--har",
      HAR,
      "--browser",
      "Safari 26.0",
    ]);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("chromium 151");
    expect(test.files.has(INVENTORY)).toBe(false);
  });
});
