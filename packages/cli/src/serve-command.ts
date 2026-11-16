/** How an operator server should be started. @public */
export interface ServePlan {
  /** Whether a forwarded-protocol header may be believed. */
  readonly behindProxy: boolean;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly tokenWasGenerated: boolean;
}

/** @public */
export type ServePlanResult =
  | { readonly message: string; readonly ok: false }
  | { readonly ok: true; readonly plan: ServePlan };

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4321;
const TOKEN_VARIABLE = "OPENCOOKIE_OPERATOR_TOKEN";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * Works out how to serve the operator console.
 *
 * The default binds the loopback address only. An operator console reaches a
 * site's policy and its visitors' evidence, so trying the command must not put
 * it on the network; asking for a wider host is a decision the operator makes
 * out loud.
 *
 * @public
 */
export function planServe(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  createToken: () => string,
): ServePlanResult {
  let behindProxy = false;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--behind-proxy") {
      behindProxy = true;
    } else if (argument === "--host") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { message: "--host requires a hostname or address.", ok: false };
      }
      host = value;
      index += 1;
    } else if (argument === "--port") {
      const parsed = parsePort(args[index + 1]);
      if (parsed === undefined) {
        return {
          message: "--port requires a whole number between 1 and 65535.",
          ok: false,
        };
      }
      port = parsed;
      index += 1;
    } else {
      return {
        message: `Unknown argument: ${String(argument)}\n\nUsage: opencookie serve [--host <address>] [--port <number>] [--behind-proxy]`,
        ok: false,
      };
    }
  }
  const supplied = environment[TOKEN_VARIABLE]?.trim();
  const tokenWasGenerated = supplied === undefined || supplied === "";
  // As long as the token the console generates, so it cannot be guessed.
  if (!tokenWasGenerated && supplied.length < 32) {
    return {
      message: `${TOKEN_VARIABLE} must be at least 32 characters so it cannot be guessed. Unset it to have a strong one generated.`,
      ok: false,
    };
  }
  return {
    ok: true,
    plan: {
      behindProxy,
      host,
      port,
      token: tokenWasGenerated ? createToken() : supplied,
      tokenWasGenerated,
    },
  };
}

/**
 * What the operator is told when the console starts.
 *
 * A token the operator supplied is never repeated: it already exists on their
 * side, and printing it writes a long-lived secret into terminal scrollback
 * and any log that captures this output.
 *
 * @public
 */
export function serveGreeting(plan: ServePlan): readonly string[] {
  const lines = [
    `OpenCookie operator console: http://${plan.host}:${String(plan.port)}/login`,
  ];
  if (plan.tokenWasGenerated) {
    lines.push(
      `Operator token: ${plan.token}`,
      `This token was generated for this run and is gone when the process stops. Set ${TOKEN_VARIABLE} to keep one across restarts.`,
    );
  } else {
    lines.push(`Using the operator token from ${TOKEN_VARIABLE}.`);
  }
  if (!LOOPBACK_HOSTS.has(plan.host)) {
    lines.push(
      "This console is reachable from other machines. Put it behind HTTPS with --behind-proxy, or bind 127.0.0.1 and reach it through an SSH tunnel.",
    );
  }
  return lines;
}
