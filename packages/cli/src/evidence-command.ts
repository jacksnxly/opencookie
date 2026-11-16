import type { ConsentReceipt } from "@opencookie-dev/core";

import type { FileSystemPort } from "./contracts.js";
import {
  applyEvidenceRetention,
  deleteEvidenceForConsent,
  emptyEvidenceLog,
  ingestReceipts,
  queryEvidence,
  type EvidenceLog,
  type EvidenceQuery,
} from "./evidence-log.js";
import { readFlag, refusingMissingFlagValues } from "./flags.js";
import { servesProjectDirectory } from "./plain-html-page.js";

/** Where an operator's durable consent evidence is kept. @public */
export const EVIDENCE_STORE_PATH = "opencookie/consent-evidence.json";

/** Where exports are listed, so erasure can find copies it cannot reach. */
const EXPORT_LEDGER_PATH = "opencookie/evidence-exports.json";

/** How an erasure begins the line naming exports that still hold the visitor. @internal */
export const EXPORT_COPIES_NOTICE = "Earlier exports still hold";

async function recordExport(
  fileSystem: FileSystemPort,
  out: string,
): Promise<void> {
  let previous: string | undefined;
  let paths: string[] = [];
  if (await fileSystem.exists(EXPORT_LEDGER_PATH)) {
    previous = await fileSystem.readFile(EXPORT_LEDGER_PATH);
    try {
      const parsed: unknown = JSON.parse(previous);
      if (Array.isArray(parsed)) {
        paths = parsed.filter(
          (path): path is string => typeof path === "string",
        );
      }
    } catch {
      // An unreadable ledger is replaced by one that lists this export.
    }
  }
  if (paths.includes(out)) return;
  const next = `${JSON.stringify([...paths, out], null, 2)}\n`;
  if (previous === undefined) {
    await fileSystem.writeFile(EXPORT_LEDGER_PATH, next, {
      mode: PRIVATE_MODE,
    });
  } else {
    await fileSystem.replaceFile(EXPORT_LEDGER_PATH, previous, next);
  }
}

/** The recorded exports that still hold a receipt `held` picks out. */
async function exportsHolding(
  fileSystem: FileSystemPort,
  held: (receipt: { consentId?: unknown; decidedAt?: unknown }) => boolean,
): Promise<readonly string[]> {
  if (!(await fileSystem.exists(EXPORT_LEDGER_PATH))) return [];
  let paths: unknown;
  try {
    paths = JSON.parse(await fileSystem.readFile(EXPORT_LEDGER_PATH));
  } catch {
    return [];
  }
  if (!Array.isArray(paths)) return [];
  const holding: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || !(await fileSystem.exists(path))) continue;
    try {
      const exported: unknown = JSON.parse(await fileSystem.readFile(path));
      if (
        Array.isArray(exported) &&
        exported.some(
          (receipt: unknown) =>
            typeof receipt === "object" && receipt !== null && held(receipt),
        )
      ) {
        holding.push(path);
      }
    } catch {
      // A file that no longer parses as an export is not reported as one.
    }
  }
  return holding;
}

const STORE_VERSION = 1;
/** Consent evidence is personal data: readable and writable by the owner only. */
const PRIVATE_MODE = 0o600;
const DAY_MS = 86_400_000;
const UNREADABLE = `${EVIDENCE_STORE_PATH} failed validation, so nothing was changed. Restore it from a backup rather than deleting it.`;

/** Ports the evidence command needs. @public */
export interface EvidenceCommandPorts {
  readonly fileSystem: FileSystemPort;
  readonly now: () => number;
  readonly writeLine: (line: string) => void;
}

/** @public */
export interface EvidenceCommandResult {
  readonly message?: string;
  readonly ok: boolean;
}

interface StoredEvidence {
  readonly log: EvidenceLog;
  readonly raw: string | undefined;
}

