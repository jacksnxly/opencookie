import { describe, expect, it } from "vitest";

import { planServe, serveGreeting } from "./index.js";

const token = (): string => "generated-token";
const STRONG = "a-supplied-operator-token-of-40-characters";

function plan(
  args: readonly string[] = [],
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  const result = planServe(args, environment, token);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

describe("planning an operator server", () => {
  // Binding the whole machine by default would put an operator console on the
  // network the moment someone tries the command.
  it("listens on the loopback address unless told otherwise", () => {
    expect(plan()).toMatchObject({ host: "127.0.0.1", port: 4321 });
  });

  it("takes the host and port the operator asked for", () => {
    expect(plan(["--host", "0.0.0.0", "--port", "8080"])).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
    });
  });

  it.each([
    ["a port that is not a number", ["--port", "http"]],
    ["a port below the valid range", ["--port", "0"]],
    ["a port above the valid range", ["--port", "70000"]],
    ["a fractional port", ["--port", "80.5"]],
    ["a missing port value", ["--port"]],
    ["a missing host value", ["--host"]],
    ["an argument it does not know", ["--daemonize"]],
  ])("refuses %s", (_label, args) => {
    const result = planServe(args, {}, token);

    expect(result.ok).toBe(false);
  });

  // A generated token would change on restart and invalidate an operator's
  // bookmarked session, so a supplied one wins.
  it("uses the token from the environment when there is one", () => {
    expect(plan([], { OPENCOOKIE_OPERATOR_TOKEN: STRONG })).toMatchObject({
      token: STRONG,
      tokenWasGenerated: false,
    });
  });

  // A short token falls to guessing, so one the operator supplies must be at
  // least as long as the one the console would generate.
  it.each(["a", "x".repeat(31)])(
    "refuses a supplied token too short to resist guessing: %s",
    (supplied) => {
      const result = planServe(
        [],
        { OPENCOOKIE_OPERATOR_TOKEN: supplied },
        token,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain("32");
    },
  );

  it("generates a token when the environment has none", () => {
    expect(plan()).toMatchObject({
      token: "generated-token",
      tokenWasGenerated: true,
    });
  });

  it("treats a blank environment token as no token at all", () => {
    expect(plan([], { OPENCOOKIE_OPERATOR_TOKEN: "   " })).toMatchObject({
      tokenWasGenerated: true,
    });
  });

  it("trusts a forwarded protocol only when told it is behind a proxy", () => {
    expect(plan().behindProxy).toBe(false);
    expect(plan(["--behind-proxy"]).behindProxy).toBe(true);
  });
});

describe("what the operator is told at startup", () => {
  it("prints the address to open and the token it generated", () => {
    const lines = serveGreeting(plan()).join("\n");

    expect(lines).toContain("http://127.0.0.1:4321/login");
    expect(lines).toContain("generated-token");
  });

  // The operator already has a token they supplied; repeating it only writes a
  // long-lived secret into terminal scrollback and process logs.
  it("does not repeat a token that came from the environment", () => {
    const lines = serveGreeting(
      plan([], { OPENCOOKIE_OPERATOR_TOKEN: STRONG }),
    ).join("\n");

    expect(lines).not.toContain(STRONG);
    expect(lines).toContain("OPENCOOKIE_OPERATOR_TOKEN");
  });

  it("warns when the console is bound beyond this machine", () => {
    const beyond = serveGreeting(plan(["--host", "0.0.0.0"])).join("\n");
    const loopback = serveGreeting(plan()).join("\n");

    expect(beyond).toMatch(/reachable from other machines/iu);
    expect(loopback).not.toMatch(/reachable from other machines/iu);
  });
});
