import { describe, expect, it, vi } from "vitest";

import {
  createMemorySessionStore,
  createSignInLimiter,
  handleOperatorRequest,
  runEvidenceCommand,
  runPolicyCommand,
  runFindingsCommand,
  selectSite,
  type FileSystemPort,
  type OperatorRequest,
  type OperatorSessionStore,
} from "./index.js";

function harness(initial: Readonly<Record<string, string>> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const fileSystem: FileSystemPort = {
    exists: (path) => Promise.resolve(files.has(path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing file: ${path}`);
      return Promise.resolve(value);
    },
    replaceFile: (path, previous, content) => {
      if (files.get(path) !== previous) {
        return Promise.reject(new Error(`Stale replace of ${path}`));
      }
      files.set(path, content);
      return Promise.resolve();
    },
    withLock: (_path, operation) => operation(),
    writeFile: (path, content) => {
      if (files.has(path)) throw new Error(`EEXIST: ${path}`);
      files.set(path, content);
      return Promise.resolve();
    },
  };
  return { fileSystem, files, sessions: createMemorySessionStore() };
}

function request(overrides: Partial<OperatorRequest> = {}): OperatorRequest {
  return { headers: {}, method: "GET", path: "/", ...overrides };
}

const TOKEN = "operator-token-abc";
const DAY = 86_400_000;
// Far enough from the epoch that a receipt a day old is still a valid time.
const CLOCK = 1_000 * DAY;

describe("the authenticated operator surface", () => {
  // The surface holds a site's policy and its visitors' consent evidence, so
  // an unauthenticated caller is refused before anything is read.
  it.each([
    ["no credential at all", {}],
    ["a wrong token", { authorization: "Bearer wrong" }],
    ["an empty bearer", { authorization: "Bearer " }],
    ["the token as a bare header", { authorization: TOKEN }],
  ])("refuses a request with %s", async (_label, headers) => {
    const context = harness();

    const response = await handleOperatorRequest(request({ headers }), {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    });

    expect(response.status).toBe(401);
    expect(response.body).not.toContain("site");
  });

  it("shows the operator their sites once authenticated", async () => {
    const context = harness({
      "opencookie/sites.json": JSON.stringify({
        sites: [{ domains: ["shop.example.test"], name: "shop" }],
        version: 1,
      }),
    });

    const response = await handleOperatorRequest(
      request({ headers: { authorization: `Bearer ${TOKEN}` } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/u);
    expect(response.body).toContain("shop");
    expect(response.body).toContain("shop.example.test");
  });

  it("says plainly when no site exists yet", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({ headers: { authorization: `Bearer ${TOKEN}` } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatch(/no sites/iu);
  });

  it("creates the first site from the surface", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: "name=shop&domain=shop.example.com",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        path: "/sites",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(303);
    const stored = JSON.parse(
      context.files.get("opencookie/sites.json") ?? "",
    ) as { sites: { domains: string[]; name: string }[] };
    expect(stored.sites).toEqual([
      { domains: ["shop.example.com"], name: "shop" },
    ]);
  });

  it("refuses to create a site without the token", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: "name=shop&domain=shop.example.com",
        method: "POST",
        path: "/sites",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(401);
    expect(context.files.has("opencookie/sites.json")).toBe(false);
  });

  // The registry's rules belong to the domain, not to each surface, so the
  // surface reports what the domain refused rather than inventing its own.
  it("reports a domain another site already owns", async () => {
    const context = harness({
      "opencookie/sites.json": JSON.stringify({
        sites: [{ domains: ["shop.example.com"], name: "shop" }],
        version: 1,
      }),
    });

    const response = await handleOperatorRequest(
      request({
        body: "name=shop-eu&domain=shop.example.com",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(400);
    expect(response.body).toContain("shop.example.com");
    expect(response.body).toContain("shop");
  });

  it("answers an unknown path with a not-found, not a page", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/admin.php",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(404);
  });

  // Whatever a registry holds is rendered into a page, so it is escaped. A
  // site name is operator input, and a stored file can be edited by hand.
  it("escapes what it renders instead of letting it become markup", async () => {
    const context = harness({
      "opencookie/sites.json": JSON.stringify({
        sites: [
          {
            domains: ["<img src=x onerror=alert(1)>"],
            name: "<script>alert(1)</script>",
          },
        ],
        version: 1,
      }),
    });

    const response = await handleOperatorRequest(
      request({ headers: { authorization: `Bearer ${TOKEN}` } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).not.toContain("<img src=x");
    expect(response.body).toContain("&lt;script&gt;");
  });

  // A hand-edited registry that no longer parses must not be shown as an empty
  // list, which would read as "this operator has no sites".
  it("reports an unreadable registry rather than showing no sites", async () => {
    const context = harness({ "opencookie/sites.json": "{ broken" });

    const response = await handleOperatorRequest(
      request({ headers: { authorization: `Bearer ${TOKEN}` } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(500);
    expect(response.body).toMatch(/failed validation/iu);
  });
});

describe("signing in to the operator surface", () => {
  async function signIn(context: {
    fileSystem: FileSystemPort;
    sessions: OperatorSessionStore;
  }): Promise<{ cookie: string; formToken: string }> {
    const response = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
        secure: true,
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );
    const setCookie = response.headers["set-cookie"] ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    const page = await handleOperatorRequest(request({ headers: { cookie } }), {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    });
    const formToken = /name="formToken" value="([^"]+)"/u.exec(page.body)?.[1];
    if (formToken === undefined) throw new Error("no form token in the page");
    return { cookie, formToken };
  }

  // A token can be guessed if guesses are free. After five wrong ones the
  // console answers "try later" for a while that doubles with each further
  // failure, whether the guess came from the form or a bearer header, and the
  // right token then works again.
  it("slows guessing after five wrong tokens, then accepts the right one", async () => {
    const context = harness();
    let now = CLOCK;
    const ports = {
      fileSystem: context.fileSystem,
      now: () => now,
      sessions: context.sessions,
      signInLimiter: createSignInLimiter(),
      token: TOKEN,
    };
    const signIn = (token: string) =>
      handleOperatorRequest(
        request({
          body: `token=${encodeURIComponent(token)}`,
          method: "POST",
          path: "/login",
        }),
        ports,
      );

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await signIn("wrong")).status).toBe(401);
    }
    expect(
      (
        await handleOperatorRequest(
          request({ headers: { authorization: "Bearer wrong" } }),
          ports,
        )
      ).status,
    ).toBe(401);

    const throttled = await signIn(TOKEN);
    expect(throttled.status).toBe(429);
    expect(throttled.headers["retry-after"]).toBe("1");
    expect(
      (
        await handleOperatorRequest(
          request({ headers: { authorization: `Bearer ${TOKEN}` } }),
          ports,
        )
      ).status,
    ).toBe(429);

    now += 1_000;
    expect((await signIn(TOKEN)).status).toBe(303);
    expect((await signIn("wrong")).status).toBe(401);
  });

  // Pass B's minor 1 on 0.2.0: any page open in the operator's browser could
  // post wrong tokens to /login and lock the operator out. A sign-in from
  // another site is refused before the limiter hears it.
  it("refuses a sign-in posted from another site, without counting it", async () => {
    const context = harness();
    const ports = {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      signInLimiter: createSignInLimiter(),
      token: TOKEN,
    };
    const signIn = (token: string, headers: Record<string, string> = {}) =>
      handleOperatorRequest(
        request({
          body: `token=${encodeURIComponent(token)}`,
          headers: { host: "127.0.0.1:4700", ...headers },
          method: "POST",
          path: "/login",
        }),
        ports,
      );

    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(
        (await signIn("wrong", { origin: "https://attacker.example" })).status,
      ).toBe(403);
      expect(
        (await signIn("wrong", { "sec-fetch-site": "cross-site" })).status,
      ).toBe(403);
    }

    expect(
      (
        await signIn(TOKEN, {
          origin: "http://127.0.0.1:4700",
          "sec-fetch-site": "same-origin",
        })
      ).status,
    ).toBe(303);
  });

  // A person cannot put a bearer header on a browser address bar, so the one
  // unauthenticated route is the sign-in page itself.
  it("serves a sign-in page to a caller with no credential", async () => {
    const context = harness();

    const response = await handleOperatorRequest(request({ path: "/login" }), {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('action="/login"');
    expect(response.body).toContain('type="password"');
  });

  it("starts a session when the operator presents the right token", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
        secure: true,
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers["location"]).toBe("/");
    const cookie = response.headers["set-cookie"] ?? "";
    expect(cookie).toContain("opencookie_operator=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  // The token is the only credential, so a refused sign-in must leave nothing
  // behind that a later request could present.
  it("refuses the wrong token and issues no cookie", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({ body: "token=wrong", method: "POST", path: "/login" }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("accepts the session the sign-in issued", async () => {
    const context = harness();
    const { cookie } = await signIn(context);

    const response = await handleOperatorRequest(
      request({ headers: { cookie } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("Create site");
  });

  it("refuses a session cookie it never issued", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({ headers: { cookie: "opencookie_operator=invented" } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(401);
  });

  it("ends the session on sign out, and the old cookie stops working", async () => {
    const context = harness();
    const { cookie, formToken } = await signIn(context);

    const out = await handleOperatorRequest(
      request({
        body: `formToken=${encodeURIComponent(formToken)}`,
        headers: { cookie },
        method: "POST",
        path: "/logout",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );
    const after = await handleOperatorRequest(
      request({ headers: { cookie } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(out.status).toBe(303);
    expect(out.headers["set-cookie"]).toContain("Max-Age=0");
    expect(after.status).toBe(401);
  });

  // A cookie travels on every request the browser makes, including one another
  // site provoked, so a write needs proof it came from this surface's own form.
  it("refuses a cookie-authenticated write with no form token", async () => {
    const context = harness();
    const { cookie } = await signIn(context);

    const response = await handleOperatorRequest(
      request({
        body: "name=shop&domain=shop.example.com",
        headers: { cookie },
        method: "POST",
        path: "/sites",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(403);
    expect(context.files.has("opencookie/sites.json")).toBe(false);
  });

  it("refuses a form token belonging to another session", async () => {
    const context = harness();
    const first = await signIn(context);
    const second = await signIn(context);

    const response = await handleOperatorRequest(
      request({
        body: `name=shop&domain=shop.example.com&formToken=${encodeURIComponent(second.formToken)}`,
        headers: { cookie: first.cookie },
        method: "POST",
        path: "/sites",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(403);
    expect(context.files.has("opencookie/sites.json")).toBe(false);
  });

  it("accepts a cookie-authenticated write carrying the session's form token", async () => {
    const context = harness();
    const { cookie, formToken } = await signIn(context);

    const response = await handleOperatorRequest(
      request({
        body: `name=shop&domain=shop.example.com&formToken=${encodeURIComponent(formToken)}`,
        headers: { cookie },
        method: "POST",
        path: "/sites",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(303);
    expect(context.files.get("opencookie/sites.json")).toContain(
      "shop.example.com",
    );
  });

  // Marking a cookie Secure on a plain connection would stop it being sent at
  // all; saying nothing about an unencrypted connection would hide a real risk.
  it("marks the cookie Secure only on an encrypted connection", async () => {
    const context = harness();

    const encrypted = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
        secure: true,
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );
    const plain = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(encrypted.headers["set-cookie"]).toContain("Secure");
    expect(plain.headers["set-cookie"]).not.toContain("Secure");
  });

  it("says so when the sign-in page is served over an unencrypted connection", async () => {
    const context = harness();

    const plain = await handleOperatorRequest(request({ path: "/login" }), {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    });
    const encrypted = await handleOperatorRequest(
      request({ path: "/login", secure: true }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(plain.body).toMatch(/not encrypted/iu);
    expect(encrypted.body).not.toMatch(/not encrypted/iu);
  });
});

describe("the in-memory operator session store", () => {
  it("reads back a session it created and forgets a destroyed one", () => {
    const store = createMemorySessionStore();

    const session = store.create();

    expect(store.read(session.id)?.formToken).toBe(session.formToken);
    store.destroy(session.id);
    expect(store.read(session.id)).toBeUndefined();
  });

  // Two sessions must not be guessable from one another.
  it("gives every session its own identifier and form token", () => {
    const store = createMemorySessionStore();

    const first = store.create();
    const second = store.create();

    expect(first.id).not.toBe(second.id);
    expect(first.formToken).not.toBe(second.formToken);
    expect(first.id.length).toBeGreaterThanOrEqual(32);
  });

  // The moment a session expires is the moment it stops being read, not the
  // moment after.
  it("forgets a session exactly when its lifetime runs out", () => {
    let now = 1_000;
    const store = createMemorySessionStore({ now: () => now, ttlMs: 60_000 });

    const session = store.create();
    now += 59_999;
    const justBefore = store.read(session.id);
    now += 1;
    const exactly = store.read(session.id);

    expect(justBefore).toBeDefined();
    expect(exactly).toBeUndefined();
  });

  // A store asked for no clock and no lifetime still has both, and twelve
  // hours is what an operator's session is worth.
  it("gives a session twelve hours when it is told nothing", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
      const store = createMemorySessionStore();
      const session = store.create();

      vi.setSystemTime(new Date("2026-09-22T11:59:59Z"));
      const justBefore = store.read(session.id);
      vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
      const atTwelve = store.read(session.id);

      expect(justBefore).toBeDefined();
      expect(atTwelve).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a session once its lifetime has passed", () => {
    let now = 1_000;
    const store = createMemorySessionStore({ now: () => now, ttlMs: 60_000 });

    const session = store.create();
    now += 59_999;
    const before = store.read(session.id);
    now += 2;
    const after = store.read(session.id);

    expect(before).toBeDefined();
    expect(after).toBeUndefined();
  });
});

const REGISTRY = JSON.stringify({
  sites: [{ domains: ["shop.example.com"], name: "shop" }],
  version: 1,
});

function observations(name = "_ga"): string {
  return JSON.stringify([
    {
      browser: "chromium-141",
      kind: "cookie",
      name,
      observedAt: "2026-09-21T10:00:00.000Z",
      source: "https://shop.example.com/",
      trigger: "page-load",
      uncertainty: "observed",
    },
  ]);
}

describe("reading a site's findings in the console", () => {
  async function withFindings(name?: string) {
    const context = harness({
      "observations.json": observations(name),
      "opencookie/sites.json": REGISTRY,
    });
    const selected = await selectSite(context.fileSystem, ["--site", "shop"]);
    if (!selected.ok) throw new Error(selected.message);
    const result = await runFindingsCommand(
      { fileSystem: selected.fileSystem, writeLine: () => undefined },
      ["import", "--from", "observations.json"],
    );
    if (!result.ok) throw new Error(result.message ?? "import refused");
    return context;
  }

  it("shows what a site's inventory holds", async () => {
    const context = await withFindings();

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("_ga");
    expect(response.body).toContain("unclassified");
  });

  it("says a site has no findings rather than showing an empty page", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatch(/no findings have been imported/iu);
  });

  // The refusal is the registry's own, so the console cannot disagree with the
  // terminal about which sites exist.
  it("refuses a site the registry does not have", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/warehouse/findings",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(404);
    expect(response.body).toContain("warehouse");
  });

  it("refuses to read findings without a credential", async () => {
    const context = await withFindings();

    const response = await handleOperatorRequest(
      request({ path: "/sites/shop/findings" }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.status).toBe(401);
    expect(response.body).not.toContain("_ga");
  });

  // A finding's name comes from whatever the site loaded, which is not this
  // operator's text and may be anything at all.
  it("escapes a finding name that carries markup", async () => {
    const context = await withFindings("<script>alert(1)</script>");

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).toContain("&lt;script&gt;");
  });

  it("links to each site's findings from the list of sites", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({ headers: { authorization: `Bearer ${TOKEN}` } }),
      {
        fileSystem: context.fileSystem,
        now: () => CLOCK,
        sessions: context.sessions,
        token: TOKEN,
      },
    );

    expect(response.body).toContain('href="/sites/shop/findings"');
  });
});

describe("a site's policy in the console", () => {
  function site() {
    return harness({ "opencookie/sites.json": REGISTRY });
  }

  function bearer(path: string, body?: string, method = "GET") {
    return request({
      ...(body === undefined ? {} : { body }),
      headers: { authorization: `Bearer ${TOKEN}` },
      method,
      path,
    });
  }

  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  it("says no policy is published for a new site", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      bearer("/sites/shop/policy"),
      ports(context),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatch(/no policy is published/iu);
  });

  it("writes a starter policy into the site's own directory", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      bearer("/sites/shop/policy/starter", "", "POST"),
      ports(context),
    );

    expect(response.status).toBe(303);
    expect(context.files.has("opencookie/sites/shop/policy.json")).toBe(true);
  });

  it("publishes a policy and then reports it as current", async () => {
    const context = site();
    await handleOperatorRequest(
      bearer("/sites/shop/policy/starter", "", "POST"),
      ports(context),
    );

    const published = await handleOperatorRequest(
      bearer(
        "/sites/shop/policy/publish",
        "id=2026-09-a&policy=opencookie/policy.json",
        "POST",
      ),
      ports(context),
    );
    const status = await handleOperatorRequest(
      bearer("/sites/shop/policy"),
      ports(context),
    );

    expect(published.status).toBe(303);
    expect(status.body).toContain("2026-09-a");
  });

  // The refusal is the policy domain's, not a second rule the console invented.
  it("reports the domain's refusal when a publication is incomplete", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      bearer("/sites/shop/policy/publish", "id=&policy=", "POST"),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatch(/--id|identifier|policy/iu);
  });

  it("refuses a cookie-authenticated publish with no form token", async () => {
    const context = site();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const cookie = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const response = await handleOperatorRequest(
      request({
        body: "id=2026-09-a&policy=opencookie/policy.json",
        headers: { cookie },
        method: "POST",
        path: "/sites/shop/policy/publish",
      }),
      ports(context),
    );

    expect(response.status).toBe(403);
    expect(
      context.files.has("opencookie/sites/shop/policy-publications.json"),
    ).toBe(false);
  });

  it("refuses a cookie-authenticated starter with no form token", async () => {
    const context = site();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const cookie = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const response = await handleOperatorRequest(
      request({
        headers: { cookie },
        method: "POST",
        path: "/sites/shop/policy/starter",
      }),
      ports(context),
    );

    expect(response.status).toBe(403);
    expect(context.files.has("opencookie/sites/shop/policy.json")).toBe(false);
  });

  it("refuses to read a policy without a credential", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      request({ path: "/sites/shop/policy" }),
      ports(context),
    );

    expect(response.status).toBe(401);
  });

  // Driving this by hand showed the defect: the starter was written and the
  // page said nothing, offering the same button again, which would be refused.
  it("offers a starter only while the site has none", async () => {
    const context = site();

    const before = await handleOperatorRequest(
      bearer("/sites/shop/policy"),
      ports(context),
    );
    await handleOperatorRequest(
      bearer("/sites/shop/policy/starter", "", "POST"),
      ports(context),
    );
    const after = await handleOperatorRequest(
      bearer("/sites/shop/policy"),
      ports(context),
    );

    expect(before.body).toContain("Write a starter policy");
    expect(after.body).not.toContain("Write a starter policy");
    expect(after.body).toContain("opencookie/policy.json");
    expect(after.body).toMatch(/ready|waiting|edit its wording/iu);
  });

  // A path the browser sent is not guaranteed to decode. Failing to read it is
  // not the same as a server that broke.
  it("treats a path it cannot decode as no such site", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      bearer("/sites/%/policy"),
      ports(context),
    );

    expect(response.status).toBe(404);
  });

  it("links to each site's policy from the list of sites", async () => {
    const context = site();

    const response = await handleOperatorRequest(bearer("/"), ports(context));

    expect(response.body).toContain('href="/sites/shop/policy"');
  });
});

function receipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    catalogueDigest: "sha256-catalogue",
    consentId: "visitor-1",
    decidedAt: CLOCK - DAY,
    decisionSurfaceDigest: "sha256-surface",
    decisions: [{ decision: "granted", purposeId: "analytics" }],
    idempotencyKey: "key-1",
    method: "accept-all",
    occurredAt: CLOCK - DAY,
    persistenceStatus: "confirmed",
    policyVersion: "1.0.0",
    revision: 1,
    schemaVersion: 2,
    transitionId: "transition-1",
    ...overrides,
  };
}

describe("a site's consent evidence in the console", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  async function withEvidence(overrides: Record<string, unknown> = {}) {
    const context = harness({
      "opencookie/sites.json": REGISTRY,
      "receipts.json": JSON.stringify([receipt(overrides)]),
    });
    const selected = await selectSite(context.fileSystem, ["--site", "shop"]);
    if (!selected.ok) throw new Error(selected.message);
    const result = await runEvidenceCommand(
      {
        fileSystem: selected.fileSystem,
        now: () => CLOCK,
        writeLine: () => undefined,
      },
      ["ingest", "--from", "receipts.json"],
    );
    if (!result.ok) throw new Error(result.message ?? "ingest refused");
    return context;
  }

  it("shows the receipts a site holds", async () => {
    const context = await withEvidence();

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence",
      }),
      ports(context),
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("visitor-1");
  });

  it("says a site holds no receipts rather than showing nothing", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence",
      }),
      ports(context),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatch(/0 receipt/iu);
  });

  // Consent evidence is a visitor's record, not public information.
  it("refuses to show evidence without a credential", async () => {
    const context = await withEvidence();

    const response = await handleOperatorRequest(
      request({ path: "/sites/shop/evidence" }),
      ports(context),
    );

    expect(response.status).toBe(401);
    expect(response.body).not.toContain("visitor-1");
  });

  it("escapes a consent identifier that carries markup", async () => {
    const context = await withEvidence({
      consentId: "<script>alert(1)</script>",
    });

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence",
      }),
      ports(context),
    );

    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).toContain("&lt;script&gt;");
  });

  it("links to each site's evidence from the list of sites", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({ headers: { authorization: `Bearer ${TOKEN}` } }),
      ports(context),
    );

    expect(response.body).toContain('href="/sites/shop/evidence"');
  });

  it("refuses evidence for a site the registry does not have", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/warehouse/evidence",
      }),
      ports(context),
    );

    expect(response.status).toBe(404);
  });
});

describe("the headers every console page carries", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  // Escaping is the first defence and these are the second. A console that
  // renders whatever a site loaded should not also be a page that can fetch,
  // frame or run anything.
  it.each([
    ["the sign-in page", "/login", {}],
    ["a page behind the token", "/", { authorization: `Bearer ${TOKEN}` }],
  ])("locks down %s", async (_label, path, headers) => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({ headers, path }),
      ports(context),
    );

    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "form-action 'self'",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    // Pages hold visitors' consent records; a shared cache must not keep them.
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("locks down a refusal as firmly as a page it serves", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({ headers: { authorization: "Bearer wrong" } }),
      ports(context),
    );

    expect(response.status).toBe(401);
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'none'",
    );
  });

  it("keeps the session cookie on a redirect that carries no page", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );

    expect(response.status).toBe(303);
    expect(response.headers["set-cookie"]).toContain("opencookie_operator=");
  });
});

describe("what the console must never let through", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  // A site name is rendered inside an attribute as well as between tags, so a
  // quote that survives escaping ends the attribute and starts another one.
  it.each([
    ["a double quote", '" onmouseover="alert(1)', "&quot;"],
    ["an apostrophe", "' onmouseover='alert(1)", "&#39;"],
    ["an ampersand", "a&b", "&amp;"],
  ])("escapes %s", async (_label, name, entity) => {
    const context = harness({
      "opencookie/sites.json": JSON.stringify({
        sites: [{ domains: ["shop.example.com"], name }],
        version: 1,
      }),
    });

    const response = await handleOperatorRequest(
      request({ headers: { authorization: `Bearer ${TOKEN}` } }),
      ports(context),
    );

    expect(response.body).toContain(entity);
    expect(response.body).not.toContain(name);
  });

  it("sends a signed-out operator back to the sign-in page", async () => {
    const context = harness();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const cookie = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";
    const formToken =
      /name="formToken" value="([^"]+)"/u.exec(
        (
          await handleOperatorRequest(
            request({ headers: { cookie } }),
            ports(context),
          )
        ).body,
      )?.[1] ?? "";

    const out = await handleOperatorRequest(
      request({
        body: `formToken=${encodeURIComponent(formToken)}`,
        headers: { cookie },
        method: "POST",
        path: "/logout",
      }),
      ports(context),
    );

    expect(out.headers["location"]).toBe("/login");
  });

  it("offers a way in when it refuses a caller", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({ headers: { authorization: "Bearer wrong" } }),
      ports(context),
    );

    expect(response.status).toBe(401);
    expect(response.body).toContain('href="/login"');
  });

  // A stored file that no longer reads is not an empty site. Each page has its
  // own store, so each one is asked separately.
  it.each([
    [
      "findings",
      "findings",
      "opencookie/sites/shop/findings.json",
      "Findings unavailable",
      /inventory could not be read/iu,
    ],
    [
      "policy",
      "policy",
      "opencookie/sites/shop/policy-publications.json",
      "Policy unavailable",
      /failed its integrity check/iu,
    ],
    [
      "evidence",
      "evidence",
      "opencookie/sites/shop/consent-evidence.json",
      "Evidence unavailable",
      /failed validation/iu,
    ],
  ])(
    "reports a %s store it cannot read, and why",
    async (_label, path, file, title, reason) => {
      const context = harness({
        "opencookie/sites.json": REGISTRY,
        [file]: "{ not json",
      });

      const response = await handleOperatorRequest(
        request({
          headers: { authorization: `Bearer ${TOKEN}` },
          path: `/sites/shop/${path}`,
        }),
        ports(context),
      );

      expect(response.status).toBe(500);
      expect(response.body).toContain(title);
      expect(response.body).toMatch(reason);
    },
  );
});

describe("what the console refuses to treat as a request it serves", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  function site() {
    return harness({ "opencookie/sites.json": REGISTRY });
  }

  // A route is a method and a path together. Answering a POST with the page a
  // GET returns would let a link or a form reach a page that reads a site's
  // evidence, and answering a GET where a write lives invites the reverse.
  it.each([
    ["POST", "/sites/shop/findings"],
    ["POST", "/sites/shop/policy"],
    ["POST", "/sites/shop/evidence"],
    ["GET", "/sites/shop/policy/publish"],
    ["GET", "/sites/shop/policy/starter"],
    ["POST", "/"],
    ["GET", "/sites"],
    ["GET", "/logout"],
  ])("does not serve %s %s", async (method, path) => {
    const context = site();

    const response = await handleOperatorRequest(
      request({
        body: "",
        headers: { authorization: `Bearer ${TOKEN}` },
        method,
        path,
      }),
      ports(context),
    );

    expect(response.status).toBe(404);
  });

  // A browser sends every cookie it holds for the host, in one header, and
  // some of them have no value at all.
  it("finds its own session among the other cookies a browser sends", async () => {
    const context = site();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const own = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const response = await handleOperatorRequest(
      request({
        headers: { cookie: `theme=dark; consent; ${own} ; other=1` },
      }),
      ports(context),
    );

    expect(response.status).toBe(200);
    expect(response.body).toContain("Create site");
  });

  // A redirect is an instruction, not a page: anything in its body is content
  // this console never meant to serve.
  it.each([
    [
      "signing in",
      {
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      },
    ],
  ])("returns no body with the redirect for %s", async (_label, overrides) => {
    const context = site();

    const response = await handleOperatorRequest(
      request(overrides),
      ports(context),
    );

    expect(response.status).toBe(303);
    expect(response.body).toBe("");
  });

  it("returns no body when a site is created", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: "name=shop&domain=shop.example.com",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites",
      }),
      ports(context),
    );

    expect(response.status).toBe(303);
    expect(response.body).toBe("");
  });

  // A form field that never arrived is not a field holding something else.
  it("refuses a site with no domain instead of inventing one", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: "name=shop",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites",
      }),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(context.files.has("opencookie/sites.json")).toBe(false);
  });

  it("refuses a publication with no policy file instead of inventing one", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      request({
        body: "id=2026-09-a",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/policy/publish",
      }),
      ports(context),
    );

    expect(response.status).toBe(400);
  });
});

describe("what the console tells an operator when it will not act", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  // A sign-in that was refused is still a sign-in page, and it is still the
  // page where a token gets typed, so it must carry the same warning.
  it.each([
    ["an unencrypted connection", false, true],
    ["an encrypted one", true, false],
  ])("warns on a refused sign-in over %s", async (_label, secure, warned) => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: "token=wrong",
        method: "POST",
        path: "/login",
        ...(secure ? { secure: true } : {}),
      }),
      ports(context),
    );

    expect(response.status).toBe(401);
    expect(response.body).toContain("That token was not accepted");
    expect(/not encrypted/iu.test(response.body)).toBe(warned);
  });

  it("says in the domain's words why a site was not created", async () => {
    const context = harness({
      "opencookie/sites.json": JSON.stringify({
        sites: [{ domains: ["shop.example.com"], name: "shop" }],
        version: 1,
      }),
    });

    const response = await handleOperatorRequest(
      request({
        body: "name=other&domain=shop.example.com",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites",
      }),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(response.body).toContain("Site not created");
    expect(response.body).toContain("shop.example.com");
  });

  it("says in the domain's words why a publication was refused", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        body: "id=2026-09-a&policy=opencookie/policy.json",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/policy/publish",
      }),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(response.body).toContain("Not done");
    expect(response.body).toMatch(/opencookie\/policy\.json/u);
  });

  // Where a redirect sends the operator is the whole of its meaning.
  it("sends a created site back to the list", async () => {
    const context = harness();

    const response = await handleOperatorRequest(
      request({
        body: "name=shop&domain=shop.example.com",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites",
      }),
      ports(context),
    );

    expect(response.headers["location"]).toBe("/");
  });

  it("sends a written starter back to that site's policy", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        body: "",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/policy/starter",
      }),
      ports(context),
    );

    expect(response.headers["location"]).toBe("/sites/shop/policy");
  });

  // Only a path that begins at /sites is one of this console's site paths.
  it("does not treat a path that merely contains /sites as one of its own", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/elsewhere/sites/shop/findings",
      }),
      ports(context),
    );

    expect(response.status).toBe(404);
  });

  it("reads a session cookie whose name is a single character away", async () => {
    const context = harness();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const own = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const response = await handleOperatorRequest(
      request({ headers: { cookie: `a=1; ${own}` } }),
      ports(context),
    );

    expect(response.status).toBe(200);
  });
});

describe("deciding what a finding is, from the console", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  async function withFinding() {
    const context = harness({
      "observations.json": observations("_ga"),
      "opencookie/sites.json": REGISTRY,
    });
    const selected = await selectSite(context.fileSystem, ["--site", "shop"]);
    if (!selected.ok) throw new Error(selected.message);
    const imported = await runFindingsCommand(
      { fileSystem: selected.fileSystem, writeLine: () => undefined },
      ["import", "--from", "observations.json"],
    );
    if (!imported.ok) throw new Error(imported.message ?? "import refused");
    return context;
  }

  const decision = {
    category: "analytics-data",
    cleanup: "deleted",
    disclosure: "Counts visits so we can see which pages are read.",
    kind: "cookie",
    name: "_ga",
    purpose: "analytics",
    retention: "13 months",
    service: "Analytics",
    vendor: "Example Analytics",
  };

  it("offers a way to decide an unclassified finding", async () => {
    const context = await withFinding();

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      ports(context),
    );

    expect(response.body).toContain('action="/sites/shop/findings/classify"');
    expect(response.body).toContain('name="purpose"');
    expect(response.body).toContain('name="disclosure"');
  });

  it("records a decision and shows the finding as classified", async () => {
    const context = await withFinding();

    const recorded = await handleOperatorRequest(
      request({
        body: new URLSearchParams(decision).toString(),
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/findings/classify",
      }),
      ports(context),
    );
    const listed = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      ports(context),
    );

    expect(recorded.status).toBe(303);
    expect(recorded.headers["location"]).toBe("/sites/shop/findings");
    expect(listed.body).toContain("classified");
    expect(listed.body).toContain("Example Analytics");
  });

  // The console holds no rules of its own about what a decision must contain.
  it("reports the domain's refusal of an incomplete decision", async () => {
    const context = await withFinding();

    const response = await handleOperatorRequest(
      request({
        body: "name=_ga&kind=cookie",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/findings/classify",
      }),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatch(/classify requires/iu);
  });

  it("refuses a cookie-authenticated decision with no form token", async () => {
    const context = await withFinding();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const cookie = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const response = await handleOperatorRequest(
      request({
        body: new URLSearchParams(decision).toString(),
        headers: { cookie },
        method: "POST",
        path: "/sites/shop/findings/classify",
      }),
      ports(context),
    );
    const listed = await handleOperatorRequest(
      request({ headers: { cookie }, path: "/sites/shop/findings" }),
      ports(context),
    );

    expect(response.status).toBe(403);
    expect(listed.body).not.toContain("Example Analytics");
  });

  it("refuses a decision without a credential", async () => {
    const context = await withFinding();

    const response = await handleOperatorRequest(
      request({
        body: new URLSearchParams(decision).toString(),
        method: "POST",
        path: "/sites/shop/findings/classify",
      }),
      ports(context),
    );

    expect(response.status).toBe(401);
  });

  // Whether something is strictly necessary decides whether a visitor is asked
  // about it at all, so the checkbox has to reach the decision.
  it("records a finding marked strictly necessary as necessary", async () => {
    const context = await withFinding();

    await handleOperatorRequest(
      request({
        body: new URLSearchParams({ ...decision, necessary: "yes" }).toString(),
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/findings/classify",
      }),
      ports(context),
    );
    const listed = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      ports(context),
    );

    expect(listed.body).toContain("necessary");
  });

  it("records a finding left unticked as not necessary", async () => {
    const context = await withFinding();

    await handleOperatorRequest(
      request({
        body: new URLSearchParams(decision).toString(),
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/findings/classify",
      }),
      ports(context),
    );
    const listed = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      ports(context),
    );

    expect(listed.body).not.toContain("necessary");
  });

  // A finding that is already decided does not need deciding again, and the
  // form would only invite a second answer to a settled question.
  it("stops offering the form once every finding is decided", async () => {
    const context = await withFinding();
    await handleOperatorRequest(
      request({
        body: new URLSearchParams(decision).toString(),
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/findings/classify",
      }),
      ports(context),
    );

    const listed = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/findings",
      }),
      ports(context),
    );

    expect(listed.body).not.toContain('action="/sites/shop/findings/classify"');
  });
});

describe("working with a site's consent evidence from the console", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  async function seed(overrides: Record<string, unknown>[] = [{}]) {
    const context = harness({
      "opencookie/sites.json": REGISTRY,
      "receipts.json": JSON.stringify(overrides.map((o) => receipt(o))),
    });
    const selected = await selectSite(context.fileSystem, ["--site", "shop"]);
    if (!selected.ok) throw new Error(selected.message);
    const result = await runEvidenceCommand(
      {
        fileSystem: selected.fileSystem,
        now: () => CLOCK,
        writeLine: () => undefined,
      },
      ["ingest", "--from", "receipts.json"],
    );
    if (!result.ok) throw new Error(result.message ?? "ingest refused");
    return context;
  }

  function post(path: string, body: string) {
    return request({
      body,
      headers: { authorization: `Bearer ${TOKEN}` },
      method: "POST",
      path,
    });
  }

  it("narrows the receipts shown to one visitor", async () => {
    const context = await seed([
      {},
      { consentId: "visitor-2", idempotencyKey: "key-2", transitionId: "t2" },
    ]);

    const all = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence",
      }),
      ports(context),
    );
    const one = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence?consentId=visitor-2",
      }),
      ports(context),
    );

    expect(all.body).toContain("visitor-1");
    expect(all.body).toContain("visitor-2");
    expect(one.body).toContain("visitor-2");
    expect(one.body).not.toContain("visitor-1");
  });

  it("reports the domain's refusal of a date it cannot read", async () => {
    const context = await seed();

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence?since=yesterday",
      }),
      ports(context),
    );

    expect(response.status).toBe(500);
    expect(response.body).toMatch(/not a date/iu);
  });

  // Erasure is a visitor's right, so the console has to be able to do it.
  it("erases one visitor's receipts and says how many went", async () => {
    const context = await seed([
      {},
      { consentId: "visitor-2", idempotencyKey: "key-2", transitionId: "t2" },
    ]);

    const erased = await handleOperatorRequest(
      post("/sites/shop/evidence/delete", "consentId=visitor-1"),
      ports(context),
    );
    const left = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence",
      }),
      ports(context),
    );

    expect(erased.status).toBe(303);
    // Pass B's nit 1 on 0.2.0: the redirect carried the erased id into the
    // browser's history and any access log.
    expect(erased.headers["location"]).not.toContain("visitor-1");
    expect(left.body).not.toContain("visitor-1");
    expect(left.body).toContain("visitor-2");
  });

  it("refuses an erasure that names nobody", async () => {
    const context = await seed();

    const response = await handleOperatorRequest(
      post("/sites/shop/evidence/delete", "consentId="),
      ports(context),
    );
    const left = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence",
      }),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(left.body).toContain("visitor-1");
  });

  it("applies a retention period and says what it removed", async () => {
    const context = await seed([
      {},
      {
        consentId: "visitor-old",
        decidedAt: CLOCK - 400 * DAY,
        idempotencyKey: "key-old",
        occurredAt: CLOCK - 400 * DAY,
        transitionId: "t-old",
      },
    ]);

    const applied = await handleOperatorRequest(
      post("/sites/shop/evidence/retain", "days=30"),
      ports(context),
    );
    const left = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/evidence",
      }),
      ports(context),
    );

    expect(applied.status).toBe(303);
    expect(left.body).not.toContain("visitor-old");
    expect(left.body).toContain("visitor-1");
  });

  it("reports the domain's refusal of a retention period it cannot use", async () => {
    const context = await seed();

    const response = await handleOperatorRequest(
      post("/sites/shop/evidence/retain", "days=0"),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatch(/positive whole number/iu);
  });

  it("exports the receipts to a file inside the site", async () => {
    const context = await seed();

    const exported = await handleOperatorRequest(
      post("/sites/shop/evidence/export", "out=opencookie/export.json"),
      ports(context),
    );

    expect(exported.status).toBe(303);
    expect(context.files.get("opencookie/sites/shop/export.json")).toContain(
      "visitor-1",
    );
  });

  // Erasure in the console must not look complete while an export made from
  // this console still holds the visitor.
  it("shows which earlier exports still hold an erased visitor", async () => {
    const context = await seed();
    await handleOperatorRequest(
      post(
        "/sites/shop/evidence/export",
        "out=opencookie/dsar.json&consentId=visitor-1",
      ),
      ports(context),
    );

    const erased = await handleOperatorRequest(
      post("/sites/shop/evidence/delete", "consentId=visitor-1"),
      ports(context),
    );

    expect(erased.status).toBe(200);
    expect(erased.body).toContain("opencookie/dsar.json");
  });

  // Receipts are personal data, and the console says an export stays inside the
  // site. A path in the web root, or into another site's data, must be refused.
  it.each([
    "public/consent-evidence.json",
    "consent-evidence.json",
    "./opencookie/export.json",
    "opencookie/../public/export.json",
    "opencookie/",
  ])("refuses to export to %s, outside the site's data", async (out) => {
    const context = await seed();
    const before = new Set(context.files.keys());

    const exported = await handleOperatorRequest(
      post("/sites/shop/evidence/export", `out=${encodeURIComponent(out)}`),
      ports(context),
    );

    expect(exported.status).toBe(400);
    expect(exported.body).toContain("opencookie/");
    expect([...context.files.keys()].filter((key) => !before.has(key))).toEqual(
      [],
    );
  });

  // Driving this by hand found the defect: the button says "these receipts"
  // over a filtered list, and it was exporting all of them.
  it("exports the receipts the page was showing, not every receipt", async () => {
    const context = await seed([
      {},
      { consentId: "visitor-2", idempotencyKey: "key-2", transitionId: "t2" },
    ]);

    const exported = await handleOperatorRequest(
      post(
        "/sites/shop/evidence/export",
        "out=opencookie/export.json&consentId=visitor-2",
      ),
      ports(context),
    );
    const written =
      context.files.get("opencookie/sites/shop/export.json") ?? "";

    expect(exported.status).toBe(303);
    expect(written).toContain("visitor-2");
    expect(written).not.toContain("visitor-1");
  });

  // A consent id comes from the visitor's browser, so it may look like a flag.
  // It must still name exactly that visitor, never widen to everyone.
  it.each(["-dashvisitor", "--dashvisitor"])(
    "exports and erases only the visitor whose consent id is %s",
    async (consentId) => {
      const context = await seed([
        { consentId },
        { consentId: "visitor-2", idempotencyKey: "key-2", transitionId: "t2" },
      ]);
      const field = encodeURIComponent(consentId);

      const exported = await handleOperatorRequest(
        post(
          "/sites/shop/evidence/export",
          `out=opencookie/export.json&consentId=${field}`,
        ),
        ports(context),
      );
      const written =
        context.files.get("opencookie/sites/shop/export.json") ?? "";
      const erased = await handleOperatorRequest(
        post("/sites/shop/evidence/delete", `consentId=${field}`),
        ports(context),
      );
      const left = await handleOperatorRequest(
        request({
          headers: { authorization: `Bearer ${TOKEN}` },
          path: "/sites/shop/evidence",
        }),
        ports(context),
      );

      expect(exported.status).toBe(303);
      expect(written).toContain(consentId);
      expect(written).not.toContain("visitor-2");
      // The export made just before still holds the visitor, and says so.
      expect(erased.status).toBe(200);
      expect(erased.body).toContain("opencookie/export.json");
      expect(left.body).not.toContain(consentId);
      expect(left.body).toContain("visitor-2");
    },
  );

  it("returns to the list the operator was looking at", async () => {
    const context = await seed();

    const response = await handleOperatorRequest(
      post(
        "/sites/shop/evidence/export",
        "out=opencookie/export.json&consentId=visitor-1",
      ),
      ports(context),
    );

    expect(response.headers["location"]).toBe(
      "/sites/shop/evidence?consentId=visitor-1",
    );
  });

  // Every one of these changes or discloses a visitor's record.
  it.each([
    ["delete", "consentId=visitor-1"],
    ["retain", "days=30"],
    ["export", "out=opencookie/export.json"],
  ])("refuses %s with a cookie and no form token", async (action, body) => {
    const context = await seed();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const cookie = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const response = await handleOperatorRequest(
      request({
        body,
        headers: { cookie },
        method: "POST",
        path: `/sites/shop/evidence/${action}`,
      }),
      ports(context),
    );
    const left = await handleOperatorRequest(
      request({ headers: { cookie }, path: "/sites/shop/evidence" }),
      ports(context),
    );

    expect(response.status).toBe(403);
    expect(left.body).toContain("visitor-1");
    expect(context.files.has("opencookie/sites/shop/export.json")).toBe(false);
  });

  // Only the three named actions are run. `ingest` is a real evidence
  // subcommand, and reaching it through a URL would let the console write
  // receipts nobody recorded.
  it.each(["ingest", "query", "anything"])(
    "does not run evidence/%s",
    async (action) => {
      const context = await seed();

      const response = await handleOperatorRequest(
        post(`/sites/shop/evidence/${action}`, "from=receipts.json"),
        ports(context),
      );

      expect(response.status).toBe(404);
    },
  );

  it.each([
    ["delete", "consentId=visitor-1"],
    ["retain", "days=30"],
    ["export", "out=opencookie/export.json"],
  ])("refuses %s without a credential", async (action, body) => {
    const context = await seed();

    const response = await handleOperatorRequest(
      request({
        body,
        method: "POST",
        path: `/sites/shop/evidence/${action}`,
      }),
      ports(context),
    );

    expect(response.status).toBe(401);
  });
});

describe("installing the published policy from the console", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  async function published() {
    const context = harness({ "opencookie/sites.json": REGISTRY });
    const selected = await selectSite(context.fileSystem, ["--site", "shop"]);
    if (!selected.ok) throw new Error(selected.message);
    const run = async (args: readonly string[]) => {
      const result = await runPolicyCommand(
        { fileSystem: selected.fileSystem, writeLine: () => undefined },
        args,
      );
      if (!result.ok)
        throw new Error(`${String(args[0])}: ${result.message ?? ""}`);
    };
    await run(["starter"]);
    await run([
      "publish",
      "--id",
      "2026-09-a",
      "--policy",
      "opencookie/policy.json",
    ]);
    return context;
  }

  function post(path: string, body = "") {
    return request({
      body,
      headers: { authorization: `Bearer ${TOKEN}` },
      method: "POST",
      path,
    });
  }

  // The doctor says a site is not enforcing what it published and names the
  // command that fixes it. The console can simply run it.
  it("installs the live publication so the site enforces it", async () => {
    const context = await published();

    const installed = await handleOperatorRequest(
      post("/sites/shop/policy/install"),
      ports(context),
    );
    const doctor = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/doctor",
      }),
      ports(context),
    );

    expect(installed.status).toBe(303);
    // The installed module is the consumer's own source, so it sits at the
    // project root rather than inside the site's data directory.
    expect(context.files.get("opencookie.policy.ts")).toContain(
      "policyVersion",
    );
    expect(doctor.body).not.toContain("installed-policy-stale");
  });

  it("reports the domain's refusal when nothing is published to install", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      post("/sites/shop/policy/install"),
      ports(context),
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatch(/nothing to install/iu);
  });

  it("refuses a cookie-authenticated install with no form token", async () => {
    const context = await published();
    const signedIn = await handleOperatorRequest(
      request({
        body: `token=${encodeURIComponent(TOKEN)}`,
        method: "POST",
        path: "/login",
      }),
      ports(context),
    );
    const cookie = (signedIn.headers["set-cookie"] ?? "").split(";")[0] ?? "";

    const response = await handleOperatorRequest(
      request({
        headers: { cookie },
        method: "POST",
        path: "/sites/shop/policy/install",
      }),
      ports(context),
    );

    expect(response.status).toBe(403);
    expect(context.files.has("opencookie.policy.ts")).toBe(false);
  });

  it("refuses to install without a credential", async () => {
    const context = await published();

    const response = await handleOperatorRequest(
      request({ method: "POST", path: "/sites/shop/policy/install" }),
      ports(context),
    );

    expect(response.status).toBe(401);
  });

  it("offers the install on the policy page once something is published", async () => {
    const context = await published();

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/policy",
      }),
      ports(context),
    );

    expect(response.body).toContain('action="/sites/shop/policy/install"');
  });

  it("does not offer an install when nothing is published", async () => {
    const context = harness({ "opencookie/sites.json": REGISTRY });

    const response = await handleOperatorRequest(
      request({
        headers: { authorization: `Bearer ${TOKEN}` },
        path: "/sites/shop/policy",
      }),
      ports(context),
    );

    expect(response.body).not.toContain('action="/sites/shop/policy/install"');
  });
});

describe("inspecting what a site actually enforces", () => {
  function ports(context: ReturnType<typeof harness>) {
    return {
      fileSystem: context.fileSystem,
      now: () => CLOCK,
      sessions: context.sessions,
      token: TOKEN,
    };
  }

  function site() {
    return harness({ "opencookie/sites.json": REGISTRY });
  }

  function read(path: string, headers = { authorization: `Bearer ${TOKEN}` }) {
    return request({ headers, path });
  }

  it("shows what the doctor reports for a site", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      read("/sites/shop/doctor"),
      ports(context),
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatch(/opencookie doctor/iu);
  });

  // A site with nothing published has problems, and the page must not read as
  // though everything were fine.
  it("says a site has problems when the doctor found some", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      read("/sites/shop/doctor"),
      ports(context),
    );

    expect(response.body).toMatch(/problem/iu);
  });

  it("refuses to report on a site the registry does not have", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      read("/sites/warehouse/doctor"),
      ports(context),
    );

    expect(response.status).toBe(404);
  });

  it("refuses to report without a credential", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      request({ path: "/sites/shop/doctor" }),
      ports(context),
    );

    expect(response.status).toBe(401);
  });

  // The root of a project and a site inside it hold different data, so a
  // report that read the wrong one would describe a site nobody asked about.
  it("reports on the site's own data, not the project root's", async () => {
    const context = harness({
      "opencookie/findings.json": JSON.stringify({ findings: [] }),
      "opencookie/sites.json": REGISTRY,
      "opencookie/sites/shop/findings.json": "{ not json",
    });

    const response = await handleOperatorRequest(
      read("/sites/shop/doctor"),
      ports(context),
    );

    expect(response.body).toContain("findings-inventory-unreadable");
    expect(response.body).not.toContain("findings-not-imported");
  });

  // A site that is enforcing what it published must not be shown a warning
  // about not enforcing what it published.
  it("does not warn a site that has no problems", async () => {
    const context = site();
    const selected = await selectSite(context.fileSystem, ["--site", "shop"]);
    if (!selected.ok) throw new Error(selected.message);
    const run = async (args: readonly string[]) => {
      const result = await runPolicyCommand(
        { fileSystem: selected.fileSystem, writeLine: () => undefined },
        args,
      );
      if (!result.ok)
        throw new Error(`${String(args[0])}: ${result.message ?? ""}`);
    };
    await run(["starter"]);
    await run([
      "publish",
      "--id",
      "2026-09-a",
      "--policy",
      "opencookie/policy.json",
    ]);
    await run(["declaration"]);
    await run(["install"]);

    const response = await handleOperatorRequest(
      read("/sites/shop/doctor"),
      ports(context),
    );

    expect(response.body).toMatch(/no problems found/iu);
    expect(response.body).not.toMatch(/not enforcing what it published/iu);
  });

  it("says what a problem means rather than listing it and stopping", async () => {
    const context = site();

    const withProblems = await handleOperatorRequest(
      read("/sites/shop/doctor"),
      ports(context),
    );

    expect(withProblems.body).toMatch(/not enforcing what it published/iu);
  });

  it("escapes what the doctor wrote", async () => {
    const context = harness({
      "opencookie/sites.json": REGISTRY,
      "opencookie/sites/shop/findings.json": "{ not json",
    });

    const response = await handleOperatorRequest(
      read("/sites/shop/doctor"),
      ports(context),
    );

    expect(response.body).not.toContain("<script>");
    expect(response.status).toBe(200);
  });

  it("links to each site's doctor from the list of sites", async () => {
    const context = site();

    const response = await handleOperatorRequest(read("/"), ports(context));

    expect(response.body).toContain('href="/sites/shop/doctor"');
  });

  // The doctor only reads. Asking it to act would be a different thing.
  it("does not run the doctor on a POST", async () => {
    const context = site();

    const response = await handleOperatorRequest(
      request({
        body: "",
        headers: { authorization: `Bearer ${TOKEN}` },
        method: "POST",
        path: "/sites/shop/doctor",
      }),
      ports(context),
    );

    expect(response.status).toBe(404);
  });
});
