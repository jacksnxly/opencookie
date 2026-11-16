import { describe, expect, it } from "vitest";

import {
  projectGoogleConsentModePurposeState,
  type GoogleConsentModePurposeMapping,
} from "./google-consent-mode.js";

// A tag manager's container serves several purposes, so the tags inside it
// read Consent Mode, and each signal follows the purposes it stands for, not
// whether the container loaded.

const MAPPING: GoogleConsentModePurposeMapping = {
  adPersonalizationPurposeIds: ["advertising"],
  adStoragePurposeIds: ["advertising"],
  adUserDataPurposeIds: ["advertising"],
  analyticsStoragePurposeIds: ["analytics"],
};

describe("Consent Mode signals mapped to purposes", () => {
  it("grants each signal while its purposes are permitted", () => {
    expect(
      projectGoogleConsentModePurposeState(["analytics"], MAPPING),
    ).toEqual({
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "granted",
    });
    expect(
      projectGoogleConsentModePurposeState(
        ["advertising", "analytics"],
        MAPPING,
      ),
    ).toEqual({
      adPersonalization: "granted",
      adStorage: "granted",
      adUserData: "granted",
      analyticsStorage: "granted",
    });
  });

  it("needs every purpose mapped to a signal", () => {
    expect(
      projectGoogleConsentModePurposeState(["analytics"], {
        analyticsStoragePurposeIds: ["analytics", "advertising"],
      }).analyticsStorage,
    ).toBe("denied");
  });

  it("stays denied for a signal mapped to nothing, or to no array", () => {
    const denied = {
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "denied",
    };
    expect(
      projectGoogleConsentModePurposeState(["analytics"], {
        analyticsStoragePurposeIds: [],
      }),
    ).toEqual(denied);
    expect(
      projectGoogleConsentModePurposeState(["analytics"], {
        analyticsStoragePurposeIds: "analytics",
      } as unknown as GoogleConsentModePurposeMapping),
    ).toEqual(denied);
  });
});
