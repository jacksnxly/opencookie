import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The adapter imports nothing from next: it re-exports the React binding under
// "use client". So it accepts Next.js 15 as well as 16.

describe("@opencookie-dev/next peer range", () => {
  it("accepts Next.js 15 and 16", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly peerDependencies: Readonly<Record<string, string>> };

    expect(manifest.peerDependencies["next"]).toBe(">=15.0.0 <17.0.0");
  });
});
