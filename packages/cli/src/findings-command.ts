import type { FileSystemPort } from "./contracts.js";
import { draftPolicyFromFindings, type PolicyDraft } from "./policy-draft.js";
import {
  classifyFinding,
  decisionLookup,
  emptyFindingsInventory,
  FINDING_CLEANUPS,
  FINDING_KINDS,
  importObservedFindings,
  type Finding,
  type FindingCleanup,
  type FindingKind,
  type FindingsInventory,
} from "./findings.js";
import { scanHtml } from "./html-scan.js";
import { scanHar, type SessionScanObservation } from "./har-scan.js";
import { scanStorageSnapshot } from "./storage-scan.js";
import { readFlag, refusingMissingFlagValues } from "./flags.js";
import { parentDirectory, unreadablePathMessage } from "./project-paths.js";

/** Whether a file is a policy draft that draft-policy wrote. */
function isPolicyDraft(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as {
      publishable?: unknown;
      purposes?: unknown;
    } | null;
    return (
      typeof parsed?.publishable === "boolean" && Array.isArray(parsed.purposes)
    );
  } catch {
    return false;
  }
}

/** Where an operator's imported findings are kept, relative to the project. @public */
export const FINDINGS_INVENTORY_PATH = "opencookie/findings.json";

/** Default path for the generated policy draft. @public */
export const POLICY_DRAFT_PATH = "opencookie/policy-draft.json";

/** Ports the findings command needs. @public */
export interface FindingsCommandPorts {
  readonly fileSystem: FileSystemPort;
  /** Clock for scan timestamps. Defaults to the system clock. */
  readonly now?: () => number;
  readonly writeLine: (line: string) => void;
}

/** @public */
export interface FindingsCommandResult {
  readonly message?: string;
  readonly ok: boolean;
}

function failure(message: string): FindingsCommandResult {
  return { message, ok: false };
}

// A file the operator named that could not be opened: refused because it lies
// outside the project, or genuinely unreadable.
function unreadable(path: string, error: unknown): FindingsCommandResult {
  return failure(unreadablePathMessage(path, error));
}

// A cookie entry the recording names impossibly is said, not dropped silently.
function reportSkippedCookie(
  ports: FindingsCommandPorts,
): (name: string) => void {
  return (name) => {
    ports.writeLine(
      `skipped ${JSON.stringify(name)}: not a cookie name. A recorder can split one Set-Cookie header at the comma in its date.`,
    );
  };
}

/** A request back to the page's own origin that is not a script. */
function sameOriginRequest(observation: SessionScanObservation): boolean {
  if (observation.kind !== "network-destination") return false;
  try {
    return (
      new URL(observation.name).origin === new URL(observation.source).origin
    );
  } catch {
    return false;
  }
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Collects every value given for a flag an operator may repeat. */
function readRepeatedFlag(
  args: readonly string[],
  flag: string,
): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === flag && value !== undefined && !value.startsWith("-")) {
      values.push(value);
    }
  }
  return values;
}

function parseInventory(document: string): FindingsInventory | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { findings?: unknown }).findings)
  ) {
    return undefined;
  }
  const findings = (parsed as { findings: unknown[] }).findings;
  if (!findings.every(hasCompleteDecision)) return undefined;
  return parsed as FindingsInventory;
}

/**
 * Accepts a finding whose decision, if it has one, carries every part an
 * operator decides.
 *
 * A decision stored before it carried a vendor, a retention or a cleanup
 * behavior would otherwise be listed with those parts blank and drafted into a
 * policy as if they had been decided.
 */
function hasCompleteDecision(finding: unknown): boolean {
  const decision = (finding as { decision?: unknown } | null)?.decision;
  if (decision === undefined) return true;
  if (typeof decision !== "object" || decision === null) return false;
  const parts = decision as Record<string, unknown>;
  const named = ["disclosure", "retention", "service", "vendor"].every(
    (key) => typeof parts[key] === "string" && parts[key] !== "",
  );
  return (
    named &&
    Array.isArray(parts["categoryIds"]) &&
    parts["categoryIds"].length > 0 &&
    FINDING_CLEANUPS.includes(parts["cleanup"] as FindingCleanup)
  );
}

