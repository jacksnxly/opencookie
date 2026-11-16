import { describe, expect, it, vi } from "vitest";

import { initializeProject, type CliPorts } from "./index.js";

// When the package install fails, init has written nothing. A Next.js layout
// wired by hand, as init asks for, already imports the provider init would
// generate, so the error names the files still to come and says to run init
// again.

const HAND_WIRED = [
  'import { Header } from "./header";',
  'import { OpenCookieRoot } from "./opencookie-provider";',
  "export default function Layout({ children }) {",
  "  return <html><body><OpenCookieRoot><Header />{children}</OpenCookieRoot></body></html>;",
  "}",
  "",
].join("\n");

function failingInstall(): {
  readonly files: Map<string, string>;
  readonly ports: CliPorts;
} {
  const files = new Map<string, string>([
    [
      "package.json",
      JSON.stringify({ dependencies: { next: "15.5.4", react: "19.2.0" } }),
    ],
    ["src/app/layout.tsx", HAND_WIRED],
    ["src/app/page.tsx", ""],
  ]);
  return {
    files,
    ports: {
      command: {
        run: () => Promise.reject(new Error("npm error code ERESOLVE")),
      },
      confirm: vi.fn(() => Promise.resolve(true)),
      fileSystem: {
        exists: (path) => Promise.resolve(files.has(path)),
        mkdir: () => Promise.resolve(),
        readFile: (path) => {
          const value = files.get(path);
          if (value === undefined) {
            throw new Error(`Missing test file: ${path}`);
          }
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
    },
  };
}

describe("init when the install fails", () => {
  it("writes nothing and names the files still to create", async () => {
    const fixture = failingInstall();
    const before = new Map(fixture.files);

    const error = await initializeProject(fixture.ports, {
      projectRoot: "/app",
      yes: true,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("npm error code ERESOLVE");
    expect(message).toContain("Init wrote nothing.");
    expect(message).toContain("src/app/opencookie-provider.tsx");
    expect(message).toContain("opencookie.config.ts");
    expect(message).toContain("run init again");
    expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(
      Error,
    );
    expect(fixture.files).toEqual(before);
  });
});
