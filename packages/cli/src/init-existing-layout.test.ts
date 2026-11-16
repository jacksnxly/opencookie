import { describe, expect, it } from "vitest";

import {
  CliConflictError,
  planInitialization,
  type FileSystemPort,
} from "./index.js";

// An existing Next.js app rarely has the bare {children} layout init can
// rewrite. Init then says exactly what to add by hand, and accepts the layout
// once that is in place.

function project(layout: string): FileSystemPort {
  const files = new Map<string, string>([
    [
      "package.json",
      JSON.stringify({ dependencies: { next: "latest", react: "latest" } }),
    ],
    ["src/app/layout.tsx", layout],
    ["src/app/page.tsx", ""],
  ]);
  return {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing test file: ${path}`);
      return Promise.resolve(value);
    },
    replaceFile: (path, _expected, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (_path, operation) => operation(),
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
  };
}

const CUSTOM = [
  'import { Header } from "./header";',
  "export default function Layout({ children }) {",
  "  return <html><body><Header />{children}</body></html>;",
  "}",
  "",
].join("\n");

const HAND_WIRED = [
  'import { Header } from "./header";',
  'import { OpenCookieRoot } from "./opencookie-provider";',
  "export default function Layout({ children }) {",
  "  return <html><body><OpenCookieRoot><Header />{children}</OpenCookieRoot></body></html>;",
  "}",
  "",
].join("\n");

describe("init on an existing Next.js App Router layout", () => {
  it("says what to add by hand when it cannot rewrite the layout", async () => {
    const attempt = planInitialization(project(CUSTOM), "/app");

    await expect(attempt).rejects.toThrow(CliConflictError);
    const message = await attempt.catch((error: unknown) =>
      error instanceof Error ? error.message : "",
    );
    expect(message).toContain("src/app/layout.tsx");
    expect(message).toContain(
      'import { OpenCookieRoot } from "./opencookie-provider";',
    );
    expect(message).toContain("<OpenCookieRoot>");
    expect(message).toContain("run init again");
  });

  it("accepts a layout wired by hand and generates the rest", async () => {
    const plan = await planInitialization(project(HAND_WIRED), "/app");

    expect(plan.framework).toBe("next-app");
    expect(plan.edits.map((edit) => edit.path)).not.toContain(
      "src/app/layout.tsx",
    );
    expect(plan.files.map((file) => file.path)).toContain(
      "src/app/opencookie-provider.tsx",
    );
  });
});
