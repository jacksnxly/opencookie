import { describe, expect, it } from "vitest";

import {
  EVIDENCE_STORE_PATH,
  runEvidenceCommand,
  type FileSystemPort,
} from "./index.js";

const DAY = 86_400_000;
// Far enough from the epoch that a receipt 400 days old is still a valid
// non-negative timestamp.
const NOW = 1_000 * DAY;

function receipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    catalogueDigest: "sha256-catalogue",
    consentId: "visitor-1",
    decidedAt: NOW - DAY,
    decisionSurfaceDigest: "sha256-surface",
    decisions: [{ decision: "granted", purposeId: "analytics" }],
    idempotencyKey: "key-1",
    method: "accept-all",
    occurredAt: NOW - DAY,
    persistenceStatus: "confirmed",
    policyVersion: "1.0.0",
    revision: 1,
    schemaVersion: 2,
    transitionId: "transition-1",
    ...overrides,
  };
}

function harness(initial: Readonly<Record<string, string>> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const modes = new Map<string, number | undefined>();
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
      if (files.get(path) !== previous)
        throw new Error(`Stale replace of ${path}`);
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (_path, operation) => operation(),
    writeFile: (path, content, options) => {
      if (files.has(path)) throw new Error(`EEXIST: ${path}`);
      files.set(path, content);
      modes.set(path, options?.mode);
      return Promise.resolve();
    },
  };
  return {
    files,
    lines,
    modes,
    ports: {
      fileSystem,
      now: () => NOW,
      writeLine: (line: string) => lines.push(line),
    },
  };
}

const stored = (files: Map<string, string>) =>
  (
    JSON.parse(files.get(EVIDENCE_STORE_PATH) ?? "{}") as {
      receipts?: unknown[];
    }
  ).receipts ?? [];

