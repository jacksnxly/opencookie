import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemorySessionStore,
  startOperatorConsole,
  type FileSystemPort,
} from "./index.js";
import { createOperatorRequestListener } from "./serve-node.js";

function memoryFileSystem(): {
  fileSystem: FileSystemPort;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const fileSystem: FileSystemPort = {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => Promise.resolve(files.get(path) ?? ""),
    replaceFile: (path, previous, content) => {
      if (files.get(path) !== previous) {
        return Promise.reject(new Error(`Stale replace of ${path}`));
      }
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (_path, operation) => operation(),
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
  };
  return { fileSystem, files };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        }),
    ),
  );
});

async function listen(
  options: { behindProxy?: boolean } = {},
): Promise<{ files: Map<string, string>; origin: string }> {
  const { fileSystem, files } = memoryFileSystem();
  const server = createServer(
    createOperatorRequestListener({
      fileSystem,
      now: () => 0,
      sessions: createMemorySessionStore(),
      token: "operator-token",
      ...options,
    }),
  );
  servers.push(server);
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address() as AddressInfo;
  return { files, origin: `http://127.0.0.1:${String(address.port)}` };
}

describe("the operator server bound to Node's HTTP server", () => {
  // The whole point of this milestone is a surface a person can open, so the
  // journey is driven over a real socket rather than through the handler.
  it("takes an operator from the sign-in page to a created site", async () => {
    const { files, origin } = await listen();

    const signInPage = await fetch(`${origin}/login`);
    const signedIn = await fetch(`${origin}/login`, {
      body: new URLSearchParams({ token: "operator-token" }),
      method: "POST",
      redirect: "manual",
    });
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0];
    const sites = await fetch(`${origin}/`, {
      headers: { cookie: cookie ?? "" },
    });
    const sitesBody = await sites.text();
    const formToken = /name="formToken" value="([^"]+)"/u.exec(sitesBody)?.[1];
    const created = await fetch(`${origin}/sites`, {
      body: new URLSearchParams({
        domain: "shop.example.com",
        formToken: formToken ?? "",
        name: "shop",
      }),
      headers: { cookie: cookie ?? "" },
      method: "POST",
      redirect: "manual",
    });

    expect(signInPage.status).toBe(200);
    expect(await signInPage.text()).toContain('action="/login"');
    expect(signedIn.status).toBe(303);
    expect(sites.status).toBe(200);
    expect(created.status).toBe(303);
    expect(files.get("opencookie/sites.json")).toContain("shop.example.com");
  });

  it("refuses an unauthenticated caller over the socket", async () => {
    const { origin } = await listen();

    const response = await fetch(`${origin}/`);

    expect(response.status).toBe(401);
  });

  // An unbounded read lets one request exhaust the process's memory.
  it("refuses a body larger than it is willing to read", async () => {
    const { origin } = await listen();

    const response = await fetch(`${origin}/login`, {
      body: `token=${"x".repeat(200_000)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("larger than this console reads");
  });

  // The limit is a maximum, not a threshold one byte below it.
  it("reads a body of exactly the size it allows", async () => {
    const { origin } = await listen();
    const body = `token=${"x".repeat(65_530)}`;

    const response = await fetch(`${origin}/login`, {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    expect(Buffer.byteLength(body)).toBe(65_536);
    expect(response.status).toBe(401);
  });

  // A body sent in chunks declares no length, so the count while reading is
  // the only thing standing between one caller and the process's memory.
  it("refuses an oversized body that never declares its length", async () => {
    const { origin } = await listen();
    const chunk = new TextEncoder().encode("x".repeat(16_384));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 12) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });

    const response = await fetch(`${origin}/login`, {
      body,
      duplex: "half",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain("larger than this console reads");
  });

  // A self-hosted console usually sits behind a TLS-terminating proxy, so it
  // must be told before it believes a forwarded protocol header.
  it("believes a forwarded protocol only when it is behind a proxy", async () => {
    const trusting = await listen({ behindProxy: true });
    const plain = await listen();
    const body = new URLSearchParams({ token: "operator-token" });

    const behindProxy = await fetch(`${trusting.origin}/login`, {
      body,
      headers: { "x-forwarded-proto": "https" },
      method: "POST",
      redirect: "manual",
    });
    const spoofed = await fetch(`${plain.origin}/login`, {
      body,
      headers: { "x-forwarded-proto": "https" },
      method: "POST",
      redirect: "manual",
    });

    expect(behindProxy.headers.get("set-cookie")).toContain("Secure");
    expect(spoofed.headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("what the console does with a forwarded protocol", () => {
  it.each([
    ["a list naming the browser's protocol first", "https, http"],
    ["a value with surrounding space", " https "],
  ])("reads %s", async (_label, forwarded) => {
    const { origin } = await listen({ behindProxy: true });

    const response = await fetch(`${origin}/login`, {
      body: new URLSearchParams({ token: "operator-token" }),
      headers: { "x-forwarded-proto": forwarded },
      method: "POST",
      redirect: "manual",
    });

    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("does not treat a proxied plain connection as encrypted", async () => {
    const { origin } = await listen({ behindProxy: true });

    const response = await fetch(`${origin}/login`, {
      body: new URLSearchParams({ token: "operator-token" }),
      headers: { "x-forwarded-proto": "http" },
      method: "POST",
      redirect: "manual",
    });

    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("when serving a request fails", () => {
  // A console that holds consent evidence must not hand a caller the details
  // of its own failure, and must not die on one request either.
  it("answers plainly and keeps the detail on the server's own error stream", async () => {
    const complaint = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const broken: FileSystemPort = {
      exists: () => Promise.reject(new Error("the disk is on fire")),
      mkdir: () => Promise.resolve(),
      readFile: () => Promise.reject(new Error("the disk is on fire")),
      replaceFile: () => Promise.reject(new Error("the disk is on fire")),
      withLock: (_path, operation) => operation(),
      writeFile: () => Promise.reject(new Error("the disk is on fire")),
    };
    const sessions = createMemorySessionStore();
    const session = sessions.create();
    const server = createServer(
      createOperatorRequestListener({
        fileSystem: broken,
        now: () => 0,
        sessions,
        token: "operator-token",
      }),
    );
    servers.push(server);
    await new Promise<void>((ready) => {
      server.listen(0, "127.0.0.1", ready);
    });
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      headers: { cookie: `opencookie_operator=${session.id}` },
    });
    const body = await response.text();
    const written = complaint.mock.calls.map(([line]) => String(line)).join("");
    complaint.mockRestore();

    expect(response.status).toBe(500);
    expect(body).toContain("could not serve that request");
    expect(body).not.toContain("the disk is on fire");
    expect(written).toContain("the disk is on fire");
  });
});

describe("starting and stopping the console", () => {
  it("listens on the planned address and reports the bound port", async () => {
    const { fileSystem } = memoryFileSystem();
    const running = await startOperatorConsole(
      {
        behindProxy: false,
        host: "127.0.0.1",
        port: 0,
        token: "t",
        tokenWasGenerated: true,
      },
      {
        fileSystem,
        now: () => 0,
        sessions: createMemorySessionStore(),
        token: "t",
      },
    );

    const response = await fetch(
      `http://127.0.0.1:${String(running.port)}/login`,
    );
    const body = await response.text();
    // Signing in proves the console was given this caller's ports and token,
    // not merely that something answered on the port.
    const signedIn = await fetch(
      `http://127.0.0.1:${String(running.port)}/login`,
      {
        body: new URLSearchParams({ token: "t" }),
        method: "POST",
        redirect: "manual",
      },
    );
    await running.close();
    const afterClosing = await fetch(
      `http://127.0.0.1:${String(running.port)}/login`,
    ).then(
      () => "still answering",
      () => "refused",
    );

    expect(running.port).toBeGreaterThan(0);
    expect(signedIn.status).toBe(303);
    expect(response.status).toBe(200);
    expect(body).toContain('action="/login"');
    expect(afterClosing).toBe("refused");
  });

  it("reports the failure when the address cannot be bound", async () => {
    const { fileSystem } = memoryFileSystem();
    const ports = {
      fileSystem,
      now: () => 0,
      sessions: createMemorySessionStore(),
      token: "t",
    };
    const first = await startOperatorConsole(
      {
        behindProxy: false,
        host: "127.0.0.1",
        port: 0,
        token: "t",
        tokenWasGenerated: true,
      },
      ports,
    );

    const second = startOperatorConsole(
      {
        behindProxy: false,
        host: "127.0.0.1",
        port: first.port,
        token: "t",
        tokenWasGenerated: true,
      },
      ports,
    );

    await expect(second).rejects.toThrow(/EADDRINUSE/u);
    await first.close();
  });
});

