import type { FileSystemPort } from "./contracts.js";
import {
  emptySiteRegistry,
  registerSite,
  siteDirectory,
  type Site,
  type SiteRegistrationIssue,
  type SiteRegistry,
} from "./site-registry.js";
import {
  MissingFlagValueError,
  readFlag,
  readRepeatedFlag,
  refusingMissingFlagValues,
} from "./flags.js";

/** Where the sites an operator manages from this project are registered. @public */
export const SITE_REGISTRY_PATH = "opencookie/sites.json";

const DATA_DIRECTORY = "opencookie";
const STORE_VERSION = 1;
const UNREADABLE = `${SITE_REGISTRY_PATH} failed validation, so nothing was changed. Restore it from a backup rather than deleting it.`;

/** Ports the sites command needs. @public */
export interface SitesCommandPorts {
  readonly fileSystem: FileSystemPort;
  readonly writeLine: (line: string) => void;
}

/** @public */
export interface SitesCommandResult {
  readonly message?: string;
  readonly ok: boolean;
}

/** @public */
export type OpenSiteResult =
  | { readonly message: string; readonly ok: false }
  | {
      readonly fileSystem: FileSystemPort;
      readonly ok: true;
      readonly site: Site;
    };

interface StoredRegistry {
  readonly raw: string | undefined;
  readonly registry: SiteRegistry;
}

function failure(message: string): SitesCommandResult {
  return { message, ok: false };
}

function dataDirectory(name: string): string {
  return `${DATA_DIRECTORY}/${siteDirectory(name)}`;
}

function describeIssue(issue: SiteRegistrationIssue): string {
  switch (issue.kind) {
    case "domain-claimed":
      return `${issue.domain} already belongs to the site ${issue.owner}; a domain belongs to exactly one site.`;
    case "duplicate-site":
      return `A site named ${issue.name} is already registered.`;
    case "invalid-domain":
      return `${issue.domain} is not a bare hostname. Give it without a scheme, port or path, and an internationalized name in its xn-- form.`;
    case "invalid-site-name":
      return `"${issue.name}" is not a valid site name: use lowercase letters, digits and hyphens, at most 63 characters, starting with a letter or digit.`;
    case "no-domains":
      return "add requires at least one --domain <hostname>.";
  }
}

/**
 * Reads the registry, re-validating every site it holds.
 *
 * Each stored site is registered again from scratch, so a hand-edited file
 * that gives one domain to two sites is refused rather than trusted.
 */