async function readInventory(
  ports: FindingsCommandPorts,
): Promise<FindingsInventory | undefined> {
  if (!(await ports.fileSystem.exists(FINDINGS_INVENTORY_PATH))) {
    return emptyFindingsInventory();
  }
  return parseInventory(
    await ports.fileSystem.readFile(FINDINGS_INVENTORY_PATH),
  );
}

/**
 * Reads a site's inventory, or reports that it does not parse.
 *
 * Exported so another surface can ask what is still undecided without keeping
 * a second idea of how an inventory is read.
 *
 * @public
 */
export async function readFindingsInventory(
  fileSystem: FileSystemPort,
): Promise<FindingsInventory | undefined> {
  return readInventory({ fileSystem, writeLine: () => undefined });
}

async function writeInventory(
  ports: FindingsCommandPorts,
  inventory: FindingsInventory,
): Promise<void> {
  const document = `${JSON.stringify(inventory, undefined, 2)}\n`;
  const parent = FINDINGS_INVENTORY_PATH.slice(
    0,
    FINDINGS_INVENTORY_PATH.lastIndexOf("/"),
  );
  if (parent !== "") await ports.fileSystem.mkdir(parent);
  if (await ports.fileSystem.exists(FINDINGS_INVENTORY_PATH)) {
    const previous = await ports.fileSystem.readFile(FINDINGS_INVENTORY_PATH);
    await ports.fileSystem.replaceFile(
      FINDINGS_INVENTORY_PATH,
      previous,
      document,
    );
    return;
  }
  await ports.fileSystem.writeFile(FINDINGS_INVENTORY_PATH, document);
}

/**
 * Names what the drafted purposes still need, taken from the draft itself so
 * the summary can never ask for something an operator already decided.
 */
function stillNeeded(draft: PolicyDraft): string {
  const missing = [
    ...new Set(draft.purposes.flatMap((purpose) => purpose.missing)),
  ].sort((left, right) => left.localeCompare(right));
  return missing.length === 0
    ? "a draft is never publishable on its own, and a policy must still be defined and published"
    : `each purpose still needs ${missing.join(", ")}`;
}

function describeFinding(finding: Finding): readonly string[] {
  const decision =
    finding.decision === undefined
      ? ""
      : ` -> ${finding.decision.purposeId}${finding.decision.necessary ? ", necessary" : ""} decided ${finding.decision.decidedAt}`;
  const lines = [
    `${finding.kind} ${finding.name} [${finding.classification}, ${finding.uncertainty}]${decision}`,
  ];
  if (finding.decision !== undefined) {
    const { categoryIds, cleanup, disclosure, retention, service, vendor } =
      finding.decision;
    lines.push(
      `    ${vendor} / ${service}; ${categoryIds.join(", ")}; kept ${retention}; on withdrawal ${cleanup}`,
      `    "${disclosure}"`,
    );
  }
  for (const observation of finding.observations) {
    lines.push(
      `    seen ${observation.observedAt} on ${observation.source} via ${observation.trigger} in ${observation.browser}`,
    );
  }
  return lines;
}

/**
 * Adds observations to the inventory through the one ingestion path shared by
 * `import` and `scan`, all or nothing.
 */
async function ingestObservations(
  ports: FindingsCommandPorts,
  observations: readonly unknown[],
): Promise<FindingsCommandResult> {
  const inventory = await readInventory(ports);
  if (inventory === undefined) {
    return failure("The findings inventory could not be read.");
  }
  const imported = importObservedFindings(inventory, observations);
  if (!imported.ok) {
    return failure(`The import was refused: ${imported.issue.kind}.`);
  }
  await writeInventory(ports, imported.inventory);
  const { findings } = imported.inventory;
  const added = findings.length - inventory.findings.length;
  const unclassified = findings.filter(
    (finding) => finding.classification === "unclassified",
  ).length;
  ports.writeLine(
    `Imported ${String(observations.length)} observation(s): ${String(added)} new finding(s); ${String(unclassified)} of ${String(findings.length)} finding(s) unclassified.`,
  );
  return { ok: true };
}

/**
 * Runs `opencookie findings import|list` against the project inventory.
 *
 * Imported findings are always unclassified. They record what an observer saw
 * and never become policy truth on their own.
 *
 * @public
 */
