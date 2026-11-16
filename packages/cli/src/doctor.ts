import {
  CONFIGURATION_PATH,
  purposesMissingForConfiguration,
} from "./configuration-bindings.js";
import { EVIDENCE_STORE_PATH } from "./evidence-command.js";
import type { FileSystemPort } from "./contracts.js";
import {
  plainHtmlLimitation,
  plainHtmlPolicyVersions,
  servesProjectDirectory,
} from "./plain-html-page.js";
import { FINDINGS_INVENTORY_PATH } from "./findings-command.js";
import { decisionLookup, type Finding } from "./findings.js";
import {
  INSTALLED_POLICY_PATH,
  installedPolicyDocument as installedPolicyJson,
  isJsonPath,
  moduleSite,
  POLICY_DECLARATION_PATH,
  POLICY_PUBLICATION_STORE_PATH,
  readInstalledPolicyPaths,
} from "./policy-command.js";
import { MissingFlagValueError, readFlag } from "./flags.js";
import { readPolicyPublicationLog } from "./policy-store.js";
import { unreadablePathMessage } from "./project-paths.js";
import {
  currentPolicyPublication,
  type PolicyPublication,
} from "./publication-log.js";

/**
 * How much a diagnostic matters.
 *
 * A `problem` means the project will not behave as its operator intends until it
 * is resolved, and fails the run. `advice` reports work that is merely
 * incomplete, so a project mid-setup is not reported as broken.
 *
 * @public
 */
export type DiagnosticSeverity = "advice" | "problem";

/**
 * A single reason-coded observation about a project's OpenCookie setup.
 *
 * The `code` is stable so that scripts and support conversations can refer to a
 * diagnostic without quoting prose that may be reworded.
 *
 * @public
 */
export interface Diagnostic {
  readonly code: string;
  readonly detail: string;
  readonly severity: DiagnosticSeverity;
}

/** @public */
export interface DoctorResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly ok: boolean;
}

/** @public */
export interface DoctorPorts {
  readonly fileSystem: FileSystemPort;
  /** The registered site this run inspects, when the project has several. */
  readonly site?: string;
  readonly writeLine: (line: string) => void;
}

/** What a doctor run checks beyond the project's own OpenCookie files. @public */
export interface DoctorOptions {
  /**
   * Built files, relative to the project, of a site that bundles its own
   * integration. Each is checked for the digests of the live publication.
   */
  readonly bundles?: readonly string[];
}

/**
 * Reads doctor's arguments: `--bundle <file>` or `--bundle=<file>`, repeated
 * for each bundle, and nothing else. Anything else is refused rather than
 * ignored, so a misspelt option never reads as a clean run.
 *
 * @internal
 */
export function doctorOptions(
  args: readonly string[],
):
  | { readonly message: string; readonly ok: false }
  | { readonly ok: true; readonly options: DoctorOptions } {
  const bundles: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument !== "--bundle" && !argument.startsWith("--bundle=")) {
      return {
        message: `doctor takes only --bundle <file>; found ${argument}.`,
        ok: false,
      };
    }
    try {
      bundles.push(readFlag(args.slice(index), "--bundle") ?? "");
    } catch (error) {
      if (!(error instanceof MissingFlagValueError)) throw error;
      return { message: error.message, ok: false };
    }
    if (argument === "--bundle") index += 1;
  }
  return { ok: true, options: { bundles } };
}

function advice(code: string, detail: string): Diagnostic {
  return { code, detail, severity: "advice" };
}

function problem(code: string, detail: string): Diagnostic {
  return { code, detail, severity: "problem" };
}

async function readJson(
  fileSystem: FileSystemPort,
  path: string,
): Promise<{ readonly parsed?: unknown; readonly present: boolean }> {
  if (!(await fileSystem.exists(path))) return { present: false };
  try {
    return {
      parsed: JSON.parse(await fileSystem.readFile(path)),
      present: true,
    };
  } catch {
    return { present: true };
  }
}

async function inspectPublications(
  ports: DoctorPorts,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  const read = await readPolicyPublicationLog(
    ports.fileSystem,
    POLICY_PUBLICATION_STORE_PATH,
  );
  if (!read.ok) {
    diagnostics.push(
      problem(
        "publication-history-unreadable",
        `${POLICY_PUBLICATION_STORE_PATH} could not be read as a publication history. It is never overwritten while unreadable, so restore it from version control rather than deleting it.`,
      ),
    );
    return undefined;
  }
  const current = currentPolicyPublication(read.log);
  if (current !== undefined && current.terms === undefined) {
    diagnostics.push(
      advice(
        "declaration-without-plain-language",
        "The published policy has no plain-language terms, so a declaration built from it shows visitors bare catalogue identifiers. Add a `terms` block to the policy document.",
      ),
    );
  }
  if (current === undefined) {
    diagnostics.push(
      problem(
        "no-policy-published",
        "No policy has been published, so the runtime has no policy to enforce. Publish one with `opencookie policy publish`.",
      ),
    );
    return undefined;
  }
  return current.publicationId;
}

