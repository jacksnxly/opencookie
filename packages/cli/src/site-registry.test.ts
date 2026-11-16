import { describe, expect, it } from "vitest";

import {
  emptySiteRegistry,
  registerSite,
  siteDirectory,
  siteForDomain,
} from "./index.js";

describe("site registry", () => {
  it("registers a site with its domains", () => {
    const result = registerSite(emptySiteRegistry(), {
      domains: ["shop.example.test"],
      name: "shop",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.sites).toEqual([
      { domains: ["shop.example.test"], name: "shop" },
    ]);
  });

  it("gives each site its own directory", () => {
    expect(siteDirectory("shop")).toBe("sites/shop");
    expect(siteDirectory("blog")).not.toBe(siteDirectory("shop"));
  });

  // The directory name comes from operator input; a name that is not a plain
  // site name must never become a path that escapes the sites directory.
  it("refuses to derive a directory from an unsafe name", () => {
    expect(() => siteDirectory("../other")).toThrow(/site name/u);
    expect(() => siteDirectory("a/b")).toThrow(/site name/u);
  });

  it.each(["../other", "a/b", "", "Shop", ".hidden", "x".repeat(64)])(
    "refuses the unsafe site name %j",
    (name) => {
      const result = registerSite(emptySiteRegistry(), {
        domains: ["example.test"],
        name,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issue.kind).toBe("invalid-site-name");
    },
  );

  it("refuses a domain that is not a hostname", () => {
    const result = registerSite(emptySiteRegistry(), {
      domains: ["https://shop.example.test/path"],
      name: "shop",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("invalid-domain");
  });

  it("refuses a second site with the same name", () => {
    const first = registerSite(emptySiteRegistry(), {
      domains: ["shop.example.test"],
      name: "shop",
    });
    if (!first.ok) throw new Error("fixture must register");
    const again = registerSite(first.registry, {
      domains: ["other.example.test"],
      name: "shop",
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.issue.kind).toBe("duplicate-site");
  });

  // A domain served by two sites would make it ambiguous which policy and
  // which consent records apply to a visitor there.
  it("refuses a domain that already belongs to another site", () => {
    const first = registerSite(emptySiteRegistry(), {
      domains: ["shop.example.test"],
      name: "shop",
    });
    if (!first.ok) throw new Error("fixture must register");
    const clash = registerSite(first.registry, {
      domains: ["Shop.Example.Test"],
      name: "shop-eu",
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    const issue = clash.issue;
    expect(issue.kind).toBe("domain-claimed");
    if (issue.kind !== "domain-claimed") return;
    expect(issue.owner).toBe("shop");
  });

  it("requires at least one domain", () => {
    const result = registerSite(emptySiteRegistry(), {
      domains: [],
      name: "shop",
    });
    expect(result.ok).toBe(false);
  });

  // A trailing dot names the same host in absolute form, so it must not create
  // a second registration that looks unclaimed.
  it("treats a trailing dot as the same hostname", () => {
    const first = registerSite(emptySiteRegistry(), {
      domains: ["shop.example.test."],
      name: "shop",
    });
    if (!first.ok) throw new Error("fixture must register");
    expect(first.registry.sites[0]?.domains).toEqual(["shop.example.test"]);

    const clash = registerSite(first.registry, {
      domains: ["shop.example.test"],
      name: "shop-eu",
    });
    expect(clash.ok).toBe(false);
  });

  it.each([
    ["a bare dot", "."],
    ["an empty name", ""],
    // Labels of 60 characters are each valid, so only the whole-name limit can
    // refuse this: 5 x 60 + 4 dots is 304 characters.
    [
      "a hostname longer than 253 characters, with valid labels",
      Array.from({ length: 5 }, () => "a".repeat(60)).join("."),
    ],
    ["a label longer than 63 characters", `${"a".repeat(64)}.example.test`],
  ])("refuses %s", (_label, domain) => {
    const result = registerSite(emptySiteRegistry(), {
      domains: [domain],
      name: "shop",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue.kind).toBe("invalid-domain");
  });

  it("records a domain given twice in one registration only once", () => {
    const result = registerSite(emptySiteRegistry(), {
      domains: ["shop.example.test", "SHOP.example.test.", "shop.example.test"],
      name: "shop",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.sites[0]?.domains).toEqual(["shop.example.test"]);
  });

  it("finds no site for something that is not a hostname", () => {
    const registered = registerSite(emptySiteRegistry(), {
      domains: ["shop.example.test"],
      name: "shop",
    });
    if (!registered.ok) throw new Error("fixture must register");

    expect(
      siteForDomain(registered.registry, "https://shop.example.test/"),
    ).toBeUndefined();
    expect(siteForDomain(registered.registry, "SHOP.EXAMPLE.TEST")?.name).toBe(
      "shop",
    );
  });

  // 253 characters is the longest name the registry accepts, so the boundary
  // itself is pinned: one character more is refused.
  it("accepts a hostname of exactly 253 characters and refuses 254", () => {
    const labels = [
      ...Array.from({ length: 4 }, () => "a".repeat(50)),
      "b".repeat(49),
    ];
    const longest = labels.join(".");
    expect(longest).toHaveLength(253);

    const accepted = registerSite(emptySiteRegistry(), {
      domains: [longest],
      name: "shop",
    });
    const refused = registerSite(emptySiteRegistry(), {
      domains: [`c${longest}`],
      name: "shop",
    });

    expect(accepted.ok).toBe(true);
    expect(refused.ok).toBe(false);
  });

  // A single-character label is a valid hostname label, and sites really are
  // served from names like x.example.test.
  it("accepts a single-character label", () => {
    const result = registerSite(emptySiteRegistry(), {
      domains: ["x.example.test"],
      name: "shop",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.sites[0]?.domains).toEqual(["x.example.test"]);
  });
});
