import { describe, expect, it, vi } from "vitest";

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    dirname: actual.win32.dirname,
    isAbsolute: actual.win32.isAbsolute,
    relative: actual.win32.relative,
    resolve: actual.win32.resolve,
    sep: actual.win32.sep,
  };
});

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    readFile: vi.fn(() => Promise.resolve("outside\n")),
    realpath: vi.fn((path: Parameters<typeof actual.realpath>[0]) => {
      const candidate = String(path);
      if (candidate === "C:\\project\\src\\secret.txt") {
        return Promise.resolve("C:\\outside\\secret.txt");
      }
      return Promise.resolve(candidate);
    }),
  };
});

import { createNodeFileSystem } from "./node.js";

describe("createNodeFileSystem on Windows", () => {
  it("refuses lexical traversal outside the project", async () => {
    const fileSystem = createNodeFileSystem("C:\\project");
    await expect(fileSystem.readFile("../outside.txt")).rejects.toThrow(
      /outside the project/i,
    );
  });

  it("refuses reads through a junction outside the canonical project root", async () => {
    const fileSystem = createNodeFileSystem("C:\\project");
    await expect(fileSystem.readFile("src/secret.txt")).rejects.toThrow(
      /outside the project/i,
    );
  });
});
