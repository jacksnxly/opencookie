import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { initializeProject } from "./init.js";
import { createNodeCliPorts, createNodeFileSystem } from "./node.js";
import { runFindingsCommand } from "./findings-command.js";
import { runPolicyCommand } from "./policy-command.js";
import { doctorOptions, runDoctor } from "./doctor.js";
import { runEvidenceCommand } from "./evidence-command.js";
import { createSignInLimiter } from "./operator-server.js";
import { createMemorySessionStore } from "./operator-session.js";
import { planServe, serveGreeting } from "./serve-command.js";
import { startOperatorConsole } from "./serve-node.js";
import { projectDirectory } from "./flags.js";
import { runSitesCommand, selectSite } from "./sites-command.js";
import { terminalSafe } from "./terminal-text.js";
import type { FileSystemPort } from "./contracts.js";

function resolveVanillaPackageEntrypoint(): string {
  return import.meta.resolve("@opencookie-dev/vanilla");
}

interface ParsedArguments {
  readonly help: boolean;
  readonly projectRoot: string;
  readonly selfHost: boolean;
  readonly yes: boolean;
}

function usage(): string {
  return [
    "Usage: opencookie init [--yes] [--self-host] [--cwd <directory>]",
    "       opencookie policy status [--cwd <directory>]",
    "       opencookie policy starter [--out <file>] [--cwd <directory>]",
    "       opencookie policy preview --policy <file> [--id <publication>] [--cwd <directory>]",
    "       opencookie policy publish --id <publication> --policy <file> [--cwd <directory>]",
    "       opencookie policy rollback --id <publication> --to <publication> [--cwd <directory>]",
    "       opencookie policy declaration [--out <file>] [--cwd <directory>]",
    "       opencookie policy install [--out <file>] [--cwd <directory>]",
    "       opencookie findings import --from <file> [--cwd <directory>]",
    "       opencookie findings list [--cwd <directory>]",
    "       opencookie findings classify --name <finding> --kind <kind> --purpose <id> --vendor <vendor> --service <service> --category <category> --disclosure <text> --retention <retention> --cleanup <deleted|expires|reblocked> [--necessary]",
    "       opencookie findings draft-policy [--cwd <directory>]",
    "       opencookie findings scan --html <file> --page <url> [--cwd <directory>]",
    "       opencookie findings session --har <file> [--browser <name>] [--same-origin] [--cwd <directory>]",
    "       opencookie findings check --har <file> [--browser <name>] [--cwd <directory>]",
    "       opencookie findings storage --from <file> --browser <name> [--cwd <directory>]",
    "       opencookie doctor [--bundle <file>]... [--cwd <directory>]",
    "       opencookie evidence ingest --from <file> [--cwd <directory>]",
    "       opencookie evidence query [--consent-id <id>] [--since <date>] [--until <date>]",
    "       opencookie evidence export --out <file> [--consent-id <id>] [--since <date>] [--until <date>]",
    "       opencookie evidence delete --consent-id <id> [--cwd <directory>]",
    "       opencookie evidence retain --days <n> [--cwd <directory>]",
    "       opencookie sites add --name <site> --domain <hostname> [--domain <hostname>]",
    "       opencookie sites list [--cwd <directory>]",
    "       opencookie serve [--host <address>] [--port <number>] [--behind-proxy] [--cwd <directory>]",
    "",
    "Options:",
    "  -y, --yes        Apply the detected plan without prompting",
    "  --self-host      Copy the installed browser bundle for plain HTML",
    "  --cwd <path>     Initialize a project other than the current directory",
    "  --site <name>    Run policy, findings, evidence or doctor on one registered site",
    "  --bundle <file>  With doctor, say which publication a built bundle carries",
    "  -h, --help       Show this help",
  ].join("\n");
}

interface SubcommandPorts {
  readonly fileSystem: FileSystemPort;
  readonly site?: string;
  readonly writeLine: (line: string) => void;
}

/**
 * Resolves an operator subcommand to its runner.
 *
 * `doctor` takes no subcommand of its own. Its only option is `--bundle`, and
 * any other argument is refused rather than silently ignored.
 */
function commandRunner(
  command: string,
): (
  ports: SubcommandPorts,
  args: readonly string[],
) => Promise<{ readonly message?: string; readonly ok: boolean }> {
  if (command === "policy") return runPolicyCommand;
  if (command === "findings") return runFindingsCommand;
  if (command === "sites") return runSitesCommand;
  if (command === "evidence") {
    return (ports, args) =>
      runEvidenceCommand({ ...ports, now: Date.now }, args);
  }
  return async (ports, args) => {
    const parsed = doctorOptions(args);
    return parsed.ok
      ? { ok: (await runDoctor(ports, parsed.options)).ok }
      : parsed;
  };
}

