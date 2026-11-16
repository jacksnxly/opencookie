import {
  createPolicySnapshot,
  definePolicy,
  normalizePolicyIdentifier,
  type PolicyDefinition,
  type PolicySnapshot,
} from "@opencookie-dev/core/domain";

import type { FileSystemPort } from "./contracts.js";
import {
  publishPolicyToStore,
  readPolicyPublicationLog,
  rollbackPolicyInStore,
} from "./policy-store.js";
import {
  buildPolicyDeclaration,
  type PolicyDeclaration,
} from "./policy-declaration.js";
import {
  declarePolicyTerms,
  type DisclosureIssue,
  type PolicyTerms,
} from "./disclosure.js";
import {
  definePolicyLawfulBases,
  type PolicyLawfulBases,
} from "./lawful-basis.js";
import {
  currentPolicyPublication,
  isPublicationId,
  type PolicyPublication,
} from "./publication-log.js";
import {
  CONFIGURATION_PATH,
  purposesMissingForConfiguration,
} from "./configuration-bindings.js";
import { readFlag, refusingMissingFlagValues } from "./flags.js";
import { parentDirectory } from "./project-paths.js";
import {
  plainHtmlLimitation,
  plainHtmlPolicyVersions,
} from "./plain-html-page.js";

/** Where an operator's published policy history is kept, relative to the project. @public */
export const POLICY_PUBLICATION_STORE_PATH =
  "opencookie/policy-publications.json";

/** Default path for the generated public cookie declaration. @public */
export const POLICY_DECLARATION_PATH = "opencookie/cookie-declaration.json";

/** Ports the policy command needs. @public */
export interface PolicyCommandPorts {
  readonly fileSystem: FileSystemPort;
  /** The registered site this command works on, when the project has several. */
  readonly site?: string;
  readonly writeLine: (line: string) => void;
}

/** @public */
export interface PolicyCommandResult {
  readonly message?: string;
  readonly ok: boolean;
}