interface RecordedResponse {
  body?: string | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  status?: number | undefined;
  writeHeadCalls: number;
}

function fakeRequest(options: {
  body?: string;
  encrypted?: boolean;
  failure?: Error;
  headers?: Readonly<Record<string, string>>;
  method?: string;
  url?: string;
}): IncomingMessage {
  const stream =
    options.failure === undefined
      ? Readable.from([Buffer.from(options.body ?? "")])
      : new Readable({
          read() {
            this.destroy(options.failure);
          },
        });
  return Object.assign(stream, {
    headers: options.headers ?? {},
    method: options.method ?? "GET",
    socket: options.encrypted === true ? { encrypted: true } : {},
    url: options.url ?? "/",
  }) as unknown as IncomingMessage;
}

function fakeResponse(headersAlreadySent = false): {
  recorded: RecordedResponse;
  response: ServerResponse;
  settled: Promise<void>;
} {
  const recorded: RecordedResponse = { writeHeadCalls: 0 };
  let finish = (): void => undefined;
  const settled = new Promise<void>((done) => {
    finish = done;
  });
  let sent = headersAlreadySent;
  const response = {
    end(body?: string) {
      recorded.body = body;
      finish();
    },
    get headersSent() {
      return sent;
    },
    writeHead(status: number, headers: Readonly<Record<string, string>>) {
      sent = true;
      recorded.writeHeadCalls += 1;
      recorded.status = status;
      recorded.headers = headers;
      return response;
    },
  };
  return { recorded, response: response as unknown as ServerResponse, settled };
}

