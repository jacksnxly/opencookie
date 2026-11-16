import { describe, expect, it } from "vitest";

import {
  CliConflictError,
  planInitialization,
  type FileSystemPort,
} from "./index.js";

// The hint must be one a person can follow to the end: whatever the layout's
// shape, wiring it as the hint says is accepted. And the provider belongs in
// <body>: it renders a script beside the page, which cannot sit outside it.

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

const IMPORT = 'import { OpenCookieRoot } from "./opencookie-provider";';
const WIRED =
  "<html><body><OpenCookieRoot>{children}</OpenCookieRoot></body></html>";

const SHAPES: Readonly<Record<string, string>> = {
  "a named function exported below": [
    IMPORT,
    "function Layout({ children }) {",
    `  return ${WIRED};`,
    "}",
    "export default Layout;",
    "",
  ].join("\n"),
  "an arrow function with a block body": [
    IMPORT,
    "const Layout = ({ children }) => {",
    `  return ${WIRED};`,
    "};",
    "export default Layout;",
    "",
  ].join("\n"),
  "a function with an early return": [
    IMPORT,
    "export default function Layout({ children }) {",
    "  if (!children) return null;",
    `  return ${WIRED};`,
    "}",
    "",
  ].join("\n"),
};

describe("a layout wired as the hint says", () => {
  for (const [shape, layout] of Object.entries(SHAPES)) {
    it(`is accepted as ${shape}`, async () => {
      const plan = await planInitialization(project(layout), "/app");

      expect(plan.edits.map((edit) => edit.path)).not.toContain(
        "src/app/layout.tsx",
      );
      expect(plan.files.map((file) => file.path)).toContain(
        "src/app/opencookie-provider.tsx",
      );
    });
  }
});

describe("where the provider sits", () => {
  it("is refused around <html>, and the hint names <body>", async () => {
    const attempt = planInitialization(
      project(
        [
          IMPORT,
          "export default function Layout({ children }) {",
          "  return <OpenCookieRoot><html><body>{children}</body></html></OpenCookieRoot>;",
          "}",
          "",
        ].join("\n"),
      ),
      "/app",
    );

    await expect(attempt).rejects.toThrow(CliConflictError);
    const message = await attempt.catch((error: unknown) =>
      error instanceof Error ? error.message : "",
    );
    expect(message).toContain("<body>");
  });
});