describe("opencookie evidence", () => {
  it("ingests receipts into an owner-only store", async () => {
    const test = harness({ "in.json": JSON.stringify([receipt()]) });

    const result = await runEvidenceCommand(test.ports, [
      "ingest",
      "--from",
      "in.json",
    ]);

    expect(result.ok).toBe(true);
    expect(stored(test.files)).toHaveLength(1);
    expect(test.modes.get(EVIDENCE_STORE_PATH)).toBe(0o600);
  });

  it("refuses a malformed batch and writes nothing", async () => {
    const test = harness({
      "in.json": JSON.stringify([
        receipt(),
        receipt({ idempotencyKey: "k2", schemaVersion: 9 }),
      ]),
    });

    const result = await runEvidenceCommand(test.ports, [
      "ingest",
      "--from",
      "in.json",
    ]);

    expect(result.ok).toBe(false);
    expect(test.files.has(EVIDENCE_STORE_PATH)).toBe(false);
  });

  it("queries one visitor's evidence", async () => {
    const test = harness({
      "in.json": JSON.stringify([
        receipt(),
        receipt({
          consentId: "visitor-2",
          idempotencyKey: "k2",
          transitionId: "t2",
        }),
      ]),
    });
    await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);
    test.lines.length = 0;

    const result = await runEvidenceCommand(test.ports, [
      "query",
      "--consent-id",
      "visitor-1",
    ]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toContain("1 receipt");
    expect(test.lines.join("\n")).toContain("transition-1");
    expect(test.lines.join("\n")).not.toContain("t2");
  });

  // The bounds are documented as inclusive. Pass B's minor 3 on 0.2.0: a
  // date-only --until was read as that day's midnight, so the same date for
  // both bounds matched nothing decided later that day.
  it("reads a date-only --until as the end of that day", async () => {
    const day = new Date(NOW - DAY).toISOString().slice(0, 10);
    const test = harness({
      "in.json": JSON.stringify([receipt({ decidedAt: NOW - DAY / 2 })]),
    });
    await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);

    const result = await runEvidenceCommand(test.ports, [
      "query",
      "--since",
      day,
      "--until",
      day,
    ]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toContain("visitor-1");
  });

  // Pass B's minor 2 on 0.2.0: a plain-HTML site is served from its project
  // directory, so the evidence store and its exports under opencookie/ were
  // public. Receipts are personal data; they must not be written there.
  it("refuses to write evidence into a plain-HTML site's web root", async () => {
    const test = harness({
      "in.json": JSON.stringify([receipt()]),
      "index.html":
        '<!doctype html><html><body><script src="https://cdn.jsdelivr.net/npm/@opencookie-dev/vanilla@0.2.0/dist/auto.iife.js"></script></body></html>',
    });

    const ingested = await runEvidenceCommand(test.ports, [
      "ingest",
      "--from",
      "in.json",
    ]);
    const exported = await runEvidenceCommand(test.ports, [
      "export",
      "--out",
      "opencookie/export.json",
    ]);

    expect(ingested.ok).toBe(false);
    expect(ingested.message).toMatch(/--cwd/u);
    expect(test.files.has(EVIDENCE_STORE_PATH)).toBe(false);
    expect(exported.ok).toBe(false);
    expect(test.files.has("opencookie/export.json")).toBe(false);
  });

  it("exports matching evidence to an owner-only file", async () => {
    const test = harness({ "in.json": JSON.stringify([receipt()]) });
    await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);

    const result = await runEvidenceCommand(test.ports, [
      "export",
      "--consent-id",
      "visitor-1",
      "--out",
      "export.json",
    ]);

    expect(result.ok).toBe(true);
    expect(JSON.parse(test.files.get("export.json") ?? "[]")).toHaveLength(1);
    expect(test.modes.get("export.json")).toBe(0o600);
  });

  // A misspelt filter must never read as no filter. Pass B's M-D on 0.2.0:
  // `--consentId` was ignored, so a one-visitor export exported everyone and
  // an erasure deleted nothing while reporting success.
  it("refuses a misspelt filter rather than widening an export or an erasure", async () => {
    const test = harness({
      "in.json": JSON.stringify([
        receipt(),
        receipt({
          consentId: "visitor-2",
          idempotencyKey: "key-2",
          transitionId: "transition-2",
        }),
      ]),
    });
    await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);

    const exported = await runEvidenceCommand(test.ports, [
      "export",
      "--consentId",
      "visitor-1",
      "--out",
      "export.json",
    ]);
    expect(exported.ok).toBe(false);
    expect(exported.message).toMatch(/--consentId/u);
    expect(test.files.has("export.json")).toBe(false);

    const erased = await runEvidenceCommand(test.ports, [
      "delete",
      "--consentid=visitor-1",
    ]);
    expect(erased.ok).toBe(false);
    expect(erased.message).toMatch(/--consentid/u);
    expect(stored(test.files)).toHaveLength(2);
  });

  // An export is a copy the store cannot reach. Erasure removes the visitor
  // from the store, so it must say which earlier exports still hold them.
  it("names the earlier exports that still hold an erased visitor", async () => {
    const test = harness({
      "in.json": JSON.stringify([
        receipt(),
        receipt({
          consentId: "visitor-2",
          idempotencyKey: "k2",
          transitionId: "t2",
        }),
      ]),
    });
    await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);
    for (const [id, out] of [
      ["visitor-1", "dsar-1.json"],
      ["visitor-2", "dsar-2.json"],
    ] as const) {
      await runEvidenceCommand(test.ports, [
        "export",
        "--consent-id",
        id,
        "--out",
        out,
      ]);
    }
    test.lines.length = 0;

    const result = await runEvidenceCommand(test.ports, [
      "delete",
      "--consent-id",
      "visitor-1",
    ]);

    expect(result.ok).toBe(true);
    const output = test.lines.join("\n");
    expect(output).toContain("dsar-1.json");
    expect(output).not.toContain("dsar-2.json");
  });

  describe("a consent id that begins with a hyphen", () => {
    // A visitor can choose their consent id wherever receipts come from the
    // browser, so a filter value must never be mistaken for a missing flag:
    // a filter that silently disappears exports everyone.
    const twoVisitors = () =>
      harness({
        "in.json": JSON.stringify([
          receipt({ consentId: "-dashvisitor" }),
          receipt({
            consentId: "visitor-2",
            idempotencyKey: "k2",
            transitionId: "t2",
          }),
        ]),
      });

    it("exports only that visitor's receipts", async () => {
      const test = twoVisitors();
      await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);

      const result = await runEvidenceCommand(test.ports, [
        "export",
        "--consent-id",
        "-dashvisitor",
        "--out",
        "export.json",
      ]);

      expect(result.ok).toBe(true);
      const exported = JSON.parse(test.files.get("export.json") ?? "[]") as {
        consentId: string;
      }[];
      expect(exported.map(({ consentId }) => consentId)).toEqual([
        "-dashvisitor",
      ]);
    });

    it("reads the value written as --consent-id=value", async () => {
      const test = twoVisitors();
      await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);

      const result = await runEvidenceCommand(test.ports, [
        "export",
        "--consent-id=-dashvisitor",
        "--out",
        "export.json",
      ]);

      expect(result.ok).toBe(true);
      expect(JSON.parse(test.files.get("export.json") ?? "[]")).toHaveLength(1);
    });

    it("erases that visitor", async () => {
      const test = twoVisitors();
      await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);

      const result = await runEvidenceCommand(test.ports, [
        "delete",
        "--consent-id",
        "-dashvisitor",
      ]);

      expect(result.ok).toBe(true);
      expect(stored(test.files)).toHaveLength(1);
    });

    it("refuses a filter flag given without a value instead of exporting everyone", async () => {
      const test = twoVisitors();
      await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);

      const result = await runEvidenceCommand(test.ports, [
        "export",
        "--out",
        "export.json",
        "--consent-id",
      ]);

      expect(result).toStrictEqual({
        message: "--consent-id requires a value.",
        ok: false,
      });
      expect(test.files.has("export.json")).toBe(false);
    });
  });

  it("erases one visitor and reports how much", async () => {
    const test = harness({
      "in.json": JSON.stringify([
        receipt(),
        receipt({
          consentId: "visitor-2",
          idempotencyKey: "k2",
          transitionId: "t2",
        }),
      ]),
    });
    await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);
    test.lines.length = 0;

    const result = await runEvidenceCommand(test.ports, [
      "delete",
      "--consent-id",
      "visitor-1",
    ]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toContain("Deleted 1");
    expect(stored(test.files)).toHaveLength(1);
  });

  // Pass B's nit 2 on 0.2.0: retain removed old receipts from the store but,
  // unlike delete, never said which earlier exports still held them.
  it("names the earlier exports that still hold receipts retention removed", async () => {
    const test = harness({
      "in.json": JSON.stringify([
        receipt({ decidedAt: NOW - 400 * DAY, occurredAt: NOW - 400 * DAY }),
      ]),
    });
    await runEvidenceCommand(test.ports, ["ingest", "--from", "in.json"]);
    await runEvidenceCommand(test.ports, ["export", "--out", "old.json"]);
    test.lines.length = 0;

    const result = await runEvidenceCommand(test.ports, [
      "retain",
      "--days",
      "365",
    ]);

    expect(result.ok).toBe(true);
    expect(test.lines.join("\n")).toMatch(
      /Earlier exports still hold[^\n]*old\.json/u,
    );
  });

  it("applies a retention period in days", async () => {
    const test = harness({
      "in.json": JSON.stringify([
        receipt({ decidedAt: NOW - 400 * DAY, occurredAt: NOW - 400 * DAY }),
        receipt({
          decidedAt: NOW - DAY,
          idempotencyKey: "k2",
          occurredAt: NOW - DAY,
          transitionId: "t2",
        }),
      ]),
    });
    const ingest = await runEvidenceCommand(test.ports, [
      "ingest",
      "--from",
      "in.json",
    ]);
    expect(ingest.ok).toBe(true);
    expect(stored(test.files)).toHaveLength(2);

    const result = await runEvidenceCommand(test.ports, [
      "retain",
      "--days",
      "365",
    ]);

    expect(result.ok).toBe(true);
    expect(stored(test.files)).toHaveLength(1);
  });

  it("refuses to touch a store that fails validation", async () => {
    const tampered = JSON.stringify({
      receipts: [{ tampered: true }],
      version: 1,
    });
    const test = harness({ [EVIDENCE_STORE_PATH]: tampered });

    const result = await runEvidenceCommand(test.ports, [
      "delete",
      "--consent-id",
      "visitor-1",
    ]);

    expect(result.ok).toBe(false);
    expect(test.files.get(EVIDENCE_STORE_PATH)).toBe(tampered);
  });
});
