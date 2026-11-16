import { describe, expect, it } from "vitest";

import { purposesMissingForConfiguration } from "./configuration-bindings.js";
import type { FileSystemPort } from "./contracts.js";

function files(initial: Readonly<Record<string, string>>): FileSystemPort {
  const stored = new Map(Object.entries(initial));
  return {
    exists: (path) => Promise.resolve(stored.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => Promise.resolve(stored.get(path) ?? ""),
    replaceFile: () => Promise.reject(new Error("read only")),
    withLock: (_path, operation) => operation(),
    writeFile: () => Promise.reject(new Error("read only")),
  };
}

describe("purposes the configuration binds", () => {
  it("finds nothing missing when the project has no configuration", async () => {
    await expect(
      purposesMissingForConfiguration(files({}), ["analytics"]),
    ).resolves.toEqual([]);
  });

  it("reads every binding list, in any quote style, and names each missing purpose once", async () => {
    const configuration = [
      "resources: [",
      '  { id: "a", purposeIds: ["analytics", \'marketing\'] },',
      "  { id: \"b\", purposeIds : [ `analytics` ,\n 'support' ] },",
      '  { id: "c", purposeIds: [] },',
      "],",
    ].join("\n");

    await expect(
      purposesMissingForConfiguration(
        files({ "opencookie.config.ts": configuration }),
        ["support"],
      ),
    ).resolves.toEqual(["analytics", "marketing"]);
  });

  it("finds nothing missing when the policy declares every bound purpose", async () => {
    await expect(
      purposesMissingForConfiguration(
        files({ "opencookie.config.ts": 'purposeIds: ["analytics"]' }),
        ["analytics", "unused"],
      ),
    ).resolves.toEqual([]);
  });
});
