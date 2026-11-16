import { describe, expect, it } from "vitest";

import { projectDirectory } from "./flags.js";

// Pass B's M-D on 0.2.0: only `--cwd <dir>` was understood, so `--cwd=<dir>`
// ran the command in the current directory. An erasure there deleted nothing,
// reported success and created an empty store where the operator stood.
describe("projectDirectory", () => {
  it("reads --cwd in both spellings and removes it from the arguments", () => {
    expect(
      projectDirectory(
        ["delete", "--cwd", "shop", "--consent-id", "v1"],
        "/work",
      ),
    ).toEqual({
      args: ["delete", "--consent-id", "v1"],
      projectRoot: "/work/shop",
    });
    expect(
      projectDirectory(
        ["delete", "--cwd=/srv/shop", "--consent-id", "v1"],
        "/work",
      ),
    ).toEqual({
      args: ["delete", "--consent-id", "v1"],
      projectRoot: "/srv/shop",
    });
  });

  it("uses the current directory when --cwd is absent", () => {
    expect(projectDirectory(["list"], "/work")).toEqual({
      args: ["list"],
      projectRoot: "/work",
    });
  });

  it("refuses --cwd without a directory", () => {
    expect(() => projectDirectory(["list", "--cwd="], "/work")).toThrow(
      /--cwd requires a value/u,
    );
    expect(() => projectDirectory(["list", "--cwd"], "/work")).toThrow(
      /--cwd requires a value/u,
    );
  });
});
