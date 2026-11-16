import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import {
  bootstrapOpenCookie,
  createBlockedIframeController,
  createBlockedScriptController,
} from "./index.js";
import { parseDeclaredStores } from "./storage-cleanup.js";

// Pass B's M-C: after a withdrawal the tracker's cookie and localStorage entry
// survived, even across a reload. A resource may declare what it stores, and
// that storage is deleted whenever the resource is blocked.

interface StoredCookie {
  readonly domain: string;
  readonly hostOnly: boolean;
  readonly name: string;
  readonly path: string;
  readonly value: string;
}

// happy-dom's cookie jar leaves an emptied cookie behind on Max-Age=0 and
// deletes a Domain cookie through a host-only write, so it cannot show which
// writes a real browser would honour. This jar keeps RFC 6265bis identity:
// name, domain, host-only flag and path.
function installCookieJar(window: Window, cookies: readonly string[]) {
  const url = new URL(window.location.href);
  const jar: StoredCookie[] = [];
  const writes: string[] = [];
  const visible = (cookie: StoredCookie) =>
    (cookie.hostOnly
      ? url.hostname === cookie.domain
      : url.hostname === cookie.domain ||
        url.hostname.endsWith(`.${cookie.domain}`)) &&
    (cookie.path === "/" ||
      url.pathname === cookie.path ||
      url.pathname.startsWith(`${cookie.path}/`));
  const write = (source: string) => {
    const [pair = "", ...attributes] = source
      .split(";")
      .map((part) => part.trim());
    const [name = "", value = ""] = pair.split("=");
    const read = (key: string) =>
      attributes
        .find((attribute) =>
          attribute.toLowerCase().startsWith(`${key.toLowerCase()}=`),
        )
        ?.split("=")[1];
    const domain = read("Domain");
    if (
      domain !== undefined &&
      url.hostname !== domain &&
      !url.hostname.endsWith(`.${domain}`)
    ) {
      return;
    }
    if (
      name.startsWith("__Host-") &&
      (domain !== undefined || read("Path") !== "/")
    ) {
      return;
    }
    const cookie = {
      domain: domain ?? url.hostname,
      hostOnly: domain === undefined,
      name,
      path: read("Path") ?? "/",
      value,
    };
    const index = jar.findIndex(
      (existing) =>
        existing.name === cookie.name &&
        existing.domain === cookie.domain &&
        existing.hostOnly === cookie.hostOnly &&
        existing.path === cookie.path,
    );
    if (index >= 0) jar.splice(index, 1);
    if (read("Max-Age") !== "0") jar.push(cookie);
  };
  for (const cookie of cookies) write(cookie);
  Object.defineProperty(window.document, "cookie", {
    configurable: true,
    get: () =>
      jar
        .filter(visible)
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; "),
    set: (source: string) => {
      writes.push(source);
      write(source);
    },
  });
  return { jar, writes };
}

function pageWith(url: string, markup: string) {
  const window = new Window({ url });
  window.document.body.innerHTML = markup;
  return window;
}

describe("parseDeclaredStores", () => {
  it("reads cookie, local and session names, with a trailing * as a prefix", () => {
    expect(parseDeclaredStores("  cookie:_trk local:ph_*\nsession:x ")).toEqual(
      [
        { kind: "cookie", name: "_trk", prefix: false },
        { kind: "local", name: "ph_", prefix: true },
        { kind: "session", name: "x", prefix: false },
      ],
    );
  });

  // A container that serves several purposes scopes what each one's tags
  // write, so turning one off deletes only its storage.
  it("reads a purpose a declaration is scoped to", () => {
    expect(parseDeclaredStores("advertising=cookie:_ad_* local:x")).toEqual([
      { kind: "cookie", name: "_ad_", prefix: true, purposeId: "advertising" },
      { kind: "local", name: "x", prefix: false },
    ]);
  });

  it.each([
    "cookie:*",
    "cookie:",
    "cookie:a*b",
    "cookie:*a",
    "idb:x",
    "_trk",
    "=cookie:x",
    "advertising=",
    "advertising=idb:x",
  ])("refuses %s", (token) => {
    expect(() => parseDeclaredStores(token)).toThrow(/data-oc-stores/u);
  });
});

