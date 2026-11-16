import { describe, expect, it } from "vitest";

import {
  CliConflictError,
  planInitialization,
  type FileSystemPort,
} from "./index.js";

// A layout counts as wired by hand only when the page really renders inside
// the provider. Anything else stays a conflict: init never guesses.

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

function layout(importLine: string, body: string): string {
  return [
    'import { Header } from "./header";',
    importLine,
    "export default function Layout({ children }) {",
    `  return <html><body>${body}</body></html>;`,
    "}",
    "",
  ].join("\n");
}

const PROVIDER = 'import { OpenCookieRoot } from "./opencookie-provider";';

describe("layouts that only look wired", () => {
  it("refuses a provider that does not contain the page", async () => {
    await expect(
      planInitialization(
        project(
          layout(
            PROVIDER,
            "<OpenCookieRoot><Header /></OpenCookieRoot>{children}",
          ),
        ),
        "/app",
      ),
    ).rejects.toThrow(CliConflictError);
  });

  it("refuses a provider imported from somewhere else", async () => {
    await expect(
      planInitialization(
        project(
          layout(
            'import { OpenCookieRoot } from "./my-own-root";',
            "<OpenCookieRoot><Header />{children}</OpenCookieRoot>",
          ),
        ),
        "/app",
      ),
    ).rejects.toThrow(CliConflictError);
  });
});
