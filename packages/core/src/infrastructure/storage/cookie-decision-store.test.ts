import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createCookieDecisionStore,
  type CookieDecisionStoreOptions,
  type CookieJarLike,
  type RegistrableDomainResolver,
} from "../../infrastructure.js";
import {
  persistDenial,
  persistGrant,
  type PersistedConsentState,
  type PersistedDecisionRecord,
} from "../../application.js";
import { createPolicySnapshot, definePolicy } from "../../domain.js";

const record: PersistedDecisionRecord = {
  catalogueDigest: "catalogue-1",
  decidedAt: 1_000,
  decisionSurfaceDigest: "surface-1",
  decisions: { analytics: "granted" },
  expiresAt: 2_000,
  method: "accept-all",
  policyVersion: "policy-1",
  recordId: "record-1",
  revision: 1,
};

function state(record: PersistedDecisionRecord): PersistedConsentState {
  return { record };
}

function memoryCookieJar(initial = ""): CookieJarLike & {
  readonly writes: string[];
} {
  let cookieHeader = initial;
  const writes: string[] = [];

  return {
    read: () => cookieHeader,
    write(serializedCookie) {
      writes.push(serializedCookie);
      const [pair] = serializedCookie.split(";");
      if (pair === undefined) return;
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const maxAgeZero = /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(serializedCookie);
      const retained = cookieHeader
        .split(";")
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate && !candidate.startsWith(`${name}=`));
      if (!maxAgeZero) retained.push(pair);
      cookieHeader = retained.join("; ");
    },
    writes,
  };
}

function registrableDomainResolver(
  boundaries: Readonly<Record<string, string | null>>,
): RegistrableDomainResolver {
  return {
    resolve: (hostname) => boundaries[hostname] ?? null,
  };
}

function sharedOptions(
  hostname: string,
  domain: string,
  resolver: RegistrableDomainResolver,
  jar: CookieJarLike = memoryCookieJar(),
): CookieDecisionStoreOptions {
  return {
    hostname,
    jar,
    key: "oc-consent",
    schemaVersion: 1,
    scope: {
      domain,
      kind: "shared",
      registrableDomainResolver: resolver,
    },
  };
}

