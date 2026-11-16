import { describe, expect, it } from "vitest";

/**
 * OpenCookie 1.0 does not implement IAB TCF, and must not appear to.
 *
 * TCF vendors detect a CMP by the presence of `__tcfapi`. A partial or
 * uncertified implementation would be read by advertising vendors as a real
 * consent signal and acted on, which is worse than absent support: the site
 * would look compliant to the vendor while nothing meaningful was negotiated.
 * TCF stays outside core behind a versioned optional port, and is out of
 * scope for 1.0.
 */
describe("TCF surface", () => {
  it("installs no __tcfapi global, so no vendor mistakes this for a TCF CMP", async () => {
    const before = "__tcfapi" in globalThis;
    expect(before).toBe(false);

    await import("./index.js");

    expect("__tcfapi" in globalThis).toBe(false);
    expect("__tcfapiLocator" in globalThis).toBe(false);
  });

  it("ships no TCF implementation in the public entrypoint", async () => {
    const entrypoint: Record<string, unknown> = await import("./index.js");

    const tcfNames = Object.keys(entrypoint).filter((name) =>
      /tcf|iab|tcstring|gvl/iu.test(name),
    );
    expect(tcfNames).toEqual([]);
  });
});