describe("what the binding reads from Node's request", () => {
  function ports() {
    return {
      fileSystem: memoryFileSystem().fileSystem,
      now: () => 0,
      sessions: createMemorySessionStore(),
      token: "operator-token",
    };
  }

  // A TLS connection is encrypted whatever any header says, and there is no
  // proxy in front to be trusted or doubted.
  it("treats a request on an encrypted socket as secure", async () => {
    const { recorded, response, settled } = fakeResponse();

    createOperatorRequestListener(ports())(
      fakeRequest({
        body: "token=operator-token",
        encrypted: true,
        method: "POST",
        url: "/login",
      }),
      response,
    );
    await settled;

    expect(recorded.status).toBe(303);
    expect(recorded.headers?.["set-cookie"]).toContain("Secure");
  });

  // The console narrows a list with a query, so the binding has to carry one.
  // The evidence page echoes the filter back into its own field, so a stripped
  // query shows up as an empty box rather than as a passing test.
  it("carries the query through to the page", async () => {
    const { fileSystem, files } = memoryFileSystem();
    files.set(
      "opencookie/sites.json",
      JSON.stringify({
        sites: [{ domains: ["shop.example.com"], name: "shop" }],
        version: 1,
      }),
    );
    const { recorded, response, settled } = fakeResponse();

    createOperatorRequestListener({
      fileSystem,
      now: () => 0,
      sessions: createMemorySessionStore(),
      token: "operator-token",
    })(
      fakeRequest({
        headers: { authorization: "Bearer operator-token" },
        url: "/sites/shop/evidence?consentId=visitor-2",
      }),
      response,
    );
    await settled;

    expect(recorded.status).toBe(200);
    expect(recorded.body).toContain('name="consentId" value="visitor-2"');
  });

  it("routes on the path even when a query is present", async () => {
    const { recorded, response, settled } = fakeResponse();

    createOperatorRequestListener(ports())(
      fakeRequest({ url: "/login?next=%2Fsites" }),
      response,
    );
    await settled;

    expect(recorded.status).toBe(200);
  });

  // A body that fails while being read is not a body that was too large, and
  // answering 413 would tell the caller something untrue about their request.
  it("does not report a failed read as a body that was too large", async () => {
    const complaint = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { recorded, response, settled } = fakeResponse();

    createOperatorRequestListener(ports())(
      fakeRequest({ failure: new Error("the connection went away") }),
      response,
    );
    await settled;
    complaint.mockRestore();

    expect(recorded.status).toBe(500);
    expect(recorded.headers?.["content-type"]).toContain("text/plain");
    expect(recorded.body).toContain("could not serve that request");
  });

  it("does not write a second set of headers over ones already sent", async () => {
    const complaint = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { recorded, response, settled } = fakeResponse(true);

    createOperatorRequestListener(ports())(
      fakeRequest({ failure: new Error("the connection went away") }),
      response,
    );
    await settled;
    complaint.mockRestore();

    expect(recorded.writeHeadCalls).toBe(0);
    expect(recorded.body).toContain("could not serve that request");
  });
});