describe("cookie decision store", () => {
  it("keeps an ordinary five-purpose consent cookie within 4096 bytes", async () => {
    const policy = definePolicy({
      categories: [],
      dataCategories: [{ id: "d" }],
      operations: [{ id: "o" }],
      presentationRootCategoryIds: [],
      providers: [{ id: "v" }],
      purposes: Array.from({ length: 5 }, (_, index) => ({
        dataCategoryIds: ["d"] as const,
        disclosure: "short choice",
        id: `p${String(index)}`,
        operationIds: ["o"] as const,
        providerIds: ["v"] as const,
        recipientIds: ["r"] as const,
        retentionIds: ["t"] as const,
      })),
      recipients: [{ id: "r" }],
      retentions: [{ id: "t" }],
    });
    if (!policy.ok) throw new Error("Capacity policy must be valid.");
    const snapshot = createPolicySnapshot({
      catalogueRevision: "catalogue-1",
      policy: policy.policy,
      policyVersion: "policy-1",
    });
    const capacityRecord: PersistedDecisionRecord = {
      catalogueDigest: snapshot.catalogueDigest,
      decidedAt: 1_000,
      decisionSurfaceDigest: snapshot.decisionSurfaceDigest,
      decisions: Object.fromEntries(
        snapshot.policy.purposes.map(({ id }) => [id, "granted"]),
      ),
      expiresAt: 10_000,
      method: "granular",
      policyVersion: snapshot.policyVersion,
      recordId: "record-capacity",
      revision: 1,
    };
    const jar = memoryCookieJar();
    const store = createCookieDecisionStore({
      hostname: "localhost",
      jar,
      key: "opencookie-consent",
      maxAgeSeconds: 9,
      schemaVersion: 1,
      secure: true,
    });

    await expect(
      store.compareAndSet(null, state(capacityRecord)),
    ).resolves.toEqual({ status: "written" });
    expect(jar.writes).toHaveLength(1);
    expect(
      new TextEncoder().encode(jar.writes[0]).byteLength,
    ).toBeLessThanOrEqual(4_096);
    await expect(store.read()).resolves.toEqual({
      state: state(capacityRecord),
      status: "stored",
    });
  });

  it("exposes only the site-wide root cookie path", () => {
    expectTypeOf<CookieDecisionStoreOptions["path"]>().toEqualTypeOf<
      "/" | undefined
    >();
  });

  it.each(["", "/account", "/account/", null, 1, {}])(
    "rejects non-root runtime path %j before writing",
    (path) => {
      const jar = memoryCookieJar();
      const options = {
        hostname: "localhost",
        jar,
        key: "oc-consent",
        path,
        schemaVersion: 1,
      } as unknown as CookieDecisionStoreOptions;

      expect(() => createCookieDecisionStore(options)).toThrow(
        /path must be exactly \/ for site-wide consent/i,
      );
      expect(jar.writes).toEqual([]);
    },
  );

  it.each(["app.example.com", "127.0.0.1", "[2001:db8::1]", "localhost"])(
    "uses host-only scope without a resolver for %s",
    async (hostname) => {
      const jar = memoryCookieJar();
      const store = createCookieDecisionStore({
        hostname,
        jar,
        key: "oc-consent",
        schemaVersion: 1,
        secure: true,
      });

      await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
        status: "written",
      });
      expect(jar.writes[0]).not.toMatch(/Domain=/i);
      expect(jar.writes[0]).toContain("Path=/");
      expect(jar.writes[0]).toContain("SameSite=Lax");
      expect(jar.writes[0]).toContain("Secure");
    },
  );

  it("requires a registrable-domain resolver for explicit shared scope", () => {
    const options = {
      hostname: "app.example.com",
      jar: memoryCookieJar(),
      key: "oc-consent",
      schemaVersion: 1,
      scope: { domain: "example.com", kind: "shared" },
    } as unknown as CookieDecisionStoreOptions;

    expect(() => createCookieDecisionStore(options)).toThrow(/resolver/i);
  });

  it("conditionally clears only the exact durable record token", async () => {
    const store = createCookieDecisionStore({
      hostname: "app.example.com",
      jar: memoryCookieJar(),
      key: "oc-consent",
      schemaVersion: 1,
    });
    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "written",
    });

    await expect(
      store.clearIfCurrent(
        state({ ...record, decisions: { analytics: "denied" } }),
      ),
    ).resolves.toBe("conflict");
    await expect(store.read()).resolves.toEqual({
      state: state(record),
      status: "stored",
    });
    await expect(store.clearIfCurrent(state(record))).resolves.toBe("cleared");
    await expect(store.read()).resolves.toEqual({ status: "missing" });
  });

  it("canonicalizes an IDN shared scope to ASCII A-labels", async () => {
    const jar = memoryCookieJar();
    const resolver = registrableDomainResolver({
      "shop.xn--bcher-kva.example": "xn--bcher-kva.example",
    });
    const store = createCookieDecisionStore(
      sharedOptions(
        "SHOP.B\u00dcCHER.EXAMPLE",
        ".B\u00dcCHER\u3002EXAMPLE",
        resolver,
        jar,
      ),
    );

    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "written",
    });
    expect(jar.writes[0]).toContain("Domain=xn--bcher-kva.example");

    await store.clear();
    expect(jar.writes.at(-1)).toContain("Domain=xn--bcher-kva.example");
  });

  it.each([
    ["app.example.co.uk", "co.uk", "example.co.uk"],
    ["tenant.github.io", "github.io", "tenant.github.io"],
    ["foo.bar.ck", "bar.ck", "foo.bar.ck"],
  ])(
    "rejects %s sharing above its registrable boundary",
    (hostname, domain, registrableDomain) => {
      const resolver = registrableDomainResolver({
        [hostname]: registrableDomain,
      });

      expect(() =>
        createCookieDecisionStore(sharedOptions(hostname, domain, resolver)),
      ).toThrow(/registrable domain boundary/i);
    },
  );

  it("supports a PSL exception boundary without embedding the PSL", async () => {
    const jar = memoryCookieJar();
    const resolver = registrableDomainResolver({
      "foo.www.ck": "www.ck",
    });
    const store = createCookieDecisionStore(
      sharedOptions("foo.www.ck", "www.ck", resolver, jar),
    );

    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "written",
    });
    expect(jar.writes[0]).toContain("Domain=www.ck");
  });

  it.each([
    ["app.example.com", "attacker-example.com"],
    ["app.example.com.evil", "example.com"],
    ["app.example.com", "child.app.example.com"],
  ])("rejects unrelated scope %s -> %s", (hostname, domain) => {
    const resolver = registrableDomainResolver({
      [hostname]: "example.com",
    });

    expect(() =>
      createCookieDecisionStore(sharedOptions(hostname, domain, resolver)),
    ).toThrow(/parent domain/i);
  });

  it.each([
    ["127.1", "127.0.0.1"],
    ["[2001:db8::1]", "[2001:db8::1]"],
    ["app.localhost", "localhost"],
    ["deep.app.localhost", "app.localhost"],
  ])("rejects shared scope for IP or localhost host %s", (hostname, domain) => {
    const resolver = registrableDomainResolver({
      [hostname]: domain,
    });

    expect(() =>
      createCookieDecisionStore(sharedOptions(hostname, domain, resolver)),
    ).toThrow(/IP address|localhost/i);
  });

  it.each([
    ["example.com; Secure", "example.com; Secure"],
    ["app.example.com", "example.com."],
    ["app.example.com", "..example.com"],
    ["app.example..com", "example..com"],
    ["%65xample.com", "%65xample.com"],
    ["example.com\r\n", "example.com\r\n"],
    ["a_b.example.com", "a_b.example.com"],
    ["-bad.example.com", "-bad.example.com"],
    ["bad-.example.com", "bad-.example.com"],
  ])("rejects malformed cookie scope %j -> %j", (hostname, domain) => {
    const resolver = registrableDomainResolver({
      [hostname]: domain,
    });

    expect(() =>
      createCookieDecisionStore(sharedOptions(hostname, domain, resolver)),
    ).toThrow(TypeError);
  });

  it.each([
    ["unresolved", { resolve: () => null }],
    [
      "throwing",
      {
        resolve: () => {
          throw new Error("private resolver detail");
        },
      },
    ],
    ["unrelated", { resolve: () => "evil.com" }],
    ["child", { resolve: () => "child.app.example.com" }],
    ["IP", { resolve: () => "127.0.0.1" }],
  ] satisfies ReadonlyArray<readonly [string, RegistrableDomainResolver]>)(
    "fails closed for a %s resolver result",
    (_label, resolver) => {
      expect(() =>
        createCookieDecisionStore(
          sharedOptions("app.example.com", "example.com", resolver),
        ),
      ).toThrow(TypeError);
    },
  );

  it("reports a shared-scope readback mismatch without a blind rollback", async () => {
    const writes: string[] = [];
    const rejectingJar: CookieJarLike = {
      read: () => "",
      write: (serializedCookie) => writes.push(serializedCookie),
    };
    const resolver = registrableDomainResolver({
      "app.example.com": "example.com",
    });
    const store = createCookieDecisionStore(
      sharedOptions("app.example.com", "example.com", resolver, rejectingJar),
    );

    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "readback-mismatch",
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("Domain=example.com");
  });

  it("reports a cookie read failure as ambiguous instead of a proven conflict", async () => {
    const store = createCookieDecisionStore({
      hostname: "localhost",
      jar: {
        read: () => {
          throw new Error("cookie read failed");
        },
        write: () => undefined,
      },
      key: "oc-consent",
      schemaVersion: 1,
    });

    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "readback-mismatch",
    });
    await expect(store.clearIfCurrent(state(record))).resolves.toBe(
      "readback-mismatch",
    );
  });

  it("cleans up a grant whose immediate readback fails so reload cannot restore it", async () => {
    let cookieHeader = "";
    let obscureNextRead = false;
    const jar: CookieJarLike = {
      read: () => {
        if (obscureNextRead) {
          obscureNextRead = false;
          return "";
        }
        return cookieHeader;
      },
      write: (serializedCookie) => {
        const [pair] = serializedCookie.split(";");
        if (pair === undefined) return;
        if (/Max-Age=0/i.test(serializedCookie)) {
          cookieHeader = "";
          return;
        }
        cookieHeader = pair;
        obscureNextRead = true;
      },
    };
    const options: CookieDecisionStoreOptions = {
      hostname: "localhost",
      jar,
      key: "oc-consent",
      schemaVersion: 1,
    };

    await expect(
      persistGrant(createCookieDecisionStore(options), null, record),
    ).resolves.toMatchObject({ outcome: "grant-persistence-unconfirmed" });
    await expect(createCookieDecisionStore(options).read()).resolves.toEqual({
      status: "missing",
    });
  });

  it.each(["grant", "denial"] as const)(
    "preserves a concurrent cookie replacement installed between the rollback guard and write during %s persistence",
    async (kind) => {
      const candidate: PersistedDecisionRecord = {
        ...record,
        decidedAt: 1_500,
        decisions: {
          analytics: kind === "grant" ? "granted" : "denied",
        },
        expiresAt: 2_500,
        method: kind === "grant" ? "granular" : "reject-all",
        revision: 2,
      };
      const concurrent: PersistedDecisionRecord = {
        ...candidate,
        decidedAt: 1_750,
        expiresAt: 2_750,
        recordId: "record-concurrent",
        revision: 7,
      };
      const concurrentHeader = `oc-consent=${encodeURIComponent(
        JSON.stringify({ record: concurrent, schemaVersion: 1 }),
      )}`;
      let cookieHeader = "";
      let installConcurrentBeforeRollback = false;
      let obscureCandidateReadback = false;
      let concurrentInstalled = false;
      const jar: CookieJarLike = {
        read: () => {
          if (obscureCandidateReadback) {
            obscureCandidateReadback = false;
            installConcurrentBeforeRollback = true;
            return "";
          }
          const observed = cookieHeader;
          if (installConcurrentBeforeRollback) {
            installConcurrentBeforeRollback = false;
            concurrentInstalled = true;
            cookieHeader = concurrentHeader;
          }
          return observed;
        },
        write: (serializedCookie) => {
          const [pair] = serializedCookie.split(";");
          if (pair === undefined) return;
          if (installConcurrentBeforeRollback) {
            installConcurrentBeforeRollback = false;
            concurrentInstalled = true;
            cookieHeader = concurrentHeader;
          }
          if (/Max-Age=0/i.test(serializedCookie)) {
            cookieHeader = "";
            return;
          }
          cookieHeader = pair;
          const separator = pair.indexOf("=");
          const envelope = JSON.parse(
            decodeURIComponent(pair.slice(separator + 1)),
          ) as { readonly record: PersistedDecisionRecord };
          if (envelope.record.revision === candidate.revision) {
            obscureCandidateReadback = true;
          }
        },
      };
      const store = createCookieDecisionStore({
        hostname: "localhost",
        jar,
        key: "oc-consent",
        schemaVersion: 1,
      });
      await expect(persistGrant(store, null, record)).resolves.toMatchObject({
        outcome: "confirmed",
      });

      const result =
        kind === "grant"
          ? await persistGrant(store, record, candidate)
          : await persistDenial(store, record, candidate);

      expect(result.outcome).toBe(
        kind === "grant" ? "grant-persistence-unconfirmed" : "degraded",
      );
      expect(concurrentInstalled).toBe(true);
      await expect(store.read()).resolves.toEqual({
        state: state(concurrent),
        status: "stored",
      });
    },
  );

  // @covers PP-11 REQ-DEFENSIVE-STORAGE: conflicting stored decisions fail closed.
  it("fails closed when same-name cookies create an ambiguous scope", async () => {
    const jar = memoryCookieJar(
      "oc-consent=first; other=value; oc-consent=second",
    );
    const store = createCookieDecisionStore({
      hostname: "app.example.com",
      jar,
      key: "oc-consent",
      schemaVersion: 1,
    });

    await expect(store.read()).resolves.toEqual({
      candidateCount: 2,
      status: "ambiguous-duplicate",
    });
    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "readback-mismatch",
    });
    await expect(store.clearIfCurrent(state(record))).resolves.toBe(
      "readback-mismatch",
    );
  });

  it("round-trips and clears a site-wide record without leaking raw invalid values", async () => {
    const jar = memoryCookieJar();
    const store = createCookieDecisionStore({
      hostname: "localhost",
      jar,
      key: "oc-consent",
      maxAgeSeconds: 86_400,
      path: "/",
      schemaVersion: 1,
    });

    await expect(store.compareAndSet(null, state(record))).resolves.toEqual({
      status: "written",
    });
    await expect(store.read()).resolves.toEqual({
      state: state(record),
      status: "stored",
    });
    expect(jar.writes[0]).toContain("Max-Age=86400");
    expect(jar.writes[0]).toContain("Path=/");

    await store.clear();
    expect(jar.writes.at(-1)).toContain("Max-Age=0");
    await expect(store.read()).resolves.toEqual({ status: "missing" });

    const invalid = createCookieDecisionStore({
      hostname: "localhost",
      jar: memoryCookieJar("oc-consent=%7Bprivate-invalid-value"),
      key: "oc-consent",
      schemaVersion: 1,
    });
    await expect(invalid.read()).resolves.toEqual({
      reason: "malformed-json",
      status: "invalid",
    });
    await expect(invalid.compareAndSet(null, state(record))).resolves.toEqual({
      status: "readback-mismatch",
    });
    await expect(invalid.clearIfCurrent(state(record))).resolves.toBe(
      "readback-mismatch",
    );
  });

  it("does not restore an older cookie grant after a mixed narrowing readback mismatch", async () => {
    let cookieHeader = "";
    let obscureSecondWriteReadback = false;
    let writes = 0;
    const jar: CookieJarLike = {
      read: () => {
        if (obscureSecondWriteReadback) {
          obscureSecondWriteReadback = false;
          return "";
        }
        return cookieHeader;
      },
      write: (serializedCookie) => {
        const [pair] = serializedCookie.split(";");
        if (pair === undefined) return;
        if (/Max-Age=0/i.test(serializedCookie)) {
          cookieHeader = "";
          return;
        }
        cookieHeader = pair;
        writes += 1;
        if (writes === 2) obscureSecondWriteReadback = true;
      },
    };
    const options: CookieDecisionStoreOptions = {
      hostname: "localhost",
      jar,
      key: "oc-consent",
      schemaVersion: 1,
    };
    const store = createCookieDecisionStore(options);
    const previous: PersistedDecisionRecord = {
      ...record,
      decisions: { analytics: "granted", personalization: "granted" },
    };
    const narrowing: PersistedDecisionRecord = {
      ...previous,
      decidedAt: 1_500,
      decisions: { analytics: "granted", personalization: "denied" },
      expiresAt: 2_500,
      method: "granular",
      revision: 2,
    };

    await expect(persistGrant(store, null, previous)).resolves.toMatchObject({
      outcome: "confirmed",
    });
    await expect(persistGrant(store, previous, narrowing)).resolves.toEqual({
      diagnostics: [{ code: "grant-readback-mismatch" }],
      outcome: "grant-persistence-unconfirmed",
    });

    await expect(createCookieDecisionStore(options).read()).resolves.toEqual({
      status: "missing",
    });
  });

  it("clears the exact previous cookie grant when it reappears during denial cleanup", async () => {
    const previous: PersistedDecisionRecord = {
      ...record,
      decisions: { analytics: "granted", personalization: "granted" },
    };
    const rejection: PersistedDecisionRecord = {
      ...previous,
      decidedAt: 1_500,
      decisions: { analytics: "denied", personalization: "denied" },
      expiresAt: 2_500,
      method: "reject-all",
      revision: 2,
    };
    const previousHeader = `oc-consent=${encodeURIComponent(
      JSON.stringify({ record: previous, schemaVersion: 1 }),
    )}`;
    let cookieHeader = "";
    let writes = 0;
    let obscureDenialReadback = false;
    let restorePreviousDuringClear = false;
    const jar: CookieJarLike = {
      read: () => {
        if (obscureDenialReadback) {
          obscureDenialReadback = false;
          restorePreviousDuringClear = true;
          return "";
        }
        return cookieHeader;
      },
      write: (serializedCookie) => {
        const [pair] = serializedCookie.split(";");
        if (/Max-Age=0/i.test(serializedCookie)) {
          cookieHeader = restorePreviousDuringClear ? previousHeader : "";
          restorePreviousDuringClear = false;
          return;
        }
        cookieHeader = pair ?? "";
        writes += 1;
        if (writes === 2) obscureDenialReadback = true;
      },
    };
    const store = createCookieDecisionStore({
      hostname: "localhost",
      jar,
      key: "oc-consent",
      schemaVersion: 1,
    });

    await expect(persistGrant(store, null, previous)).resolves.toMatchObject({
      outcome: "confirmed",
    });
    await expect(persistDenial(store, previous, rejection)).resolves.toEqual({
      diagnostics: [{ code: "denial-readback-mismatch" }],
      effectiveRecord: rejection,
      outcome: "degraded",
    });
    await expect(store.read()).resolves.toEqual({ status: "missing" });
  });

  it.each(["grant", "denial"] as const)(
    "clears an older wider cookie grant after a transient initial read during %s persistence",
    async (kind) => {
      let cookieHeader = "";
      let failNextRead = false;
      const jar: CookieJarLike = {
        read: () => {
          if (failNextRead) {
            failNextRead = false;
            throw new Error("transient cookie read failure");
          }
          return cookieHeader;
        },
        write: (serializedCookie) => {
          const [pair] = serializedCookie.split(";");
          cookieHeader = /Max-Age=0/i.test(serializedCookie)
            ? ""
            : (pair ?? "");
        },
      };
      const store = createCookieDecisionStore({
        hostname: "localhost",
        jar,
        key: "oc-consent",
        schemaVersion: 1,
      });
      const previous: PersistedDecisionRecord = {
        ...record,
        decisions: { analytics: "granted", personalization: "granted" },
      };
      const next: PersistedDecisionRecord = {
        ...previous,
        decidedAt: 1_500,
        decisions:
          kind === "grant"
            ? { analytics: "granted", personalization: "denied" }
            : { analytics: "denied", personalization: "denied" },
        expiresAt: 2_500,
        method: kind === "grant" ? "granular" : "reject-all",
        revision: 2,
      };

      await expect(persistGrant(store, null, previous)).resolves.toMatchObject({
        outcome: "confirmed",
      });
      failNextRead = true;

      const result =
        kind === "grant"
          ? await persistGrant(store, previous, next)
          : await persistDenial(store, previous, next);
      expect(result).toMatchObject({
        diagnostics: [
          {
            code:
              kind === "grant"
                ? "grant-readback-mismatch"
                : "denial-readback-mismatch",
          },
        ],
        outcome:
          kind === "grant" ? "grant-persistence-unconfirmed" : "degraded",
      });
      await expect(store.read()).resolves.toEqual({ status: "missing" });
    },
  );
});
