import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { ServePlan } from "./serve-command.js";
import {
  handleOperatorRequest,
  type OperatorRequest,
  type OperatorServerPorts,
} from "./operator-server.js";

/** @public */
export interface OperatorListenerPorts extends OperatorServerPorts {
  /** Whether `x-forwarded-proto` may be believed. */
  readonly behindProxy?: boolean;
}

/**
 * The most a single request body may be.
 *
 * Every form this surface serves is a few hundred bytes. Reading without a
 * limit would let one request exhaust the process.
 */
const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The three request headers this surface reads.
 *
 * Nothing else is passed through, so the surface cannot start depending on a
 * header the binding never promised to deliver. Node gives a repeated header
 * back as an array only in cases none of these three reach, and joining one is
 * exactly the comma-separated form the forwarded-protocol rule already reads.
 */
function headers(request: IncomingMessage): Record<string, string> {
  return {
    authorization: request.headers.authorization ?? "",
    cookie: request.headers.cookie ?? "",
    "x-forwarded-proto": String(request.headers["x-forwarded-proto"] ?? ""),
  };
}

/**
 * Whether the browser's connection is encrypted.
 *
 * A forwarded header is only a claim by whatever sent it, so it counts only
 * when the operator has said this console sits behind a proxy that sets it.
 */
function isSecure(
  request: IncomingMessage,
  requestHeaders: Readonly<Record<string, string>>,
  behindProxy: boolean,
): boolean {
  if ("encrypted" in request.socket) return true;
  if (!behindProxy) return false;
  // Node's parser has already stripped the optional space around a header
  // value, so the protocol the browser used is the first list entry as it is.
  return (requestHeaders["x-forwarded-proto"] ?? "").split(",")[0] === "https";
}

/** Binds the operator surface to Node's HTTP server. @public */
export function createOperatorRequestListener(
  ports: OperatorListenerPorts,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      // The whole request target, not just its path: the console narrows a
      // list with a query and cannot see one the binding has thrown away.
      const target = new URL(request.url ?? "/", "http://operator.invalid");
      const path = `${target.pathname}${target.search}`;
      let body: string;
      try {
        body = await readBody(request);
      } catch (error: unknown) {
        if (!(error instanceof BodyTooLarge)) throw error;
        // The rest of the upload is never read, so the socket is closed with
        // the refusal rather than left waiting for a body nobody wants.
        response.writeHead(413, {
          connection: "close",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end("That request body is larger than this console reads.\n");
        return;
      }
      const requestHeaders = headers(request);
      const operatorRequest: OperatorRequest = {
        body,
        headers: requestHeaders,
        method: request.method ?? "GET",
        path,
        secure: isSecure(request, requestHeaders, ports.behindProxy === true),
      };
      const result = await handleOperatorRequest(operatorRequest, ports);
      response.writeHead(result.status, result.headers);
      response.end(result.body);
    })().catch((error: unknown) => {
      // Nothing about the failure is echoed back: a stack trace from a console
      // that holds consent evidence is not something to hand to a caller.
      process.stderr.write(
        `OpenCookie operator request failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (!response.headersSent) {
        response.writeHead(500, {
          "content-type": "text/plain; charset=utf-8",
        });
      }
      response.end("The operator console could not serve that request.\n");
    });
  };
}

/** A listening operator console. @public */
export interface RunningOperatorConsole {
  readonly close: () => Promise<void>;
  readonly port: number;
}

/**
 * Starts the operator console on the planned address.
 *
 * The bound port is reported back rather than assumed, so a caller states what
 * is actually listening instead of what it asked for.
 *
 * @public
 */
export async function startOperatorConsole(
  plan: ServePlan,
  ports: OperatorServerPorts,
): Promise<RunningOperatorConsole> {
  const server = createServer(
    createOperatorRequestListener({ ...ports, behindProxy: plan.behindProxy }),
  );
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(plan.port, plan.host, () => {
      server.removeListener("error", failed);
      listening();
    });
  });
  const address = server.address();
  return {
    close: () =>
      new Promise<void>((closed) => {
        server.close(() => {
          closed();
        });
      }),
    port:
      typeof address === "object" && address !== null
        ? address.port
        : plan.port,
  };
}