function failure(message: string): EvidenceCommandResult {
  return { message, ok: false };
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Accepts epoch milliseconds or an ISO 8601 date. */
function parseInstant(value: string): number | undefined {
  if (/^\d+$/u.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Reads the store, re-validating every receipt it holds.
 *
 * A store that fails validation is reported as unreadable rather than
 * returned, so tampered evidence can never be treated as the record, and it is
 * never overwritten.
 */
async function readStore(
  fileSystem: FileSystemPort,
): Promise<StoredEvidence | undefined> {
  if (!(await fileSystem.exists(EVIDENCE_STORE_PATH))) {
    return { log: emptyEvidenceLog(), raw: undefined };
  }
  const raw = await fileSystem.readFile(EVIDENCE_STORE_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const document = parsed as { receipts?: unknown; version?: unknown } | null;
  if (
    document === null ||
    typeof document !== "object" ||
    document.version !== STORE_VERSION ||
    !Array.isArray(document.receipts)
  ) {
    return undefined;
  }
  const validated = ingestReceipts(emptyEvidenceLog(), document.receipts);
  if (!validated.ok || validated.duplicates > 0) return undefined;
  return { log: validated.log, raw };
}

async function persist(
  fileSystem: FileSystemPort,
  previous: string | undefined,
  log: EvidenceLog,
): Promise<void> {
  const document = `${JSON.stringify({ receipts: log.receipts, version: STORE_VERSION }, null, 2)}\n`;
  if (previous === undefined) {
    await fileSystem.writeFile(EVIDENCE_STORE_PATH, document, {
      mode: PRIVATE_MODE,
    });
    return;
  }
  // replaceFile keeps the store's owner-only permissions.
  await fileSystem.replaceFile(EVIDENCE_STORE_PATH, previous, document);
}

async function underLock<Result>(
  fileSystem: FileSystemPort,
  operation: () => Promise<Result>,
): Promise<Result> {
  const parent = EVIDENCE_STORE_PATH.slice(
    0,
    EVIDENCE_STORE_PATH.lastIndexOf("/"),
  );
  await fileSystem.mkdir(parent);
  return fileSystem.withLock(`${EVIDENCE_STORE_PATH}.lock`, operation);
}

function describe(receipt: ConsentReceipt): string {
  return [
    receipt.transitionId,
    receipt.consentId ?? "(no consent id)",
    receipt.method,
    new Date(receipt.decidedAt).toISOString(),
    `policy ${receipt.policyVersion}`,
  ].join("  ");
}

function readQuery(
  args: readonly string[],
): EvidenceQuery | EvidenceCommandResult {
  const consentId = readFlag(args, "--consent-id");
  const sinceRaw = readFlag(args, "--since");
  const untilRaw = readFlag(args, "--until");
  const since = sinceRaw === undefined ? undefined : parseInstant(sinceRaw);
  // The bounds are inclusive, so a date-only --until ends with that day.
  const until =
    untilRaw === undefined
      ? undefined
      : /^\d{4}-\d{2}-\d{2}$/u.test(untilRaw)
        ? (parseInstant(untilRaw) ?? Number.NaN) + 86_399_999
        : parseInstant(untilRaw);
  if (sinceRaw !== undefined && since === undefined) {
    return failure(`--since ${sinceRaw} is not a date or epoch milliseconds.`);
  }
  if (untilRaw !== undefined && (until === undefined || Number.isNaN(until))) {
    return failure(`--until ${untilRaw} is not a date or epoch milliseconds.`);
  }
  return {
    ...(consentId === undefined ? {} : { consentId }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

function isResult(value: unknown): value is EvidenceCommandResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

/**
 * Runs `opencookie evidence <ingest|query|export|delete|retain>`.
 *
 * @public
 */
export function runEvidenceCommand(
  ports: EvidenceCommandPorts,
  args: readonly string[],
): Promise<EvidenceCommandResult> {
  return refusingMissingFlagValues(() => run(ports, args), failure, args, {
    delete: ["--consent-id"],
    export: ["--consent-id", "--since", "--until", "--out"],
    ingest: ["--from"],
    query: ["--consent-id", "--since", "--until"],
    retain: ["--days"],
  });
}

async function run(
  ports: EvidenceCommandPorts,
  args: readonly string[],
): Promise<EvidenceCommandResult> {
  const [subcommand] = args;
  const { fileSystem } = ports;

  // Receipts are personal data. A plain-HTML site is served from this very
  // directory, so a store or an export written here would be public.
  if (
    (subcommand === "ingest" || subcommand === "export") &&
    (await servesProjectDirectory(fileSystem))
  ) {
    return failure(
      "This directory is the site's web root, so consent evidence written here would be served to anyone. Keep OpenCookie's operator data outside it and run the evidence commands with --cwd <that directory>.",
    );
  }

  if (subcommand === "ingest") {
    const from = readFlag(args, "--from");
    if (from === undefined) return failure("ingest requires --from <file>.");
    let incoming: unknown;
    try {
      incoming = JSON.parse(await fileSystem.readFile(from));
    } catch {
      return failure(`${from} is not a readable JSON list of receipts.`);
    }
    if (!Array.isArray(incoming)) {
      return failure(`${from} must contain a JSON list of receipts.`);
    }
    return underLock(fileSystem, async () => {
      const stored = await readStore(fileSystem);
      if (stored === undefined) return failure(UNREADABLE);
      const result = ingestReceipts(stored.log, incoming);
      if (!result.ok) {
        return failure(
          result.issue.kind === "malformed-receipt"
            ? `Receipt ${String(result.issue.index + 1)} in ${from} is malformed, so nothing was ingested.`
            : `Idempotency key ${result.issue.idempotencyKey} is already stored with different content, so nothing was ingested.`,
        );
      }
      if (result.ingested > 0) {
        await persist(fileSystem, stored.raw, result.log);
      }
      ports.writeLine(
        `Ingested ${plural(result.ingested, "receipt")}; ${plural(result.duplicates, "duplicate")} skipped.`,
      );
      return { ok: true };
    });
  }

  if (subcommand === "query" || subcommand === "export") {
    const query = readQuery(args);
    if (isResult(query)) return query;
    const stored = await readStore(fileSystem);
    if (stored === undefined) return failure(UNREADABLE);
    const matching = queryEvidence(stored.log, query);
    if (subcommand === "query") {
      ports.writeLine(plural(matching.length, "receipt"));
      for (const receipt of matching) ports.writeLine(`  ${describe(receipt)}`);
      return { ok: true };
    }
    const out = readFlag(args, "--out");
    if (out === undefined) return failure("export requires --out <file>.");
    try {
      await fileSystem.writeFile(
        out,
        `${JSON.stringify(matching, null, 2)}\n`,
        {
          mode: PRIVATE_MODE,
        },
      );
    } catch {
      return failure(
        `${out} already exists or cannot be written, so nothing was exported.`,
      );
    }
    await recordExport(fileSystem, out);
    ports.writeLine(
      `Exported ${plural(matching.length, "receipt")} to ${out}.`,
    );
    return { ok: true };
  }

  if (subcommand === "delete") {
    const consentId = readFlag(args, "--consent-id");
    if (consentId === undefined) {
      return failure("delete requires --consent-id <id>.");
    }
    return underLock(fileSystem, async () => {
      const stored = await readStore(fileSystem);
      if (stored === undefined) return failure(UNREADABLE);
      const erased = deleteEvidenceForConsent(stored.log, consentId);
      if (erased.deleted > 0) {
        await persist(fileSystem, stored.raw, erased.log);
      }
      ports.writeLine(
        `Deleted ${plural(erased.deleted, "receipt")} for ${consentId}.`,
      );
      const copies = await exportsHolding(
        fileSystem,
        (receipt) => receipt.consentId === consentId,
      );
      if (copies.length > 0) {
        ports.writeLine(
          `${EXPORT_COPIES_NOTICE} ${consentId}'s receipts: ${copies.join(", ")}. Delete them too; erasing the store does not reach copies.`,
        );
      }
      return { ok: true };
    });
  }

  if (subcommand === "retain") {
    const daysRaw = readFlag(args, "--days");
    const days = daysRaw === undefined ? Number.NaN : Number(daysRaw);
    if (!Number.isSafeInteger(days) || days < 1) {
      return failure("retain requires --days <positive whole number>.");
    }
    const cutoff = ports.now() - days * DAY_MS;
    return underLock(fileSystem, async () => {
      const stored = await readStore(fileSystem);
      if (stored === undefined) return failure(UNREADABLE);
      const kept = applyEvidenceRetention(stored.log, cutoff);
      if (kept.removed > 0) {
        await persist(fileSystem, stored.raw, kept.log);
      }
      ports.writeLine(
        `Removed ${plural(kept.removed, "receipt")} decided before ${new Date(cutoff).toISOString()}.`,
      );
      const copies = await exportsHolding(
        fileSystem,
        (receipt) =>
          typeof receipt.decidedAt === "number" && receipt.decidedAt < cutoff,
      );
      if (copies.length > 0) {
        ports.writeLine(
          `${EXPORT_COPIES_NOTICE} receipts decided before ${new Date(cutoff).toISOString()}: ${copies.join(", ")}. Delete them too; retention in the store does not reach copies.`,
        );
      }
      return { ok: true };
    });
  }

  return failure(`Unknown evidence command: ${subcommand ?? ""}`.trim());
}