/** Parses CLI arguments without reading process globals. @public */
export function parseCliArguments(
  args: readonly string[],
  currentDirectory: string,
): ParsedArguments {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      help: true,
      projectRoot: currentDirectory,
      selfHost: false,
      yes: false,
    };
  }
  if (args[0] !== "init") {
    throw new Error("Expected the init command.\n\n" + usage());
  }

  let projectRoot = currentDirectory;
  let selfHost = false;
  let yes = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--yes" || argument === "-y") {
      yes = true;
    } else if (argument === "--self-host") {
      selfHost = true;
    } else if (argument === "--cwd") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--cwd requires a directory path.");
      }
      projectRoot = resolve(currentDirectory, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(argument)}\n\n${usage()}`);
    }
  }
  return { help: false, projectRoot, selfHost, yes };
}

/**
 * Reads `--cwd <directory>` or `--cwd=<directory>` for a command, or reports
 * its missing value and returns undefined. Every command accepts it, so a
 * command's parser never has to know about a directory it did not choose.
 */
function commandDirectory(
  args: readonly string[],
  currentDirectory: string,
): ReturnType<typeof projectDirectory> | undefined {
  try {
    return projectDirectory(args.slice(1), currentDirectory);
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return undefined;
  }
}

/** Runs the CLI with explicit arguments and working directory. @public */
export async function runCli(
  args: readonly string[],
  currentDirectory: string,
): Promise<void> {
  if (args[0] === "serve") {
    const directory = commandDirectory(args, currentDirectory);
    if (directory === undefined) return;
    const { projectRoot } = directory;
    const planned = planServe(directory.args, process.env, () =>
      randomBytes(24).toString("base64url"),
    );
    if (!planned.ok) {
      process.stderr.write(`${planned.message}\n`);
      process.exitCode = 1;
      return;
    }
    const running = await startOperatorConsole(planned.plan, {
      fileSystem: createNodeFileSystem(projectRoot),
      now: Date.now,
      sessions: createMemorySessionStore(),
      signInLimiter: createSignInLimiter(),
      token: planned.plan.token,
    });
    for (const line of serveGreeting({ ...planned.plan, port: running.port })) {
      process.stdout.write(`${line}\n`);
    }
    return;
  }
  if (
    args[0] === "policy" ||
    args[0] === "findings" ||
    args[0] === "doctor" ||
    args[0] === "evidence" ||
    args[0] === "sites"
  ) {
    const directory = commandDirectory(args, currentDirectory);
    if (directory === undefined) return;
    const { projectRoot } = directory;
    const command = args[0];
    const run = commandRunner(command);
    let result;
    try {
      const projectFileSystem = createNodeFileSystem(projectRoot);
      const selected =
        command === "sites"
          ? {
              args: directory.args,
              fileSystem: projectFileSystem,
              ok: true as const,
              site: undefined,
            }
          : await selectSite(projectFileSystem, directory.args);
      if (!selected.ok) {
        process.stderr.write(`${selected.message}\n`);
        process.exitCode = 1;
        return;
      }
      if (selected.site !== undefined) {
        process.stderr.write(
          `Working on site ${selected.site.name}: paths under opencookie/ refer to opencookie/sites/${selected.site.name}/.\n`,
        );
      }
      result = await run(
        {
          fileSystem: selected.fileSystem,
          ...(selected.site === undefined ? {} : { site: selected.site.name }),
          writeLine: (line): void => {
            process.stdout.write(`${terminalSafe(line)}\n`);
          },
        },
        selected.args,
      );
    } catch (error: unknown) {
      process.stderr.write(
        `OpenCookie ${command} command failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      process.stderr.write(
        `${terminalSafe(result.message ?? `The ${command} command reported a problem.`)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }
  const parsed = parseCliArguments(args, currentDirectory);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const ports = createNodeCliPorts(parsed.projectRoot, {
    ...(parsed.selfHost
      ? { vanillaPackageEntrypoint: resolveVanillaPackageEntrypoint() }
      : {}),
  });
  await initializeProject(ports, {
    projectRoot: parsed.projectRoot,
    selfHost: parsed.selfHost,
    yes: parsed.yes,
  });
}

runCli(process.argv.slice(2), process.cwd()).catch((error: unknown) => {
  process.stderr.write(
    `OpenCookie init failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