function inspectFindings(
  parsed: unknown,
  present: boolean,
  diagnostics: Diagnostic[],
): void {
  if (!present) {
    diagnostics.push(
      advice(
        "findings-not-imported",
        `No observed findings at ${FINDINGS_INVENTORY_PATH}. Import a scan with \`opencookie findings import\` to classify what the site actually loads.`,
      ),
    );
    return;
  }
  const findings = (parsed as { findings?: unknown } | undefined)?.findings;
  if (!Array.isArray(findings)) {
    diagnostics.push(
      problem(
        "findings-inventory-unreadable",
        `${FINDINGS_INVENTORY_PATH} is not a findings inventory. Re-import the scan that produced it.`,
      ),
    );
    return;
  }
  // Counted the way `findings check` applies decisions: a finding a decision
  // covers by address or pattern is decided, though it has none of its own.
  const decisionFor = decisionLookup(findings as readonly Finding[]);
  const unclassified = (findings as readonly Finding[]).filter(
    (finding) =>
      finding.classification !== "classified" &&
      decisionFor(finding.kind, finding.name) === undefined,
  ).length;
  if (unclassified > 0) {
    diagnostics.push(
      advice(
        "findings-unclassified",
        `${String(unclassified)} of ${String(findings.length)} findings are still unclassified. An unclassified finding carries no purpose, so it cannot appear in a declaration.`,
      ),
    );
  }
}

function inspectDeclaration(
  parsed: unknown,
  present: boolean,
  publicationId: string | undefined,
  diagnostics: Diagnostic[],
): void {
  if (!present) {
    if (publicationId !== undefined) {
      diagnostics.push(
        advice(
          "declaration-not-generated",
          `A policy is published but no declaration exists at ${POLICY_DECLARATION_PATH}. Generate one with \`opencookie policy declaration\`.`,
        ),
      );
    }
    return;
  }
  const declared = (parsed as { publicationId?: unknown } | undefined)
    ?.publicationId;
  if (declared === publicationId) return;
  diagnostics.push(
    problem(
      "declaration-not-current",
      `${POLICY_DECLARATION_PATH} describes publication ${typeof declared === "string" ? declared : "an unreadable value"}, but the live publication is ${publicationId ?? "absent"}. Visitors would be shown a declaration that does not match what is enforced.`,
    ),
  );
}

/**
 * The version a policy module declares. Install writes it as a JSON string, so
 * it is read back as one: an escaped quote or a raw line separator in the
 * version then compares equal to the published version.
 */
