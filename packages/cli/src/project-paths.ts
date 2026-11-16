/** The directory holding a project-relative path, or "" at the project root. */
export function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator <= 0 ? "" : path.slice(0, separator);
}

/**
 * The CLI reads and writes only inside the project. A port refuses any other
 * path with this error, so a command can say so rather than call the file
 * unreadable.
 */
export class PathOutsideProjectError extends Error {
  constructor(readonly path: string) {
    super(`Refusing to access a path outside the project: ${path}`);
    this.name = "PathOutsideProjectError";
  }
}

/**
 * Why a file the operator named could not be read: refused because it lies
 * outside the project, or genuinely unreadable. Every command that reads such
 * a file says it in these words.
 */
export function unreadablePathMessage(path: string, error: unknown): string {
  return error instanceof PathOutsideProjectError
    ? `${path} is outside the project, and the CLI reads files only inside it. Copy it into the project, or run the command with --cwd set to a directory that contains it.`
    : `${path} could not be read.`;
}
