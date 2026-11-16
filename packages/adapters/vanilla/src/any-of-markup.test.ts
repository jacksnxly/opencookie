import type { PolicyDefinition } from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// A tag manager's container serves several purposes. Its markup lists them
// and says it loads when any one is permitted; the tags inside it read
// Consent Mode.

const POLICY: PolicyDefinition = {
  categories: [{ id: "optional", purposeIds: ["advertising", "analytics"] }],
  dataCategories: [{ id: "usage-event" }],
  operations: [{ id: "measure" }],
  presentationRootCategoryIds: ["optional"],
  providers: [{ id: "site-operator" }],
  purposes: ["advertising", "analytics"].map((id) => ({
    dataCategoryIds: ["usage-event"],
    disclosure: `Uses ${id}.`,
    id,
    operationIds: ["measure"],
    providerIds: ["site-operator"],
    recipientIds: ["site-operator"],
    retentionIds: ["thirteen-months"],
  })) as unknown as PolicyDefinition["purposes"],
  recipients: [{ id: "site-operator" }],
  retentions: [{ id: "thirteen-months" }],
};

const container = (attributes: string) =>
  `<script type="text/plain" data-src="https://tags.example.test/container.js" data-oc-resource="container" ${attributes}></script>`;

function page(markup: string) {
  const window = new Window({ url: "https://shop.example.test/" });
  window.document.body.innerHTML = markup;
  const document = window.document as unknown as Document;
  vi.spyOn(window.location, "reload").mockImplementation(() => undefined);
  const onError = vi.fn();
  const started = bootstrapOpenCookie({
    document,
    onError,
    policyDefinition: POLICY,
  });
  const active = () =>
    document.querySelector('[data-oc-active-resource="container"]') !== null;
  return { active, onError, started, window };
}

describe("a container that serves several purposes", () => {
  it("loads when any one of its purposes is permitted", async () => {
    for (const permitted of [["analytics"], ["advertising"]]) {
      const { active, onError, started, window } = page(
        container(
          'data-oc-category="analytics advertising" data-oc-match="any"',
        ),
      );
      await started.ready;
      expect(active()).toBe(false);

      await started.client.savePreferences(permitted);
      expect(active()).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      started.destroy();
      window.close();
    }
  });

  it("stays blocked while none of its purposes is permitted", async () => {
    const { active, started, window } = page(
      container('data-oc-category="analytics advertising" data-oc-match="any"'),
    );
    await started.ready;
    await started.client.rejectAll();

    expect(active()).toBe(false);
    started.destroy();
    window.close();
  });

  it("is refused when it lists several purposes without matching any", async () => {
    for (const attributes of [
      'data-oc-category="analytics advertising"',
      'data-oc-category="analytics advertising" data-oc-match="all"',
    ]) {
      const { active, onError, started, window } = page(container(attributes));
      await started.ready;
      await started.client.acceptAll();

      expect(active()).toBe(false);
      expect(
        onError.mock.calls.some(
          ([error]) =>
            error instanceof Error &&
            /container.*data-oc-match="any"/u.test(error.message),
        ),
      ).toBe(true);
      started.destroy();
      window.close();
    }
  });

  it("is refused when its elements declare it differently", async () => {
    const { active, onError, started, window } = page(
      container(
        'data-oc-category="analytics advertising" data-oc-match="any"',
      ) +
        container(
          'data-oc-category="advertising analytics" data-oc-match="any"',
        ),
    );
    await started.ready;
    await started.client.acceptAll();

    expect(active()).toBe(false);
    expect(onError).toHaveBeenCalled();
    started.destroy();
    window.close();
  });
});