function installedPolicyVersion(module: string): string | undefined {
  const literal =
    /^export const policyVersion = ("(?:[^"\\\n]|\\.)*");$/mu.exec(module)?.[1];
  if (literal === undefined) {
    // A module edited by hand may quote a plain version with single quotes.
    return /^export const policyVersion = '(?<version>[^'\\\n]*)';$/mu.exec(
      module,
    )?.groups?.["version"];
  }
  try {
    const version: unknown = JSON.parse(literal);
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The policy document an installed module was generated from, if readable. */
function installedPolicyDocument(module: string): unknown {
  const document = /^const result = definePolicy\(([\s\S]*?)\);$/mu.exec(
    module,
  )?.[1];
  try {
    return document === undefined ? undefined : JSON.parse(document);
  } catch {
    return undefined;
  }
}

/** A complete policy digest, as a bundle keeps it; core's bare prefix is not one. */
const POLICY_DIGEST = /sha256-v1:[0-9a-f]{64}/gu;

/**
 * Says which publication each bundle carries the identity of.
 *
 * A bundle that bootstraps from an installed policy keeps its recorded digests
 * as literals, because the runtime checks the policy against them. Finding
 * them says what the bundle was built from, not what it enforces: refusing a
 * policy that does not derive them is the runtime's check, not this one.
 * Without a live publication there is nothing to compare with, and the run has
 * already failed for that. Returns whether any bundle carries the live identity.
 */
async function inspectBundles(
  ports: DoctorPorts,
  bundles: readonly string[],
  diagnostics: Diagnostic[],
): Promise<boolean> {
  if (bundles.length === 0) return false;
  const read = await readPolicyPublicationLog(
    ports.fileSystem,
    POLICY_PUBLICATION_STORE_PATH,
  );
  if (!read.ok) return false;
  const current = currentPolicyPublication(read.log);
  if (current === undefined) return false;
  const named = (publication: PolicyPublication): string =>
    `publication ${publication.publicationId} (policy version ${publication.snapshot.policyVersion})`;
  const rebuild =
    "Install the live policy with `opencookie policy install --out <file>.json` and rebuild the bundle from it.";
  let carriesLive = false;
  for (const path of bundles) {
    let content: string;
    try {
      content = await ports.fileSystem.readFile(path);
    } catch (error) {
      diagnostics.push(
        problem("bundle-unreadable", unreadablePathMessage(path, error)),
      );
      continue;
    }
    const digests = new Set(content.match(POLICY_DIGEST));
    const carries = ({ snapshot }: PolicyPublication): boolean =>
      digests.has(snapshot.catalogueDigest) &&
      digests.has(snapshot.decisionSurfaceDigest);
    if (carries(current)) {
      carriesLive = true;
      ports.writeLine(
        `${path} carries the identity of the live ${named(current)}.`,
      );
      continue;
    }
    if (digests.size === 0) {
      diagnostics.push(
        problem(
          "bundle-policy-unverified",
          `${path} carries no OpenCookie policy identity, so doctor cannot tell which publication it was built from. Bootstrap it with \`bootstrapOpenCookie({ installedPolicy })\` from the file \`opencookie policy install --out <file>.json\` writes, or pass --bundle the built file that does.`,
        ),
      );
      continue;
    }
    const carried = [...read.log.publications].reverse().find(carries);
    diagnostics.push(
      problem(
        "bundle-policy-stale",
        carried === undefined
          ? `${path} carries OpenCookie policy digests, but not those of the live ${named(current)} or of any publication in the history. ${rebuild}`
          : `${path} carries the identity of ${named(carried)}, not of the live ${named(current)}. ${rebuild}`,
      ),
    );
  }
  return carriesLive;
}

/**
 * Compares the policy the project would enforce with the one that is live.
 *
 * The runtime enforces the policy module in the project, not the publication
 * history, so a policy published and never installed leaves visitors deciding
 * against the previous one while the history says otherwise. A project that
 * keeps its module elsewhere is only advised, never failed, and not even that
 * when a bundle it names carries the live identity.
 */
async function inspectInstalledPolicy(
  ports: DoctorPorts,
  diagnostics: Diagnostic[],
  bundleCarriesLive: boolean,
): Promise<void> {
  const read = await readPolicyPublicationLog(
    ports.fileSystem,
    POLICY_PUBLICATION_STORE_PATH,
  );
  if (!read.ok) return;
  const current = currentPolicyPublication(read.log);
  if (current === undefined) return;
  const plainHtml = await plainHtmlPolicyVersions(ports.fileSystem);
  if (plainHtml !== undefined) {
    diagnostics.push(
      problem(
        "plain-html-policy-not-enforced",
        `${plainHtmlLimitation(plainHtml)} Visitors decide on that, not on the live publication ${current.publicationId} (policy version ${current.snapshot.policyVersion}).`,
      ),
    );
    return;
  }
  const missing = await purposesMissingForConfiguration(
    ports.fileSystem,
    current.snapshot.policy.purposes.map((purpose) => purpose.id),
  );
  if (missing.length > 0) {
    diagnostics.push(
      problem(
        "configuration-purpose-undeclared",
        `${CONFIGURATION_PATH} binds resources to ${missing.join(", ")}, which the live publication ${current.publicationId} does not declare. The application fails to load against that policy, so it cannot be installed. Publish a policy that declares ${missing.length === 1 ? "that purpose" : "those purposes"}, or change the resources in ${CONFIGURATION_PATH}.`,
      ),
    );
  }
  const live = current.snapshot.policyVersion;
  // The default module, and every path install recorded writing to with --out.
  const paths = [
    ...new Set([
      INSTALLED_POLICY_PATH,
      ...(await readInstalledPolicyPaths(ports.fileSystem)),
    ]),
  ];
  let installed = false;
  let otherSite: { owner: string; path: string } | undefined;
  for (const path of paths) {
    if (!(await ports.fileSystem.exists(path))) continue;
    const content = await ports.fileSystem.readFile(path);
    const reinstall =
      path === INSTALLED_POLICY_PATH
        ? "`opencookie policy install`"
        : `\`opencookie policy install --out ${path}\``;
    if (isJsonPath(path)) {
      const document = installedPolicyJson(content);
      if (document === undefined) continue;
      const site =
        typeof document["site"] === "string" ? document["site"] : undefined;
      if (site !== ports.site) continue;
      installed = true;
      if (
        document["catalogueDigest"] === current.snapshot.catalogueDigest &&
        document["decisionSurfaceDigest"] ===
          current.snapshot.decisionSurfaceDigest
      ) {
        continue;
      }
      diagnostics.push(
        problem(
          "installed-policy-stale",
          `${path} carries policy version ${String(document["policyVersion"])} from publication ${String(document["publicationId"])}, but the live publication is ${current.publicationId} (policy version ${live}). A bundle built from it enforces a policy that is no longer published. Run ${reinstall} and rebuild.`,
        ),
      );
      continue;
    }
    const owner = moduleSite(content);
    if (owner !== undefined && owner !== ports.site) {
      otherSite ??= { owner, path };
      continue;
    }
    installed = true;
    const declared = installedPolicyVersion(content);
    const document = installedPolicyDocument(content);
    // Versions alone let a module whose policy differs at the same version
    // pass; a module generated by install carries the whole document to
    // compare.
    const sameDocument =
      document === undefined ||
      JSON.stringify(document) === JSON.stringify(current.snapshot.policy);
    if (declared === live && sameDocument) continue;
    diagnostics.push(
      problem(
        "installed-policy-stale",
        declared === live
          ? `${path} declares policy version ${live}, but its policy differs from the live publication ${current.publicationId}. Visitors would decide against a policy that is not the published one. Run ${reinstall}.`
          : `${path} enforces policy version ${declared ?? "an unreadable value"}, but the live publication is ${live}. Visitors would decide against a policy that is no longer published. Run ${reinstall}.`,
      ),
    );
  }
  if (installed || bundleCarriesLive) return;
  diagnostics.push(
    advice(
      "policy-not-installed",
      otherSite === undefined
        ? `Policy version ${live} is published but no installed policy was found, neither ${INSTALLED_POLICY_PATH} nor a file \`opencookie policy install --out\` recorded writing, so nothing in this project enforces it. Run \`opencookie policy install\`. A site that bundles its own integration can check its built bundle with \`opencookie doctor --bundle <file>\`.`
        : `${otherSite.path} holds the policy of site ${otherSite.owner}, not ${ports.site === undefined ? "this project" : `site ${ports.site}`}. Install this policy into its own module with \`opencookie policy install --out <file>\`.`,
    ),
  );
}

/**
 * Inspects a project's OpenCookie setup and reports reason-coded diagnostics.
 *
 * Every check reads persisted operator state, and the bundles it is given,
 * only, so running the doctor never changes what the project enforces. It
 * reports what it finds and does not assert that a project meets any legal
 * obligation.
 *
 * @public
 */
export async function runDoctor(
  ports: DoctorPorts,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const diagnostics: Diagnostic[] = [];
  const publicationId = await inspectPublications(ports, diagnostics);

  const findings = await readJson(ports.fileSystem, FINDINGS_INVENTORY_PATH);
  inspectFindings(findings.parsed, findings.present, diagnostics);

  const declaration = await readJson(ports.fileSystem, POLICY_DECLARATION_PATH);
  inspectDeclaration(
    declaration.parsed,
    declaration.present,
    publicationId,
    diagnostics,
  );

  const bundleCarriesLive = await inspectBundles(
    ports,
    options.bundles ?? [],
    diagnostics,
  );
  await inspectInstalledPolicy(ports, diagnostics, bundleCarriesLive);
  // Receipts are personal data; in a plain-HTML web root they are served.
  if (
    (await servesProjectDirectory(ports.fileSystem)) &&
    (await ports.fileSystem.exists(EVIDENCE_STORE_PATH))
  ) {
    diagnostics.push(
      problem(
        "evidence-in-web-root",
        `${EVIDENCE_STORE_PATH} holds consent evidence inside this site's web root, so any visitor can download it. Move OpenCookie's operator data outside the directory the site serves, delete the copy here and any exports beside it, and run the evidence commands with --cwd <that directory>.`,
      ),
    );
  }

  for (const diagnostic of diagnostics) {
    ports.writeLine(`${diagnostic.severity}: ${diagnostic.code}`);
    ports.writeLine(`  ${diagnostic.detail}`);
  }
  const ok = !diagnostics.some(({ severity }) => severity === "problem");
  ports.writeLine(
    ok
      ? `opencookie doctor: no problems found (${String(diagnostics.length)} advisory).`
      : `opencookie doctor: ${String(diagnostics.filter(({ severity }) => severity === "problem").length)} problem(s) found.`,
  );
  return { diagnostics, ok };
}