describe("deleting declared storage", () => {
  const markup = [
    '<script type="text/plain" data-src="/t.js" data-oc-resource="tracker"',
    ' data-oc-category="analytics"',
    ' data-oc-stores="cookie:_trk cookie:ph_* local:_trk session:ph_*"></script>',
    '<script type="text/plain" data-src="/o.js" data-oc-resource="other"',
    ' data-oc-category="analytics" data-oc-stores="cookie:keep"></script>',
  ].join("");

  it("deletes the resource's declared cookies at every domain and path it can see", async () => {
    const window = pageWith("https://www.shop.example.test/a/b", markup);
    const { jar } = installCookieJar(window, [
      "_trk=1; Domain=shop.example.test; Path=/a",
      "_trk=2; Path=/a/b",
      "ph_abc=1; Domain=example.test; Path=/",
      "keep=1; Path=/",
      "unrelated=1; Path=/",
    ]);
    const controller = createBlockedScriptController({
      document: window.document as unknown as Document,
      resourceId: "tracker",
    });

    await controller.cleanup();

    expect(jar.map((cookie) => cookie.name).sort()).toEqual([
      "keep",
      "unrelated",
    ]);
    window.close();
  });

  // A browser refuses a Domain that is a public suffix or part of an IP
  // address (RFC 6265 5.1.3 and 5.3), and Firefox logs each refused write as
  // a console error on every withdrawal.
  it.each([
    [
      "https://www.shop.example.test/",
      ["www.shop.example.test", "shop.example.test", "example.test"],
    ],
    ["https://shop.example.test/", ["shop.example.test", "example.test"]],
    ["http://127.0.0.1:4173/", ["127.0.0.1"]],
    ["http://localhost:4173/", ["localhost"]],
  ])("on %s, writes only domains a browser accepts", async (url, accepted) => {
    const window = pageWith(url, markup);
    const { hostname } = new URL(url);
    const { jar, writes } = installCookieJar(window, [
      "_trk=1; Path=/",
      `_trk=2; Domain=${accepted.at(-1) ?? ""}; Path=/`,
    ]);

    await createBlockedScriptController({
      document: window.document as unknown as Document,
      resourceId: "tracker",
    }).cleanup();

    expect(jar).toEqual([]);
    const domains = new Set(
      writes.map((write) => /; Domain=([^;]+)/u.exec(write)?.[1] ?? hostname),
    );
    expect([...domains].sort()).toEqual([...accepted].sort());
    window.close();
  });

  it("deletes a __Host- cookie only as the prefix allows", async () => {
    const window = pageWith(
      "https://shop.example.test/",
      '<script type="text/plain" data-oc-resource="tracker" data-oc-stores="cookie:__Host-id"></script>',
    );
    const { jar, writes } = installCookieJar(window, [
      "__Host-id=1; Path=/; Secure",
    ]);

    await createBlockedScriptController({
      document: window.document as unknown as Document,
      resourceId: "tracker",
    }).cleanup();

    expect(jar).toEqual([]);
    expect(writes).toEqual(["__Host-id=; Max-Age=0; Path=/; Secure"]);
    window.close();
  });

  it("writes nothing when nothing declared is present", async () => {
    const window = pageWith("https://shop.example.test/", markup);
    const { writes } = installCookieJar(window, ["unrelated=1; Path=/"]);
    window.localStorage.setItem("unrelated", "1");

    await createBlockedScriptController({
      document: window.document as unknown as Document,
      resourceId: "tracker",
    }).cleanup();

    expect(writes).toEqual([]);
    expect(window.localStorage.getItem("unrelated")).toBe("1");
    window.close();
  });

  it("deletes matching local and session storage entries, by name or prefix", async () => {
    const window = pageWith("https://shop.example.test/", markup);
    installCookieJar(window, []);
    window.localStorage.setItem("_trk", "1");
    window.localStorage.setItem("_trk2", "1");
    window.localStorage.setItem("opencookie.consent", "1");
    window.sessionStorage.setItem("ph_a", "1");
    window.sessionStorage.setItem("ph_b", "1");
    window.sessionStorage.setItem("pha", "1");

    await createBlockedScriptController({
      document: window.document as unknown as Document,
      resourceId: "tracker",
    }).cleanup();

    expect(window.localStorage.getItem("_trk")).toBeNull();
    expect(window.localStorage.getItem("_trk2")).toBe("1");
    expect(window.localStorage.getItem("opencookie.consent")).toBe("1");
    expect(window.sessionStorage.getItem("ph_a")).toBeNull();
    expect(window.sessionStorage.getItem("ph_b")).toBeNull();
    expect(window.sessionStorage.getItem("pha")).toBe("1");
    window.close();
  });

  it("reports a declared cookie it could not delete as a failed cleanup", async () => {
    const window = pageWith("https://shop.example.test/", markup);
    Object.defineProperty(window.document, "cookie", {
      configurable: true,
      get: () => "_trk=1",
      set: () => undefined,
    });

    await expect(
      createBlockedScriptController({
        document: window.document as unknown as Document,
        resourceId: "tracker",
      }).cleanup(),
    ).rejects.toThrow(/_trk/u);
    window.close();
  });

  it("fails visibly on a malformed declaration rather than skipping it", async () => {
    const window = pageWith(
      "https://shop.example.test/",
      '<script type="text/plain" data-oc-resource="tracker" data-oc-stores="idb:_trk"></script>',
    );

    await expect(
      createBlockedScriptController({
        document: window.document as unknown as Document,
        resourceId: "tracker",
      }).cleanup(),
    ).rejects.toThrow(/data-oc-stores/u);
    window.close();
  });
});

