import { describe, expect, it } from "vitest";

import {
  createAutoOpenCookieFactory,
  establishAutoGoogleConsentDefaults,
} from "../auto.js";
import { createSequentialIdGenerator } from "./auto-product-test-fixtures.test-helper.js";

// The drop-in has to send the Consent Mode default in the script's own task,
// before any later page script can measure, but building the factory and the
// client in that task is what makes it long on a cold browser. These cases
// pin the part that lets a caller send the default first and build later.
describe("establishing the Google Consent Mode defaults ahead of the factory", () => {
  it("sends the denied defaults at once, and create does not repeat them", async () => {
    const calls: unknown[][] = [];
    const google = establishAutoGoogleConsentDefaults({
      command: (...call: unknown[]) => {
        calls.push(call);
      },
      mode: "basic",
    });

    expect(calls).toEqual([
      [
        "consent",
        "default",
        {
          ad_personalization: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          analytics_storage: "denied",
        },
      ],
    ]);

    const client = createAutoOpenCookieFactory({
      consentDurationMs: 60_000,
    }).create({
      google,
      idGenerator: createSequentialIdGenerator(),
      now: () => 1_000,
      persistence: { kind: "unavailable" },
    });
    await client.initialize();
    expect(calls).toHaveLength(1);

    // Only the one repeated default is dropped; updates still reach Google.
    const granted = {
      ad_personalization: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      analytics_storage: "granted",
    } as const;
    google.command("consent", "update", granted);
    expect(calls.slice(1)).toEqual([["consent", "update", granted]]);
  });

  it("refuses an input the runtime options would refuse", () => {
    expect(() =>
      establishAutoGoogleConsentDefaults({
        command: () => undefined,
        mode: "strict",
      } as never),
    ).toThrow(new TypeError("Invalid auto consent runtime options."));
  });

  it("fails loudly when the command cannot send the defaults", () => {
    expect(() =>
      establishAutoGoogleConsentDefaults({
        command: () => {
          throw new Error("gtag is broken");
        },
        mode: "basic",
      }),
    ).toThrow(/Consent Mode defaults failed/u);
  });
});