export function runFindingsCommand(
  ports: FindingsCommandPorts,
  args: readonly string[],
): Promise<FindingsCommandResult> {
  return refusingMissingFlagValues(() => run(ports, args), failure, args, {
    check: ["--har", "--browser"],
    classify: [
      "--category",
      "--cleanup",
      "--disclosure",
      "--kind",
      "--match",
      "--name",
      "--necessary",
      "--purpose",
      "--retention",
      "--service",
      "--vendor",
    ],
    "draft-policy": ["--out"],
    import: ["--from"],
    scan: ["--html", "--page"],
    session: ["--har", "--browser", "--same-origin"],
    storage: ["--from", "--browser"],
  });
}

async function run(
  ports: FindingsCommandPorts,
  args: readonly string[],
): Promise<FindingsCommandResult> {
  const subcommand = args[0];

  if (subcommand === "list") {
    const inventory = await readInventory(ports);
    if (inventory === undefined) {
      return failure("The findings inventory could not be read.");
    }
    if (inventory.findings.length === 0) {
      ports.writeLine("No findings have been imported.");
      return { ok: true };
    }
    const classified = inventory.findings.filter(
      (finding) => finding.classification === "classified",
    ).length;
    const unclassified = inventory.findings.length - classified;
    ports.writeLine(
      `${String(inventory.findings.length)} finding(s): ${String(classified)} classified, ${String(unclassified)} unclassified. Only an operator decision classifies a finding.`,
    );
    for (const finding of inventory.findings) {
      for (const line of describeFinding(finding)) ports.writeLine(line);
    }
    return { ok: true };
  }

  if (subcommand === "import") {
    const from = readFlag(args, "--from");
    if (from === undefined) {
      return failure("import requires --from <file>.");
    }
    let raw: string;
    try {
      raw = await ports.fileSystem.readFile(from);
    } catch (error: unknown) {
      return unreadable(from, error);
    }
    let observations: unknown;
    try {
      observations = JSON.parse(raw);
    } catch {
      return failure(`${from} is not a readable observation document.`);
    }
    if (!Array.isArray(observations)) {
      return failure(`${from} must contain a list of observations.`);
    }
    return ingestObservations(ports, observations);
  }

  if (subcommand === "scan") {
    const htmlPath = readFlag(args, "--html");
    const pageRaw = readFlag(args, "--page");
    if (htmlPath === undefined || pageRaw === undefined) {
      return failure(
        "scan requires --html <file> and --page <url>; the page address is needed to resolve relative links.",
      );
    }
    let page: URL;
    try {
      page = new URL(pageRaw);
    } catch {
      return failure(
        `--page ${pageRaw} is not a URL; give the http or https address the HTML was saved from.`,
      );
    }
    if (page.protocol !== "http:" && page.protocol !== "https:") {
      return failure(
        `--page must be an http or https address, not ${page.protocol}`,
      );
    }
    let html: string;
    try {
      html = await ports.fileSystem.readFile(htmlPath);
    } catch (error: unknown) {
      return unreadable(htmlPath, error);
    }
    const observedAt = new Date((ports.now ?? Date.now)()).toISOString();
    const observations = scanHtml(html, page.href, observedAt);
    const result = await ingestObservations(ports, observations);
    if (result.ok) {
      ports.writeLine(
        "This scan read the page's markup. It cannot see cookies, storage writes or resources that JavaScript adds at runtime.",
      );
    }
    return result;
  }

  if (subcommand === "session") {
    const harPath = readFlag(args, "--har");
    if (harPath === undefined) {
      return failure(
        "session requires --har <file>, an HTTP Archive recording exported from a browser.",
      );
    }
    let recording: string;
    try {
      recording = await ports.fileSystem.readFile(harPath);
    } catch (error: unknown) {
      return unreadable(harPath, error);
    }
    let observations: readonly SessionScanObservation[];
    try {
      observations = scanHar(
        recording,
        readFlag(args, "--browser"),
        reportSkippedCookie(ports),
        { includeSameOrigin: args.includes("--same-origin") },
      );
    } catch (error: unknown) {
      return failure(
        error instanceof Error
          ? error.message
          : `${harPath} is not an HTTP Archive recording.`,
      );
    }
    const result = await ingestObservations(ports, observations);
    if (result.ok) {
      ports.writeLine(
        "A recording shows what reached the network. It cannot show Web Storage, because those writes never leave the browser.",
      );
    }
    return result;
  }

  if (subcommand === "storage") {
    const from = readFlag(args, "--from");
    const browser = readFlag(args, "--browser");
    if (from === undefined || browser === undefined) {
      return failure(
        "storage requires --from <file> and --browser <name>, the browser the snapshot was taken in.",
      );
    }
    let snapshot: string;
    try {
      snapshot = await ports.fileSystem.readFile(from);
    } catch (error: unknown) {
      return unreadable(from, error);
    }
    let observations: readonly SessionScanObservation[];
    try {
      observations = scanStorageSnapshot(snapshot, browser);
    } catch (error: unknown) {
      return failure(
        error instanceof Error
          ? error.message
          : `${from} is not a Web Storage snapshot.`,
      );
    }
    const result = await ingestObservations(ports, observations);
    if (result.ok) {
      ports.writeLine(
        "This is what one browser profile held at one moment. It is not everything the site can write.",
      );
    }
    return result;
  }

  if (subcommand === "check") {
    const harPath = readFlag(args, "--har");
    if (harPath === undefined) {
      return failure(
        "check requires --har <file>, a recording made after rejecting everything optional.",
      );
    }
    let recording: string;
    try {
      recording = await ports.fileSystem.readFile(harPath);
    } catch (error: unknown) {
      return unreadable(harPath, error);
    }
    let observations: readonly SessionScanObservation[];
    try {
      // Same-origin requests are read too, so a decided first-party relay is
      // caught; an undecided one is the site's own and is left out below.
      observations = scanHar(
        recording,
        readFlag(args, "--browser"),
        reportSkippedCookie(ports),
        { includeSameOrigin: true },
      );
    } catch (error: unknown) {
      return failure(
        error instanceof Error
          ? error.message
          : `${harPath} is not an HTTP Archive recording.`,
      );
    }
    const inventory = await readInventory(ports);
    if (inventory === undefined) {
      return failure("The findings inventory could not be read.");
    }
    const decisionFor = decisionLookup(inventory.findings);
    const optional: SessionScanObservation[] = [];
    const undecided: SessionScanObservation[] = [];
    for (const observation of observations) {
      const finding = decisionFor(observation.kind, observation.name);
      if (finding === undefined) {
        if (!sameOriginRequest(observation)) undecided.push(observation);
        continue;
      }
      if (finding.decision?.necessary !== true) optional.push(observation);
    }
    for (const observation of optional) {
      ports.writeLine(
        `loaded after rejection: ${observation.kind} ${observation.name}`,
      );
    }
    for (const observation of undecided) {
      ports.writeLine(
        `not decided: ${observation.kind} ${observation.name}. Classify it, or it is neither allowed nor blocked by any decision.`,
      );
    }
    ports.writeLine(
      `${plural(optional.length, "optional resource")} reached the network after rejection; ${plural(undecided.length, "resource")} had no decision.`,
    );
    ports.writeLine(
      "This reads one recording of one session in one browser. It is evidence of what happened, not proof of what always happens.",
    );
    // A release gate fails closed: a resource nobody has classified may be a
    // vendor added since the last review, so the recording cannot show that
    // rejection worked until it is decided, whichever way.
    const failures = [
      ...(optional.length === 0
        ? []
        : [
            `${plural(optional.length, "optional resource")} loaded although the visitor rejected. That is a failure of enforcement, not a finding to classify.`,
          ]),
      ...(undecided.length === 0
        ? []
        : [
            `${plural(undecided.length, "resource")} had no decision, so this recording cannot show that rejection worked. Classify each one, necessary or optional, and check again.`,
          ]),
    ];
    return failures.length === 0
      ? { ok: true }
      : { message: failures.join(" "), ok: false };
  }

  if (subcommand === "classify") {
    const kind = readFlag(args, "--kind");
    const name = readFlag(args, "--name");
    const purposeId = readFlag(args, "--purpose");
    const vendor = readFlag(args, "--vendor");
    const service = readFlag(args, "--service");
    const disclosure = readFlag(args, "--disclosure");
    const retention = readFlag(args, "--retention");
    const cleanup = readFlag(args, "--cleanup");
    const matchPattern = readFlag(args, "--match");
    const categoryIds = readRepeatedFlag(args, "--category");
    const required: readonly (readonly [string, string | undefined])[] = [
      ["--kind <kind>", kind],
      ["--name <finding>", name],
      ["--purpose <purpose>", purposeId],
      ["--vendor <vendor>", vendor],
      ["--service <service>", service],
      ["--category <category>", categoryIds[0]],
      ["--disclosure <text>", disclosure],
      ["--retention <retention>", retention],
      [`--cleanup <${FINDING_CLEANUPS.join("|")}>`, cleanup],
    ];
    const absent = required
      .filter(([, value]) => value === undefined)
      .map(([flag]) => flag);
    if (
      absent.length > 0 ||
      kind === undefined ||
      name === undefined ||
      purposeId === undefined ||
      vendor === undefined ||
      service === undefined ||
      disclosure === undefined ||
      retention === undefined ||
      cleanup === undefined
    ) {
      return failure(`classify requires ${absent.join(", ")}.`);
    }
    if (!FINDING_KINDS.includes(kind as FindingKind)) {
      return failure(`${kind} is not a supported finding kind.`);
    }
    if (!FINDING_CLEANUPS.includes(cleanup as FindingCleanup)) {
      return failure(
        `${cleanup} is not a cleanup behavior OpenCookie has; use one of ${FINDING_CLEANUPS.join(", ")}.`,
      );
    }
    const inventory = await readInventory(ports);
    if (inventory === undefined) {
      return failure("The findings inventory could not be read.");
    }
    const classified = classifyFinding(inventory, {
      categoryIds,
      cleanup: cleanup as FindingCleanup,
      decidedAt: new Date((ports.now ?? Date.now)()).toISOString(),
      disclosure,
      kind: kind as FindingKind,
      ...(matchPattern === undefined ? {} : { matchPattern }),
      name,
      necessary: args.includes("--necessary"),
      purposeId,
      retention,
      service,
      vendor,
    });
    if (!classified.ok) {
      const { issue } = classified;
      return failure(
        issue.kind === "invalid-pattern"
          ? `--match ${issue.pattern} is not a usable pattern: ${issue.reason}. Use * for the part of one path segment that varies, as in https://cdn.example/include/*/loader.js.`
          : `The classification was refused: ${issue.kind}.`,
      );
    }
    await writeInventory(ports, classified.inventory);
    ports.writeLine(`Classified ${kind} ${name} as ${purposeId}.`);
    return { ok: true };
  }

  if (subcommand === "draft-policy") {
    const inventory = await readInventory(ports);
    if (inventory === undefined) {
      return failure("The findings inventory could not be read.");
    }
    const drafted = draftPolicyFromFindings(inventory);
    if (!drafted.ok) {
      return failure(
        "No findings are classified, so there is nothing to draft. Classify a finding first.",
      );
    }
    const outputPath = readFlag(args, "--out") ?? POLICY_DRAFT_PATH;
    const document = `${JSON.stringify(drafted.draft, undefined, 2)}\n`;
    const parent = parentDirectory(outputPath);
    if (parent !== "") await ports.fileSystem.mkdir(parent);
    if (await ports.fileSystem.exists(outputPath)) {
      const previous = await ports.fileSystem.readFile(outputPath);
      if (!isPolicyDraft(previous)) {
        return failure(
          `${outputPath} is not a policy draft OpenCookie wrote, so it was not replaced. Pass --out to write the draft somewhere else.`,
        );
      }
      await ports.fileSystem.replaceFile(outputPath, previous, document);
    } else {
      await ports.fileSystem.writeFile(outputPath, document);
    }
    ports.writeLine(
      `Wrote a draft with ${String(drafted.draft.purposes.length)} purpose(s) to ${outputPath}. It is not publishable: ${stillNeeded(drafted.draft)}.`,
    );
    return { ok: true };
  }

  return failure(`Unknown findings command: ${subcommand ?? ""}`.trim());
}
