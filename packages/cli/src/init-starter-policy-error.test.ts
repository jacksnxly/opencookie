import { describe, expect, it } from "vitest";

import { planInitialization, type FileSystemPort } from "./index.js";

// A starter policy edited into an invalid one fails at startup. The error
// names each issue's code and path, so the operator can find what to fix.

const HAND_WIRED = [
  'import { OpenCookieRoot } from "./opencookie-provider";',
  "export default function Layout({ children }) {",
  "  return <html><body><OpenCookieRoot>{children}</OpenCookieRoot></body></html>;",
  "}",
  "",
].join("\n");

function project(): FileSystemPort {
  const files = new Map<string, string>([
    [
      "package.json",
      JSON.stringify({ dependencies: { next: "latest", react: "latest" } }),
    ],
    ["src/app/layout.tsx", HAND_WIRED],
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
    replaceFile: () => Promise.resolve(),
    withLock: (_path, operation) => operation(),
    writeFile: () => Promise.resolve(),
  };
}

describe("generated starter policy errors", () => {
  it("name the issue codes and paths", async () => {
    const plan = await planInitialization(project(), "/app");
    const content = (path: string): string =>
      plan.files.find((file) => file.path === path)?.content ?? "";

    const policy = content("opencookie.policy.ts");
    expect(policy).toContain("The OpenCookie starter policy is invalid: ");
    expect(policy).toMatch(/\$\{issue\.code\} at \$\{issue\.path\}/);

    const config = content("opencookie.config.ts");
    expect(config).toContain(
      "The OpenCookie starter resource policy is invalid: ",
    );
    expect(config).toMatch(/\$\{issue\.code\} at \$\{issue\.path\}/);
  });
});
