import { resolve } from "node:path";

/**
 * A value flag given without a value.
 *
 * It must never read as an absent flag: a filter that silently disappears
 * widens what a command touches, for example an export of one visitor's
 * receipts becoming an export of everyone's.
 */
export class MissingFlagValueError extends Error {
  constructor(readonly flag: string) {
    super(`${flag} requires a value.`);
    this.name = "MissingFlagValueError";
  }
}

/**
 * A long flag the command does not know.
 *
 * It is refused rather than ignored, for the reason above: a misspelt
 * `--consentId` once turned a one-visitor export into an export of everyone.
 */
export class UnknownFlagError extends Error {
  constructor(readonly flag: string) {
    super(`${flag} is not an option of this command.`);
    this.name = "UnknownFlagError";
  }
}

/** Refuses any long flag, as `--flag` or `--flag=value`, not in `known`. */
export function refuseUnknownFlags(
  args: readonly string[],
  known: readonly string[] = [],
): void {
  for (const argument of args) {
    if (!argument.startsWith("--")) continue;
    const [flag = argument] = argument.split("=", 1);
    if (!known.includes(flag)) throw new UnknownFlagError(flag);
  }
}

/**
 * Splits `--cwd <dir>` or `--cwd=<dir>` out of a command's arguments and
 * resolves the project directory it names, or the current one.
 */
export function projectDirectory(
  args: readonly string[],
  currentDirectory: string,
): { readonly args: readonly string[]; readonly projectRoot: string } {
  const directory = readFlag(args, "--cwd");
  const rest = args.filter(
    (argument, index) =>
      argument !== "--cwd" &&
      !argument.startsWith("--cwd=") &&
      args[index - 1] !== "--cwd",
  );
  return {
    args: rest,
    projectRoot:
      directory === undefined
        ? currentDirectory
        : resolve(currentDirectory, directory),
  };
}

/**
 * Reads the value of a long flag, as `--flag value` or `--flag=value`.
 *
 * A value may begin with a single hyphen; only another long flag, or nothing,
 * after `--flag` means the value is missing, which throws rather than returning
 * `undefined`. The first occurrence wins.
 */
export function readFlag(
  args: readonly string[],
  flag: string,
): string | undefined {
  for (const [index, argument] of args.entries()) {
    if (argument.startsWith(`${flag}=`)) {
      const value = argument.slice(flag.length + 1);
      if (value === "") throw new MissingFlagValueError(flag);
      return value;
    }
    if (argument === flag) {
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new MissingFlagValueError(flag);
      }
      return value;
    }
  }
  return undefined;
}

/** Reads every value of a repeatable long flag, with the same rules. */
export function readRepeatedFlag(
  args: readonly string[],
  flag: string,
): readonly string[] {
  const values: string[] = [];
  for (const [index, argument] of args.entries()) {
    if (argument === flag || argument.startsWith(`${flag}=`)) {
      const value = readFlag(args.slice(index), flag);
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

/**
 * Turns a missing flag value, or a flag the subcommand does not know, into the
 * command's own refusal. `options` lists each subcommand's flags.
 */
export async function refusingMissingFlagValues<Result>(
  operation: () => Promise<Result>,
  refuse: (message: string) => Result,
  args: readonly string[] = [],
  options: Readonly<Record<string, readonly string[]>> = {},
): Promise<Result> {
  try {
    const [subcommand = "", ...rest] = args;
    refuseUnknownFlags(rest, options[subcommand]);
    return await operation();
  } catch (error) {
    if (
      error instanceof MissingFlagValueError ||
      error instanceof UnknownFlagError
    ) {
      return refuse(error.message);
    }
    throw error;
  }
}
