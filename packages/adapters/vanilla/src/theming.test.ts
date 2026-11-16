import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { mountOpenCookie } from "./index.js";
import { createTestClient } from "./index.test-helpers.js";

const readStylesheet = async (): Promise<string> => {
  const browserWindow = new Window();
  const document = browserWindow.document as unknown as Document;
  const mount = mountOpenCookie({ client: createTestClient(), document });
  await mount.ready;
  const stylesheet = Array.from(document.head.querySelectorAll("style"))
    .map((element) => element.textContent)
    .join("");
  mount.destroy();
  browserWindow.close();
  return stylesheet;
};

// Require a declaration rather than matching the token's many var() uses.
const DECLARING_BLOCK = /[^{}]*\{[^{}]*--oc-ink\s*:[^{}]*\}/gu;

describe("consumer token overrides", () => {
  it("declares colour tokens at zero specificity so a consumer rule wins", async () => {
    const blocks = (await readStylesheet()).match(DECLARING_BLOCK);
    expect(blocks).toHaveLength(2);
    for (const block of blocks ?? []) {
      expect(block.slice(0, block.indexOf("{"))).toContain(":where(");
    }
  });

  it("keeps structural properties on the zero-specificity root rule", async () => {
    const structural = /:where\(\.oc-root\)\{[^{}]*z-index[^{}]*\}/u.exec(
      await readStylesheet(),
    );
    expect(structural).not.toBeNull();
    expect(structural?.[0].startsWith(":where(.oc-root){")).toBe(true);
  });

  // A banner that turned dark with the visitor's OS on a light-only page did
  // not belong to the page. The dark palette follows the page's own
  // color-scheme through light-dark(), which a browser without it skips, so
  // that browser keeps the light palette.
  it("follows the page's colour scheme, not the OS", async () => {
    const stylesheet = await readStylesheet();
    expect(stylesheet).not.toContain("prefers-color-scheme");
    const light = /:where\(\.oc-root\)\{(--oc-[^}]*)\}/u.exec(stylesheet)?.[1];
    const both =
      /@supports \(color:light-dark\([^)]*\)\)\{:where\(\.oc-root\)\{([^}]*)\}/u.exec(
        stylesheet,
      )?.[1];
    expect(light).toBeDefined();
    expect(both).toBeDefined();
    for (const name of ["ink", "paper", "muted", "accent"]) {
      const fallback = new RegExp(`--oc-${name}:(#[0-9a-f]+)`, "iu").exec(
        light ?? "",
      )?.[1];
      const pair = new RegExp(
        `--oc-${name}:light-dark\\((#[0-9a-f]+),(#[0-9a-f]+)\\)`,
        "iu",
      ).exec(both ?? "");
      expect(pair?.[1], `--oc-${name} keeps its light value`).toBe(fallback);
      expect(pair?.[2], `--oc-${name} has a dark value`).toMatch(/^#/u);
    }
  });

  // The close control is plain text, but the base button rule came later at
  // the same specificity and drew it as a boxed button.
  it("lets the close control's own rule win over the base button", async () => {
    const stylesheet = await readStylesheet();
    expect(stylesheet.indexOf(".oc-btn--dismiss{")).toBeGreaterThan(
      stylesheet.indexOf(".oc-btn{"),
    );
  });

  // Opening the settings moves focus to the title for screen readers. A
  // mouse click must not draw a keyboard focus ring around it.
  it("outlines the settings title only for keyboard focus", async () => {
    const stylesheet = await readStylesheet();
    expect(stylesheet).toContain(".oc-title:focus-visible");
    expect(stylesheet).not.toMatch(/\.oc-title:focus[,{]/u);
  });

  it("never paints text on the accent with a hardcoded colour", async () => {
    const onAccent = /\.oc-alert,\.oc-btn--choice\{[^{}]*\}/u.exec(
      await readStylesheet(),
    );
    expect(onAccent?.[0]).not.toMatch(/color:#[0-9a-f]{3,8}/iu);
  });
});
