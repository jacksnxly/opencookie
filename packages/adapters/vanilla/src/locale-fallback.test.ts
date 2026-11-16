import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { mountOpenCookie } from "./index.js";
import { createTestClient } from "./index.test-helpers.js";

async function renderWith(copy: unknown): Promise<string> {
  const browserWindow = new Window();
  const document = browserWindow.document as unknown as Document;
  const mount = mountOpenCookie({
    client: createTestClient(),
    copy: copy as never,
    document,
  });
  await mount.ready;
  const rendered = document.body.textContent;
  mount.destroy();
  browserWindow.close();
  return rendered;
}

const DEFAULT_ACCEPT = "Accept all";

// @covers PP-22 REQ-I18N-THEME-CONTRACT / TEST-LOCALE-FALLBACK: an incomplete
// locale falls back to the shipped default instead of suppressing a control or
// painting a coerced placeholder into it.
describe("TEST-LOCALE-FALLBACK", () => {
  it("falls back when a key is absent", async () => {
    expect(await renderWith({ title: "Anpassen" })).toContain(DEFAULT_ACCEPT);
  });

  it("falls back when a key is null, as JSON locale data delivers it", async () => {
    const rendered = await renderWith(JSON.parse('{"acceptAll": null}'));

    expect(rendered).toContain(DEFAULT_ACCEPT);
    expect(rendered).not.toContain("null");
  });

  it("falls back when a key is explicitly undefined", async () => {
    const rendered = await renderWith({ acceptAll: undefined });

    expect(rendered).toContain(DEFAULT_ACCEPT);
    expect(rendered).not.toContain("undefined");
  });

  it("falls back when a key is blank rather than rendering an unlabelled control", async () => {
    expect(await renderWith({ acceptAll: "   " })).toContain(DEFAULT_ACCEPT);
  });

  it("still honours a real override", async () => {
    const rendered = await renderWith({ acceptAll: "Alles akzeptieren" });

    expect(rendered).toContain("Alles akzeptieren");
    expect(rendered).not.toContain(DEFAULT_ACCEPT);
  });
});
