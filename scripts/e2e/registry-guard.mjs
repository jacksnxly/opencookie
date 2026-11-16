export function isRegistryPublicationInvocation(executable, args) {
  const publicationCommands = new Set([
    "pu",
    "pub",
    "publ",
    "publi",
    "publis",
    "publish",
    "unp",
    "unpu",
    "unpub",
    "unpubl",
    "unpubli",
    "unpublis",
    "unpublish",
  ]);
  const executableName = (value) => {
    const basename = String(value)
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      ?.replace(/\.(?:cmd|exe)$/iu, "");
    return /^(?:npm|pnpm)(?:@.+)?$/iu.test(basename ?? "")
      ? "package-manager"
      : /^(?:npx)(?:@.+)?$/iu.test(basename ?? "")
        ? "executor"
        : undefined;
  };
  const manager = executableName(executable);
  if (manager === "package-manager") {
    return args.some((value) =>
      publicationCommands.has(String(value).toLowerCase()),
    );
  }
  if (manager !== "executor") return false;
  const tokens = args.flatMap((value) =>
    String(value)
      .split(/[\s;&|()]+/u)
      .map((token) => token.replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean),
  );
  return tokens.some(
    (value, index) =>
      executableName(value) === "package-manager" &&
      tokens
        .slice(index + 1)
        .some((entry) => publicationCommands.has(String(entry).toLowerCase())),
  );
}
