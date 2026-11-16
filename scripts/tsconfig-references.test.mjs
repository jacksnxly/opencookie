import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function exists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Every workspace package under packages/ that has its own tsconfig. */
async function workspacePackages() {
  const found = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      (await exists(path.join(directory, "package.json"))) &&
      (await exists(path.join(directory, "tsconfig.json")))
    ) {
      found.push(directory);
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !["node_modules", "dist", "temp", "etc"].includes(entry.name)
      ) {
        await visit(path.join(directory, entry.name));
      }
    }
  };
  await visit(path.join(repositoryRoot, "packages"));
  return found;
}

/** Workspace package names a source file imports in real code, not in strings. */
function importedWorkspacePackages(fileName, source) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names = [];
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const match = /^(@opencookie-dev\/[a-z-]+)/u.exec(
        statement.moduleSpecifier.text,
      );
      if (match !== null) names.push(match[1]);
    }
  }
  return names;
}

test("every package's tsconfig references the workspace packages its sources import", async () => {
  const directories = await workspacePackages();
  const directoryOf = new Map();
  for (const directory of directories) {
    const { name } = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    directoryOf.set(name, directory);
  }

  const missing = [];
  for (const directory of directories) {
    const { name } = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    const tsconfig = JSON.parse(
      await readFile(path.join(directory, "tsconfig.json"), "utf8"),
    );
    const referenced = new Set(
      (tsconfig.references ?? []).map((reference) =>
        path.resolve(directory, reference.path),
      ),
    );
    const sourceRoot = path.join(directory, "src");
    const files = await readdir(sourceRoot, { recursive: true }).catch(
      () => [],
    );
    for (const file of files) {
      if (!/\.(?:ts|tsx)$/u.test(file) || file.endsWith(".d.ts")) continue;
      const fileName = path.join(sourceRoot, file);
      for (const imported of importedWorkspacePackages(
        fileName,
        await readFile(fileName, "utf8"),
      )) {
        const target = directoryOf.get(imported);
        if (imported === name || target === undefined) continue;
        if (!referenced.has(target)) {
          missing.push(
            `${path.relative(repositoryRoot, directory)} imports ${imported} in ${file} without a tsconfig reference`,
          );
        }
      }
    }
  }

  assert.deepEqual([...new Set(missing)].sort(), []);
});
