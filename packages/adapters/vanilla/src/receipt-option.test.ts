import type { ConsentReceipt } from "@opencookie-dev/core";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { bootstrapOpenCookie } from "./index.js";

// The runtime projects a consent receipt for every decision. The bootstrap
// hands each one to the site, which is where consent evidence starts.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the receipt option", () => {
  it("hands the site a receipt for each decision", async () => {
    const window = new Window({ url: "https://shop.example.test/" });
    const document = window.document as unknown as Document;
    const receipts: ConsentReceipt[] = [];
    const started = bootstrapOpenCookie({
      document,
      receipt: (receipt) => {
        receipts.push(receipt);
        return Promise.resolve();
      },
    });
    await started.ready;

    await started.client.rejectAll();
    await settle();
    await started.client.acceptAll();
    await settle();

    expect(receipts.map((receipt) => receipt.method)).toEqual([
      "reject-all",
      "accept-all",
    ]);
    expect(
      receipts.map(
        (receipt) =>
          receipt.decisions.find(({ purposeId }) => purposeId === "analytics")
            ?.decision,
      ),
    ).toEqual(["denied", "granted"]);
    started.destroy();
    window.close();
  });
});
