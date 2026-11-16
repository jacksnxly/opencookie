import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// A site discloses what runs whatever the visitor chooses, such as a session
// cookie or a payment provider's fraud check, and why. Such a resource is not
// blocked markup, so the bootstrap takes it as an option.

const TRACKER = [
  '<script type="text/plain" data-src="https://tracker.example.test/t.js"',
  ' data-oc-resource="tracker" data-oc-category="analytics"></script>',
].join("");

const SESSION = {
  exceptionReason: "Keeps the visitor signed in.",
  id: "session",
};

function page() {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = TRACKER;
  const document = window.document as unknown as Document;
  return { document, window };
}

describe("a declared exception on the bootstrap route", () => {
  it("is allowed before any choice and listed as not controlled by the choices", async () => {
    const { document, window } = page();
    const onError = vi.fn();

    const started = bootstrapOpenCookie({
      declaredExceptions: [SESSION],
      document,
      onError,
    });
    await started.ready;

    const access = started.client.getSnapshot().runtime.effectiveAccess;
    expect(
      access.resources.map(({ access, resourceId }) => [resourceId, access]),
    ).toEqual([
      ["session", "allowed"],
      ["tracker", "blocked"],
    ]);
    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    const exceptions = document.querySelector("[data-oc-exceptions]");
    expect(exceptions?.textContent).toContain("session");
    expect(exceptions?.textContent).toContain(SESSION.exceptionReason);

    await started.client.acceptAll();
    expect(
      document.querySelector('[data-oc-active-resource="tracker"]'),
    ).not.toBeNull();
    await started.client.rejectAll();
    expect(
      document.querySelector('[data-oc-active-resource="tracker"]'),
    ).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    started.destroy();
    window.close();
  });

  it("is listed by its label when it has one", async () => {
    const { document, window } = page();
    const started = bootstrapOpenCookie({
      declaredExceptions: [{ ...SESSION, label: "Session cookie" }],
      document,
    });
    await started.ready;

    document
      .querySelector<HTMLButtonElement>('[data-oc-action="settings"]')
      ?.click();
    expect(
      document.querySelector("[data-oc-exceptions] li strong")?.textContent,
    ).toBe("Session cookie");
    started.destroy();
    window.close();
  });

  it("refuses an exception that shares an identifier with declared markup", () => {
    const { document, window } = page();

    expect(() =>
      bootstrapOpenCookie({
        declaredExceptions: [{ ...SESSION, id: "tracker" }],
        document,
      }),
    ).toThrow("The OpenCookie bootstrap resource policy is invalid.");
    expect(document.querySelector("[data-oc-root]")).toBeNull();
    window.close();
  });

  it("refuses an exception without a reason", () => {
    const { document, window } = page();

    expect(() =>
      bootstrapOpenCookie({
        declaredExceptions: [{ ...SESSION, exceptionReason: " " }],
        document,
      }),
    ).toThrow("The OpenCookie bootstrap resource policy is invalid.");
    expect(document.querySelector("[data-oc-root]")).toBeNull();
    window.close();
  });
});
