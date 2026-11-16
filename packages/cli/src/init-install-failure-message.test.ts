import { describe, expect, it, vi } from "vitest";

import { initializeProject, type CliPorts } from "./index.js";

// The command runner ends its own message with a period ("npm exited with
// code 1."). Init's install-failure message keeps one sentence end, not two.

function failingInstall(message: string): CliPorts {
  const files = new Map<string, string>([
    [
      "package.json",
      JSON.stringify({ dependencies: { next: "latest", react: "latest" } }),
    ],
    [
      "src/app/layout.tsx",
      [
        'import { OpenCookieRoot } from "./opencookie-provider";',
        "export default function Layout({ children }) {",
        "  return <html><body><OpenCookieRoot>{children}</OpenCookieRoot></body></html>;",
        "}",
        "",
      ].join("\n"),
    ],
    ["src/app/page.tsx", ""],
  ]);
  return {
    command: { run: () => Promise.reject(new Error(message)) },
    confirm: vi.fn(() => Promise.resolve(true)),
    fileSystem: {
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
    },
    writeLine: vi.fn(),
  };
}

async function failureMessage(message: string): Promise<string> {
  const error = await initializeProject(failingInstall(message), {
    projectRoot: "/app",
    yes: true,
  }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  return error instanceof Error ? error.message : "";
}

describe("init's install-failure message", () => {
  it("keeps one period after a runner message that ends with one", async () => {
    const message = await failureMessage("npm exited with code 1.");
    expect(message).toContain("npm exited with code 1. Init wrote nothing.");
    expect(message).not.toContain("..");
  });

  it("adds the period after a message without one", async () => {
    const message = await failureMessage("npm error code ERESOLVE");
    expect(message).toContain("npm error code ERESOLVE. Init wrote nothing.");
  });
});
