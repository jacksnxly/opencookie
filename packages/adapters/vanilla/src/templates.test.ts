import { readFileSync } from "node:fs";

import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { mountOpenCookie } from "./index.js";
import { createTestClient } from "./index.test-helpers.js";

// The template kit: ready designs an installer starts from and then owns. A
// template only restyles; it never changes what the visitor can do, and a
// site's own rules still win over it.

const TEMPLATES = ["soft", "minimal"] as const;

const packageRoot = new URL("../", import.meta.url);

const template = (name: string): string =>
  readFileSync(new URL(`templates/${name}.css`, packageRoot), "utf8");

/** Every selector of every style rule, @media blocks included. */
function selectors(css: string): readonly string[] {
  const body = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const found: string[] = [];
  for (const match of body.matchAll(/([^{};]+)\{[^{}]*\}/gu)) {
    for (const selector of (match[1] ?? "").split(",")) {
      const trimmed = selector.trim();
      if (trimmed !== "") found.push(trimmed);
    }
  }
  return found;
}

describe("the template kit", () => {
  it("publishes each template as a CSS file the package exports", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("package.json", packageRoot), "utf8"),
    ) as { exports: Record<string, unknown>; files: string[] };
    expect(manifest.files).toContain("templates");
    expect(manifest.exports["./templates/*"]).toBe("./templates/*");
    for (const name of TEMPLATES) {
      expect(template(name).length).toBeGreaterThan(0);
    }
  });

  it.each(TEMPLATES)(
    "scopes every rule of %s to the banner, so it cannot restyle the site",
    (name) => {
      const found = selectors(template(name));
      expect(found.length).toBeGreaterThan(5);
      for (const selector of found) {
        expect(selector, selector).toMatch(/^(?::where\()?\.oc-root\b/u);
      }
    },
  );

  // A template must not remove a way out or make accepting easier than
  // rejecting; those are behaviour, not design.
  it.each(TEMPLATES)(
    "keeps every control of %s visible and the choices alike",
    (name) => {
      const css = template(name);
      expect(css).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden/u);
      expect(css).not.toMatch(/accept-all|reject-all/u);
      expect(css).not.toMatch(/outline\s*:\s*(?:none|0)\b/u);
    },
  );

  // The close control sits in the bar's top corner. A bar without room above
  // its choices drew it over the settings button.
  it.each(TEMPLATES)(
    "leaves room above the choices of %s for closing",
    (name) => {
      const bar = /\.oc-root \.oc-bar \{([^}]*)\}/u.exec(template(name))?.[1];
      const padding = /padding:\s*([\d.]+)rem/u.exec(bar ?? "")?.[1];
      expect(Number(padding)).toBeGreaterThanOrEqual(1.25);
      if (/inset:\s*auto 0 0/u.test(bar ?? "")) {
        expect(Number(padding)).toBeGreaterThanOrEqual(2);
      }
    },
  );
});

// The class names a site may style are part of OpenCookie's contract: a
// rename breaks this test before it breaks a site's stylesheet.
const STYLING_CLASSES = [
  "oc-root",
  "oc-bar",
  "oc-bar-copy",
  "oc-bar-title",
  "oc-bar-description",
  "oc-bar-actions",
  "oc-actions",
  "oc-btn",
  "oc-btn--choice",
  "oc-btn--dismiss",
  "oc-launcher",
  "oc-panel",
  "oc-meta",
  "oc-title",
  "oc-description",
  "oc-purposes",
  "oc-purpose",
  "oc-btn--save",
  "oc-btn--close",
] as const;

describe("the styling surface", () => {
  it("renders every documented class", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const mount = mountOpenCookie({ client: createTestClient(), document });
    await mount.ready;
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();

    const rendered = new Set(
      Array.from(document.querySelectorAll("[class]")).flatMap((element) =>
        Array.from(element.classList),
      ),
    );
    const missing = STYLING_CLASSES.filter(
      (name) => !rendered.has(name) && name !== "oc-launcher",
    );
    expect(missing).toEqual([]);
    mount.destroy();
    window.close();
  });

  it("names every documented class in the styling guide", () => {
    const guide = readFileSync(
      new URL(
        "../../../apps/docs/src/content/docs/recipes/a11y-i18n-theming.mdx",
        packageRoot,
      ),
      "utf8",
    );
    for (const name of STYLING_CLASSES) {
      expect(guide, name).toContain(`.${name}`);
    }
  });
});
