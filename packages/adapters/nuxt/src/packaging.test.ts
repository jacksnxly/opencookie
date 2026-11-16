import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;
const fixtureConfig = readFileSync(
  new URL("../test-fixture/nuxt.config.ts", import.meta.url),
  "utf8",
);
const fixtureApp = readFileSync(
  new URL("../test-fixture/app.vue", import.meta.url),
  "utf8",
);

describe("OpenCookie Nuxt consumer fixture", () => {
  it("uses the packed root export and type-checks the app injection", () => {
    expect(packageManifest.scripts?.["fixture:build"]).toBe(
      "node test-fixture/build-packed.mjs",
    );
    expect(fixtureConfig).toContain('from "@opencookie-dev/nuxt"');
    expect(fixtureApp).toContain("useNuxtApp().$openCookie");
  });
});
