import { lstat, symlink, unlink } from "node:fs/promises";
import path from "node:path";

export async function ensureDocsDependencyLink({ docsRoot, repoRoot }) {
  const rootNodeModules = path.join(repoRoot, "node_modules");
  try {
    await lstat(rootNodeModules);
    return async () => undefined;
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  await symlink(
    path.join(docsRoot, "node_modules"),
    rootNodeModules,
    process.platform === "win32" ? "junction" : "dir",
  );
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(rootNodeModules);
  };
}