describe("declared storage in the browser runtime", () => {
  const trackerPage = () => {
    const window = new Window({ url: "https://shop.example.test/" });
    vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
    window.document.body.innerHTML = [
      '<script type="text/plain" data-src="https://tracker.example.test/t.js"',
      ' data-oc-resource="tracker" data-oc-category="analytics"',
      ' data-oc-stores="local:_trk"></script>',
    ].join("");
    return window;
  };

  it("deletes a declared entry on a page load that does not grant its resource", async () => {
    const window = trackerPage();
    window.localStorage.setItem("_trk", "left over");
    const started = bootstrapOpenCookie({
      document: window.document as unknown as Document,
    });
    await started.ready;

    expect(window.localStorage.getItem("_trk")).toBeNull();
    started.destroy();
    window.close();
  });

  it("deletes it again when the granted resource is withdrawn", async () => {
    const window = trackerPage();
    const started = bootstrapOpenCookie({
      document: window.document as unknown as Document,
    });
    await started.ready;
    await started.client.acceptAll();
    window.localStorage.setItem("_trk", "written by the tracker");

    await started.client.withdrawConsent();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.localStorage.getItem("_trk")).toBeNull();
    started.destroy();
    window.close();
  });
});

// A hand-wired integration builds its own controllers, so the blocked script
// and frame controllers delete the storage their own elements declare.
describe("declared storage in the public controllers", () => {
  it("is deleted by the blocked script controller for its own scripts", async () => {
    const window = pageWith(
      "https://shop.example.test/",
      [
        '<script type="text/plain" data-oc-resource="tracker" data-oc-category="analytics" data-oc-stores="local:_trk"></script>',
        '<iframe data-oc-resource="tracker" data-oc-category="analytics" data-oc-stores="local:_frame"></iframe>',
      ].join(""),
    );
    window.localStorage.setItem("_trk", "1");
    window.localStorage.setItem("_frame", "1");

    await createBlockedScriptController({
      category: "analytics",
      document: window.document as unknown as Document,
      resourceId: "tracker",
    }).cleanup();

    expect(window.localStorage.getItem("_trk")).toBeNull();
    expect(window.localStorage.getItem("_frame")).toBe("1");
    window.close();
  });

  it("is deleted by the blocked frame controller for its own frames", async () => {
    const window = pageWith(
      "https://shop.example.test/",
      '<iframe data-oc-resource="video" data-oc-category="analytics" data-oc-stores="session:_vid"></iframe>',
    );
    window.sessionStorage.setItem("_vid", "1");

    await createBlockedIframeController({
      category: "analytics",
      document: window.document as unknown as Document,
      resourceId: "video",
    }).cleanup();

    expect(window.sessionStorage.getItem("_vid")).toBeNull();
    window.close();
  });
});