async function readRegistry(
  fileSystem: FileSystemPort,
): Promise<StoredRegistry | undefined> {
  if (!(await fileSystem.exists(SITE_REGISTRY_PATH))) {
    return { raw: undefined, registry: emptySiteRegistry() };
  }
  const raw = await fileSystem.readFile(SITE_REGISTRY_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const document = parsed as { sites?: unknown; version?: unknown } | null;
  if (
    document === null ||
    typeof document !== "object" ||
    document.version !== STORE_VERSION ||
    !Array.isArray(document.sites)
  ) {
    return undefined;
  }
  let registry = emptySiteRegistry();
  for (const entry of document.sites as unknown[]) {
    const site = entry as { domains?: unknown; name?: unknown } | null;
    if (
      site === null ||
      typeof site !== "object" ||
      typeof site.name !== "string" ||
      !Array.isArray(site.domains) ||
      !site.domains.every((domain) => typeof domain === "string")
    ) {
      return undefined;
    }
    const registered = registerSite(registry, {
      domains: site.domains,
      name: site.name,
    });
    if (!registered.ok) return undefined;
    registry = registered.registry;
  }
  return { raw, registry };
}

async function persist(
  fileSystem: FileSystemPort,
  previous: string | undefined,
  registry: SiteRegistry,
): Promise<void> {
  const document = `${JSON.stringify({ sites: registry.sites, version: STORE_VERSION }, null, 2)}\n`;
  if (previous === undefined) {
    await fileSystem.writeFile(SITE_REGISTRY_PATH, document);
    return;
  }
  await fileSystem.replaceFile(SITE_REGISTRY_PATH, previous, document);
}

/**
 * Remaps the OpenCookie data directory to one site's own directory.
 *
 * Every path inside `opencookie/`, which holds the policy, findings and
 * evidence stores and their locks, is redirected to the site's directory, so a
 * store added later is isolated per site without being listed here. Any other
 * path, such as a file the operator passes to import, is left where they
 * named it.
 */
function scopeToSite(fileSystem: FileSystemPort, name: string): FileSystemPort {
  const root = dataDirectory(name);
  const map = (path: string): string => {
    if (path === DATA_DIRECTORY) return root;
    return path.startsWith(`${DATA_DIRECTORY}/`)
      ? `${root}/${path.slice(DATA_DIRECTORY.length + 1)}`
      : path;
  };
  return {
    exists: (path) => fileSystem.exists(map(path)),
    mkdir: (path) => fileSystem.mkdir(map(path)),
    readFile: (path) => fileSystem.readFile(map(path)),
    replaceFile: (path, expectedContent, content) =>
      fileSystem.replaceFile(map(path), expectedContent, content),
    withLock: (path, operation) => fileSystem.withLock(map(path), operation),
    writeFile: (path, content, options) =>
      fileSystem.writeFile(map(path), content, options),
  };
}

/**
 * Opens one registered site, returning a file system whose OpenCookie data
 * directory is that site's own.
 *
 * Every operator command run through it reads and writes only that site's
 * policy, findings and evidence.
 *
 * @public
 */
export async function openSite(
  fileSystem: FileSystemPort,
  name: string,
): Promise<OpenSiteResult> {
  const stored = await readRegistry(fileSystem);
  if (stored === undefined) return { message: UNREADABLE, ok: false };
  const site = stored.registry.sites.find(
    (candidate) => candidate.name === name,
  );
  if (site === undefined) {
    const known = stored.registry.sites.map((candidate) => candidate.name);
    return {
      message:
        known.length === 0
          ? `No site named ${name} is registered, and no sites are. Register it with opencookie sites add --name ${name} --domain <hostname>.`
          : `No site named ${name} is registered. Registered sites: ${known.join(", ")}.`,
      ok: false,
    };
  }
  return { fileSystem: scopeToSite(fileSystem, name), ok: true, site };
}

/** @public */
export type SelectSiteResult =
  | { readonly message: string; readonly ok: false }
  | {
      readonly args: readonly string[];
      readonly fileSystem: FileSystemPort;
      readonly ok: true;
      readonly site: Site | undefined;
    };

/**
 * Chooses the data a command works on from its `--site <name>` flag.
 *
 * In a project with no registered sites, a command without the flag works on
 * the project's own data. Once sites are registered, the flag is required, so
 * nothing is written where no site's query would find it. With the flag, the
 * command works on that site only, and the flag is removed from the arguments
 * passed on. A missing or unregistered name is refused rather than falling
 * back, so one site's data can never be written where another would read it.
 *
 * A path that already points inside the sites directory is refused too. It
 * would be mapped a second time, and the operator would be told a file they can
 * see is unreadable.
 *
 * @public
 */
export async function selectSite(
  fileSystem: FileSystemPort,
  args: readonly string[],
): Promise<SelectSiteResult> {
  const index = args.findIndex(
    (argument) => argument === "--site" || argument.startsWith("--site="),
  );
  if (index === -1) {
    const stored = await readRegistry(fileSystem);
    if (stored === undefined) return { message: UNREADABLE, ok: false };
    const names = stored.registry.sites.map((site) => site.name);
    if (names.length > 0) {
      return {
        message: `This project manages the sites ${names.join(", ")}. Pass --site <name> to choose the one this command works on.`,
        ok: false,
      };
    }
    return { args, fileSystem, ok: true, site: undefined };
  }
  let name: string | undefined;
  try {
    name = readFlag(args, "--site");
  } catch (error) {
    if (!(error instanceof MissingFlagValueError)) throw error;
  }
  if (name === undefined) {
    return { message: "--site requires a site name.", ok: false };
  }
  const opened = await openSite(fileSystem, name);
  if (!opened.ok) return opened;
  const doubled = args.find((argument) =>
    argument.startsWith(`${DATA_DIRECTORY}/sites/`),
  );
  if (doubled !== undefined) {
    return {
      message: `${doubled} is already inside a site's directory. With --site ${name}, a path under ${DATA_DIRECTORY}/ means that site's own, so write ${DATA_DIRECTORY}/${doubled.slice(`${DATA_DIRECTORY}/sites/`.length).split("/").slice(1).join("/")} instead.`,
      ok: false,
    };
  }
  return {
    args: [
      ...args.slice(0, index),
      ...args.slice(index + (args[index] === "--site" ? 2 : 1)),
    ],
    fileSystem: opened.fileSystem,
    ok: true,
    site: opened.site,
  };
}

/**
 * Runs `opencookie sites add` or `opencookie sites list`.
 *
 * @public
 */
export function runSitesCommand(
  ports: SitesCommandPorts,
  args: readonly string[],
): Promise<SitesCommandResult> {
  return refusingMissingFlagValues(() => run(ports, args), failure, args, {
    add: ["--name", "--domain"],
  });
}

async function run(
  ports: SitesCommandPorts,
  args: readonly string[],
): Promise<SitesCommandResult> {
  const [subcommand] = args;
  const { fileSystem } = ports;

  if (subcommand === "add") {
    const name = readFlag(args, "--name");
    if (name === undefined) return failure("add requires --name <site>.");
    const domains = readRepeatedFlag(args, "--domain");
    await fileSystem.mkdir(DATA_DIRECTORY);
    return fileSystem.withLock(`${SITE_REGISTRY_PATH}.lock`, async () => {
      const stored = await readRegistry(fileSystem);
      if (stored === undefined) return failure(UNREADABLE);
      const registered = registerSite(stored.registry, { domains, name });
      if (!registered.ok) return failure(describeIssue(registered.issue));
      await persist(fileSystem, stored.raw, registered.registry);
      ports.writeLine(
        `Registered ${name}. Its policy, findings and evidence live in ${dataDirectory(name)}; pass --site ${name} to work on it.`,
      );
      return { ok: true };
    });
  }

  if (subcommand === "list") {
    const stored = await readRegistry(fileSystem);
    if (stored === undefined) return failure(UNREADABLE);
    if (stored.registry.sites.length === 0) {
      ports.writeLine("No sites are registered.");
      return { ok: true };
    }
    for (const site of stored.registry.sites) {
      ports.writeLine(
        `${site.name}  ${site.domains.join(", ")}  (${dataDirectory(site.name)})`,
      );
    }
    return { ok: true };
  }

  return failure(`Unknown sites command: ${subcommand ?? ""}`.trim());
}