function failure(message: string): PolicyCommandResult {
  return { message, ok: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface LoadedPolicyDocument {
  readonly lawfulBases?: PolicyLawfulBases;
  readonly ok: true;
  readonly snapshot: PolicySnapshot;
  readonly terms?: PolicyTerms;
}

/**
 * Why a policy document could not be used.
 *
 * A lawful basis that names a purpose the policy does not define is reported as
 * itself, not as an unreadable file: the document parsed, and saying otherwise
 * would send an operator looking for the wrong mistake.
 */
interface RejectedPolicyDocument {
  readonly detail: string;
  readonly ok: false;
}

type PolicyDocumentResult = LoadedPolicyDocument | RejectedPolicyDocument;

function describeDisclosureIssue(
  path: string,
  issue: DisclosureIssue,
  categories: unknown,
): string {
  if (issue.kind === "category-term") {
    const index = Array.isArray(categories)
      ? categories.findIndex(
          (category) =>
            normalizePolicyIdentifier(asRecord(category)?.["id"]) ===
            issue.referenceId,
        )
      : -1;
    return `${path} gives a term for "${issue.referenceId}", but "${issue.referenceId}" is a category. Its heading is its label in the policy: set categories[${String(Math.max(index, 0))}].label, with translations for each further language.`;
  }
  if (issue.kind === "undisclosed-reference") {
    return `${path} has no plain-language term for ${issue.referenceIds
      .map((id) => `"${id}"`)
      .join(", ")}. A declaration must not show a visitor a bare identifier.`;
  }
  if (issue.kind === "blank-term-label") {
    return `${path} gives an empty label for "${issue.referenceId}".`;
  }
  return `${path} describes "${issue.referenceId}", which the policy never references.`;
}

function unreadableDocument(path: string): RejectedPolicyDocument {
  return { detail: `${path} is not a readable policy document.`, ok: false };
}

async function loadPolicySnapshot(
  ports: PolicyCommandPorts,
  path: string,
): Promise<PolicyDocumentResult> {
  let raw: string;
  try {
    raw = await ports.fileSystem.readFile(path);
  } catch {
    return unreadableDocument(path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadableDocument(path);
  }
  const document = asRecord(parsed);
  if (document === undefined) return unreadableDocument(path);
  const catalogueRevision = document["catalogueRevision"];
  const policyVersion = document["policyVersion"];
  const policy = asRecord(document["policy"]);
  if (
    typeof catalogueRevision !== "string" ||
    typeof policyVersion !== "string" ||
    policy === undefined
  ) {
    return unreadableDocument(path);
  }
  const defined = definePolicy(policy as unknown as PolicyDefinition);
  if (!defined.ok) return unreadableDocument(path);
  const snapshot = createPolicySnapshot({
    catalogueRevision,
    policy: defined.policy,
    policyVersion,
  });
  const rawTerms = document["terms"];
  let terms: PolicyTerms | undefined;
  if (rawTerms !== undefined) {
    const declared = asRecord(rawTerms);
    if (declared === undefined) return unreadableDocument(path);
    const resolved = declarePolicyTerms(snapshot, declared as PolicyTerms);
    if (!resolved.ok) {
      return {
        detail: describeDisclosureIssue(
          path,
          resolved.issue,
          asRecord(document["policy"])?.["categories"],
        ),
        ok: false,
      };
    }
    terms = resolved.terms;
  }
  const termsField = terms === undefined ? {} : { terms };

  const rawBases = document["lawfulBases"];
  if (rawBases === undefined) return { ok: true, snapshot, ...termsField };
  const record = asRecord(rawBases);
  if (record === undefined) return unreadableDocument(path);
  if (Object.values(record).some((basis) => typeof basis !== "string")) {
    return unreadableDocument(path);
  }
  const bases = definePolicyLawfulBases(snapshot, record as PolicyLawfulBases);
  if (!bases.ok) {
    return {
      detail:
        bases.issue.kind === "unknown-purpose-basis"
          ? `${path} gives a lawful basis for "${bases.issue.purposeId}", which the policy does not define.`
          : `${path} gives an empty lawful basis for "${bases.issue.purposeId}".`,
      ok: false,
    };
  }
  return { lawfulBases: bases.lawfulBases, ok: true, snapshot, ...termsField };
}

/** Six months, the duration a project starts with. */
const DEFAULT_CONSENT_DURATION = "180 * 24 * 60 * 60 * 1000";

/**
 * Keeps the consent duration a project already chose.
 *
 * The generated configuration imports this value from the policy module, so it
 * has to survive an install: dropping it would stop the project building, and
 * resetting it would silently change how long every visitor's choice lasts.
 */
function consentDuration(previous: string | undefined): string {
  const existing = /^export const consentDurationMs = .+;$/mu.exec(
    previous ?? "",
  );
  return `${existing?.[0] ?? `export const consentDurationMs = ${DEFAULT_CONSENT_DURATION};`}\n`;
}

/** Whether a file is a policy module that init or install wrote. */
function isPolicyModule(content: string): boolean {
  return content.includes("opencookie policy install");
}

/** What an installed policy document names as its writer. */
const INSTALLED_POLICY_GENERATOR = "opencookie policy install";

/** Whether install writes JSON rather than a module to this path. @internal */
export function isJsonPath(path: string): boolean {
  return /\.json$/iu.test(path);
}

/**
 * Where install records each path it wrote, so doctor checks a policy
 * installed with --out as well as the default module. @internal
 */
export const INSTALLED_POLICIES_RECORD_PATH =
  "opencookie/installed-policies.json";

/** The paths install has written, as recorded; unreadable reads as none. @internal */
export async function readInstalledPolicyPaths(
  fileSystem: FileSystemPort,
): Promise<readonly string[]> {
  if (!(await fileSystem.exists(INSTALLED_POLICIES_RECORD_PATH))) return [];
  try {
    const parsed: unknown = JSON.parse(
      await fileSystem.readFile(INSTALLED_POLICIES_RECORD_PATH),
    );
    const installs = asRecord(parsed)?.["installs"];
    return Array.isArray(installs)
      ? installs.filter((path): path is string => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

async function recordInstalledPolicyPath(
  fileSystem: FileSystemPort,
  path: string,
): Promise<void> {
  const recorded = await readInstalledPolicyPaths(fileSystem);
  if (recorded.includes(path)) return;
  const content = `${JSON.stringify({ installs: [...recorded, path] }, undefined, 2)}\n`;
  if (await fileSystem.exists(INSTALLED_POLICIES_RECORD_PATH)) {
    await fileSystem.replaceFile(
      INSTALLED_POLICIES_RECORD_PATH,
      await fileSystem.readFile(INSTALLED_POLICIES_RECORD_PATH),
      content,
    );
  } else {
    await fileSystem.mkdir(parentDirectory(INSTALLED_POLICIES_RECORD_PATH));
    await fileSystem.writeFile(INSTALLED_POLICIES_RECORD_PATH, content);
  }
}

/**
 * The document install wrote to a JSON path, if the file is one.
 *
 * Only a parsed document that names install as its writer counts: a manifest
 * that merely quotes the command in a script is the project's own file.
 */
export function installedPolicyDocument(
  content: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const document = asRecord(parsed);
  return document?.["generatedBy"] === INSTALLED_POLICY_GENERATOR &&
    typeof document["publicationId"] === "string"
    ? document
    : undefined;
}

/** The site a generated policy module says it belongs to, if any. @internal */
export function moduleSite(content: string): string | undefined {
  return /^\/\/ Generated by opencookie policy install from publication \S+ for site ([a-z0-9-]+)\.$/mu.exec(
    content,
  )?.[1];
}

/** Whether a file is a cookie declaration that this command wrote. */
function isPolicyDeclaration(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as {
      publicationId?: unknown;
      sections?: unknown;
    } | null;
    return (
      typeof parsed?.publicationId === "string" &&
      Array.isArray(parsed.sections)
    );
  } catch {
    return false;
  }
}

/** Where `opencookie policy starter` writes a policy an operator can edit. @public */
export const STARTER_POLICY_PATH = "opencookie/policy.json";

/**
 * A policy document that publishing accepts as it stands.
 *
 * A stranger following the documentation has to reach a published policy
 * without authoring a catalogue by hand, so this is deliberately complete
 * rather than a sketch: one necessary purpose, one optional purpose, and plain
 * language for every identifier a declaration would show. It describes what a
 * site typically does, and the operator edits the wording to match theirs.
 */
function starterPolicyDocument(): string {
  const term = (label: string, description: string): object => ({
    description,
    label,
  });
  return `${JSON.stringify(
    {
      catalogueRevision: "catalogue-1",
      policy: {
        categories: [
          {
            id: "necessary",
            label: "Necessary",
            purposeIds: ["strictly-necessary"],
          },
          { id: "optional", label: "Optional", purposeIds: ["analytics"] },
        ],
        dataCategories: [{ id: "session-state" }, { id: "usage-data" }],
        operations: [{ id: "keep-the-site-working" }, { id: "measurement" }],
        presentationRootCategoryIds: ["necessary", "optional"],
        providers: [{ id: "site-operator" }],
        purposes: [
          {
            dataCategoryIds: ["session-state"],
            disclosure:
              "Keeps the site working, for example remembering that you are signed in.",
            id: "strictly-necessary",
            label: "Strictly necessary",
            operationIds: ["keep-the-site-working"],
            providerIds: ["site-operator"],
            recipientIds: ["site-operator"],
            retentionIds: ["until-the-visit-ends"],
          },
          {
            dataCategoryIds: ["usage-data"],
            disclosure:
              "Counts visits so we can see which pages are read. Off unless you allow it.",
            id: "analytics",
            label: "Analytics",
            operationIds: ["measurement"],
            providerIds: ["site-operator"],
            recipientIds: ["site-operator"],
            retentionIds: ["thirteen-months"],
          },
        ],
        recipients: [{ id: "site-operator" }],
        retentions: [{ id: "thirteen-months" }, { id: "until-the-visit-ends" }],
      },
      policyVersion: "1.0.0",
      terms: {
        analytics: term("Analytics", "Measuring how the site is used."),
        "keep-the-site-working": term(
          "Keeping the site working",
          "Operating the site you asked for.",
        ),
        measurement: term("Measurement", "Counting visits and pages."),
        "session-state": term(
          "Session state",
          "What the site needs to remember while you are here.",
        ),
        "site-operator": term("This site", "The operator of this site."),
        "strictly-necessary": term(
          "Strictly necessary",
          "Needed for the site to work.",
        ),
        "thirteen-months": term("Thirteen months", "Kept for thirteen months."),
        "until-the-visit-ends": term(
          "Until the visit ends",
          "Removed when you leave.",
        ),
        "usage-data": term("Usage data", "Which pages are opened, in total."),
      },
    },
    undefined,
    2,
  )}\n`;
}

/** Where a project keeps the policy module its runtime enforces. @public */
export const INSTALLED_POLICY_PATH = "opencookie.policy.ts";

/**
 * Renders the published policy as the module a project's runtime imports.
 *
 * The definition is embedded exactly as it was published rather than rebuilt
 * from parts, so the runtime enforces the published policy itself and not a
 * copy that has drifted from it. The file is generated, so it says so and names
 * the publication it came from.
 */
function policyModule(
  publication: PolicyPublication,
  previous: string | undefined,
  site: string | undefined,
): string {
  const { snapshot } = publication;
  // The history refuses unsafe ids; this guards the one place an id becomes
  // source, since no escaping makes a line comment safe.
  if (!isPublicationId(publication.publicationId)) {
    throw new Error(
      "Refusing to generate a module from an unsafe publication id.",
    );
  }
  return `// Generated by opencookie policy install from publication ${publication.publicationId}${site === undefined ? "" : ` for site ${site}`}.
// Re-run that command after publishing; edits here are replaced.
import { definePolicy } from "@opencookie-dev/core";

${consentDuration(previous)}
export const catalogueRevision = ${JSON.stringify(snapshot.catalogueRevision)};
export const policyVersion = ${JSON.stringify(snapshot.policyVersion)};

const result = definePolicy(${JSON.stringify(snapshot.policy, undefined, 2)});

if (!result.ok) {
  throw new Error("The installed OpenCookie policy is invalid.");
}

export const openCookiePolicy = result.policy;
`;
}

/**
 * Renders the published policy as JSON for an integration that builds its own
 * runtime with `bootstrapOpenCookie({ installedPolicy })`.
 *
 * The digests are the ones the publication recorded, so the bootstrap can
 * refuse a policy that no longer derives them, and a bundle that reads them
 * keeps them as literals that `opencookie doctor --bundle` can find.
 */
function policyJson(
  publication: PolicyPublication,
  site: string | undefined,
): string {
  const { snapshot } = publication;
  return `${JSON.stringify(
    {
      generatedBy: INSTALLED_POLICY_GENERATOR,
      publicationId: publication.publicationId,
      ...(site === undefined ? {} : { site }),
      policyVersion: snapshot.policyVersion,
      catalogueRevision: snapshot.catalogueRevision,
      catalogueDigest: snapshot.catalogueDigest,
      decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
      policy: snapshot.policy,
    },
    undefined,
    2,
  )}\n`;
}

/**
 * Says how a candidate declaration differs from the published one.
 *
 * The comparison is on what a visitor is shown, not on the stored document, so
 * a rewritten catalogue that says the same things reports no change.
 */
function comparePurposes(
  live: PolicyDeclaration,
  candidate: PolicyDeclaration,
): readonly string[] {
  const shown = (declaration: PolicyDeclaration): Map<string, string> =>
    new Map(
      declaration.sections
        .flatMap((section) => section.purposes)
        .map((purpose) => [
          purpose.id,
          `${purpose.label}\u001f${purpose.disclosure}\u001f${purpose.lawfulBasis ?? ""}\u001f${JSON.stringify(purpose.translations ?? [])}`,
        ]),
    );
  const before = shown(live);
  const after = shown(candidate);
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.entries()]
    .filter(([id, value]) => before.has(id) && before.get(id) !== value)
    .map(([id]) => id)
    .sort();
  const lines = [
    `Against the live publication ${live.publicationId} (policy version ${live.policyVersion}):`,
  ];
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    lines.push("  no change to what a visitor is shown.");
    return lines;
  }
  if (added.length > 0) lines.push(`  adds ${added.join(", ")}`);
  if (removed.length > 0) lines.push(`  removes ${removed.join(", ")}`);
  if (changed.length > 0) lines.push(`  changes ${changed.join(", ")}`);
  return lines;
}

/**
 * Runs `opencookie policy status|publish|rollback` against the project store.
 *
 * Every path reports what is true: an unreadable store is refused rather than
 * replaced, and nothing is announced as published unless the store accepted it.
 *
 * @public
 */
export function runPolicyCommand(
  ports: PolicyCommandPorts,
  args: readonly string[],
): Promise<PolicyCommandResult> {
  return refusingMissingFlagValues(() => run(ports, args), failure, args, {
    declaration: ["--out"],
    install: ["--out"],
    preview: ["--id", "--policy"],
    publish: ["--id", "--policy"],
    rollback: ["--id", "--to"],
    starter: ["--out"],
  });
}

async function run(
  ports: PolicyCommandPorts,
  args: readonly string[],
): Promise<PolicyCommandResult> {
  const subcommand = args[0];

  if (subcommand === "status") {
    const stored = await readPolicyPublicationLog(
      ports.fileSystem,
      POLICY_PUBLICATION_STORE_PATH,
    );
    if (!stored.ok) {
      return failure(
        "The published policy history failed its integrity check and was not read.",
      );
    }
    const current = currentPolicyPublication(stored.log);
    if (current === undefined) {
      ports.writeLine("No policy is published.");
      return { ok: true };
    }
    ports.writeLine(
      `Current publication: ${current.publicationId} (policy version ${current.snapshot.policyVersion}).`,
    );
    return { ok: true };
  }

  if (subcommand === "publish") {
    const publicationId = readFlag(args, "--id");
    const policyPath = readFlag(args, "--policy");
    if (publicationId === undefined || policyPath === undefined) {
      return failure(
        "publish requires --id <publication> and --policy <file>.",
      );
    }
    const loaded = await loadPolicySnapshot(ports, policyPath);
    if (!loaded.ok) return failure(loaded.detail);
    const { snapshot } = loaded;
    const published = await publishPolicyToStore(ports.fileSystem, {
      ...(loaded.lawfulBases === undefined
        ? {}
        : { lawfulBases: loaded.lawfulBases }),
      path: POLICY_PUBLICATION_STORE_PATH,
      publicationId,
      snapshot,
      ...(loaded.terms === undefined ? {} : { terms: loaded.terms }),
    });
    if (!published.ok) {
      return failure(
        published.issue.kind === "unreadable-store"
          ? "The published policy history failed its integrity check, so nothing was written."
          : published.issue.reason === "changed-policy-same-version"
            ? `The publication was refused: policy version ${snapshot.policyVersion} is already live with a different policy. Publish the change under a new policy version, so visitors are asked again.`
            : `The publication was refused: ${published.issue.reason}.`,
      );
    }
    ports.writeLine(
      `Published ${published.publication.publicationId} (policy version ${snapshot.policyVersion}).`,
    );
    return { ok: true };
  }

  if (subcommand === "preview") {
    const policyPath = readFlag(args, "--policy");
    if (policyPath === undefined) {
      return failure("preview requires --policy <file>.");
    }
    const loaded = await loadPolicySnapshot(ports, policyPath);
    if (!loaded.ok) return failure(loaded.detail);
    const candidate: PolicyPublication = {
      ...(loaded.lawfulBases === undefined
        ? {}
        : { lawfulBases: loaded.lawfulBases }),
      publicationId: readFlag(args, "--id") ?? "(not published)",
      snapshot: loaded.snapshot,
      ...(loaded.terms === undefined ? {} : { terms: loaded.terms }),
    };
    const declaration = buildPolicyDeclaration(candidate);
    ports.writeLine(
      `Preview of ${policyPath}: policy version ${declaration.policyVersion}, catalogue ${declaration.catalogueRevision}. Nothing was written.`,
    );
    for (const section of declaration.sections) {
      // A heading shows its label, or its id when it has none, in each
      // language the policy carries.
      if (section.categoryId !== null) {
        ports.writeLine(section.categoryLabel ?? section.categoryId);
        for (const { label, locale } of section.categoryTranslations ?? []) {
          ports.writeLine(`  ${locale}: ${label}`);
        }
      }
      for (const purpose of section.purposes) {
        ports.writeLine(
          `  ${purpose.id}: ${purpose.label}${purpose.lawfulBasis === undefined ? "" : ` [${purpose.lawfulBasis}]`}`,
        );
        ports.writeLine(`    "${purpose.disclosure}"`);
        for (const { disclosure, label, locale } of purpose.translations ??
          []) {
          ports.writeLine(`    ${locale}: ${label} "${disclosure}"`);
        }
      }
    }
    const stored = await readPolicyPublicationLog(
      ports.fileSystem,
      POLICY_PUBLICATION_STORE_PATH,
    );
    if (!stored.ok) {
      return failure(
        "The published policy history failed its integrity check and was not read.",
      );
    }
    const current = currentPolicyPublication(stored.log);
    if (current === undefined) {
      ports.writeLine(
        "No policy is published, so every purpose above would be new to visitors.",
      );
      return { ok: true };
    }
    const live = buildPolicyDeclaration(current);
    for (const line of comparePurposes(live, declaration)) {
      ports.writeLine(line);
    }
    return { ok: true };
  }

  if (subcommand === "starter") {
    const outputPath = readFlag(args, "--out") ?? STARTER_POLICY_PATH;
    if (await ports.fileSystem.exists(outputPath)) {
      return failure(
        `${outputPath} already exists, so nothing was written. Pass --out to write the starter somewhere else.`,
      );
    }
    const parent = parentDirectory(outputPath);
    if (parent !== "") await ports.fileSystem.mkdir(parent);
    await ports.fileSystem.writeFile(outputPath, starterPolicyDocument());
    ports.writeLine(
      `Wrote a starter policy to ${outputPath}. Edit its wording, then publish it with \`opencookie policy publish --id <publication> --policy ${outputPath}\`.`,
    );
    return { ok: true };
  }

  if (subcommand === "install") {
    const outputPath = readFlag(args, "--out") ?? INSTALLED_POLICY_PATH;
    const stored = await readPolicyPublicationLog(
      ports.fileSystem,
      POLICY_PUBLICATION_STORE_PATH,
    );
    if (!stored.ok) {
      return failure(
        "The published policy history failed its integrity check and was not read.",
      );
    }
    const current = currentPolicyPublication(stored.log);
    if (current === undefined) {
      return failure("No policy is published, so there is nothing to install.");
    }
    const plainHtml = await plainHtmlPolicyVersions(ports.fileSystem);
    if (plainHtml !== undefined) {
      return failure(
        `${plainHtmlLimitation(plainHtml)} Installing ${current.publicationId} (policy version ${current.snapshot.policyVersion}) would change nothing a visitor decides on, so nothing was written.`,
      );
    }
    const missing = await purposesMissingForConfiguration(
      ports.fileSystem,
      current.snapshot.policy.purposes.map((purpose) => purpose.id),
    );
    if (missing.length > 0) {
      return failure(
        `${CONFIGURATION_PATH} binds resources to ${missing.join(", ")}, which publication ${current.publicationId} does not declare, so the application would fail to load with it. Publish a policy that declares ${missing.length === 1 ? "that purpose" : "those purposes"}, or change the resources in ${CONFIGURATION_PATH}. ${outputPath} was not changed.`,
      );
    }
    // A JSON path gets the document a custom integration reads; any other
    // path gets the module the generated configuration imports.
    const json = isJsonPath(outputPath);
    const render = (previous: string | undefined): string =>
      json
        ? policyJson(current, ports.site)
        : policyModule(current, previous, ports.site);
    const parent = parentDirectory(outputPath);
    if (parent !== "") await ports.fileSystem.mkdir(parent);
    if (await ports.fileSystem.exists(outputPath)) {
      const previous = await ports.fileSystem.readFile(outputPath);
      const installedJson = json
        ? installedPolicyDocument(previous)
        : undefined;
      if (json ? installedJson === undefined : !isPolicyModule(previous)) {
        return failure(
          `${outputPath} is not ${json ? "an installed policy" : "a policy module"} OpenCookie wrote, so it was not replaced. Pass --out to install somewhere else.`,
        );
      }
      const recordedSite = installedJson?.["site"];
      const owner = json
        ? typeof recordedSite === "string"
          ? recordedSite
          : undefined
        : moduleSite(previous);
      if (owner !== undefined && owner !== ports.site) {
        return failure(
          `${outputPath} holds the policy of site ${owner}, so installing ${ports.site === undefined ? "this project's" : `site ${ports.site}'s`} policy would change what ${owner} enforces. Pass --out to install it into its own ${json ? "file" : "module"}. Nothing was written.`,
        );
      }
      await ports.fileSystem.replaceFile(
        outputPath,
        previous,
        render(previous),
      );
    } else {
      await ports.fileSystem.writeFile(outputPath, render(undefined));
    }
    await recordInstalledPolicyPath(ports.fileSystem, outputPath);
    ports.writeLine(
      `Installed ${current.publicationId} (policy version ${current.snapshot.policyVersion}) into ${outputPath}.`,
    );
    return { ok: true };
  }

  if (subcommand === "rollback") {
    const publicationId = readFlag(args, "--id");
    const restoreFrom = readFlag(args, "--to");
    if (publicationId === undefined || restoreFrom === undefined) {
      return failure(
        "rollback requires --id <publication> and --to <publication>.",
      );
    }
    const rolledBack = await rollbackPolicyInStore(ports.fileSystem, {
      path: POLICY_PUBLICATION_STORE_PATH,
      publicationId,
      restoreFrom,
    });
    if (!rolledBack.ok) {
      return failure(
        rolledBack.issue.kind === "unreadable-store"
          ? "The published policy history failed its integrity check, so nothing was written."
          : `The rollback was refused: ${rolledBack.issue.reason}.`,
      );
    }
    ports.writeLine(
      `Rolled back to ${restoreFrom} as ${rolledBack.publication.publicationId}.`,
    );
    return { ok: true };
  }

  if (subcommand === "declaration") {
    const stored = await readPolicyPublicationLog(
      ports.fileSystem,
      POLICY_PUBLICATION_STORE_PATH,
    );
    if (!stored.ok) {
      return failure(
        "The published policy history failed its integrity check and was not read.",
      );
    }
    const current = currentPolicyPublication(stored.log);
    if (current === undefined) {
      return failure("No policy is published, so there is nothing to declare.");
    }
    const outputPath = readFlag(args, "--out") ?? POLICY_DECLARATION_PATH;
    const declaration = `${JSON.stringify(buildPolicyDeclaration(current), undefined, 2)}\n`;
    const parent = parentDirectory(outputPath);
    if (parent !== "") await ports.fileSystem.mkdir(parent);
    if (await ports.fileSystem.exists(outputPath)) {
      const previous = await ports.fileSystem.readFile(outputPath);
      if (!isPolicyDeclaration(previous)) {
        return failure(
          `${outputPath} is not a cookie declaration OpenCookie wrote, so it was not replaced. Pass --out to write it somewhere else.`,
        );
      }
      await ports.fileSystem.replaceFile(outputPath, previous, declaration);
    } else {
      await ports.fileSystem.writeFile(outputPath, declaration);
    }
    ports.writeLine(
      `Wrote the cookie declaration for ${current.publicationId} to ${outputPath}.`,
    );
    return { ok: true };
  }

  return failure(`Unknown policy command: ${subcommand ?? ""}`.trim());
}
