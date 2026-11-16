import { describe, expect, it } from "vitest";

import {
  createGoogleConsentModeBroadcaster,
  type GoogleConsentModeCall,
  type GoogleConsentModeCommand,
  projectGoogleConsentModeState,
} from "../../infrastructure.js";

function commandLog(): {
  readonly calls: GoogleConsentModeCall[];
  readonly command: GoogleConsentModeCommand;
} {
  const calls: GoogleConsentModeCall[] = [];
  return {
    calls,
    command: (...call) => {
      calls.push(call);
    },
  };
}

describe("Google Consent Mode v2 broadcaster", () => {
  it("denies sparse public resource mappings", () => {
    expect(
      projectGoogleConsentModeState(
        { resources: [] },
        { analyticsStorageResourceIds: new Array<string>(1) },
      ),
    ).toEqual({
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "denied",
    });
  });

  it("ignores an overridden mapping array method when projecting access", () => {
    const resourceIds = ["missing-resource"];
    let everyCalls = 0;
    Object.defineProperty(resourceIds, "every", {
      value: () => {
        everyCalls += 1;
        return true;
      },
    });

    expect(
      projectGoogleConsentModeState(
        { resources: [] },
        { analyticsStorageResourceIds: resourceIds },
      ),
    ).toEqual({
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "denied",
    });
    expect(everyCalls).toBe(0);
  });

  it("reads a mapping array length through its own descriptor", () => {
    let lengthReads = 0;
    const resourceIds = new Proxy(["allowed-resource", "missing-resource"], {
      get(target, field, receiver): unknown {
        if (field === "length") {
          lengthReads += 1;
          return 1;
        }
        return Reflect.get(target, field, receiver);
      },
    });

    expect(
      projectGoogleConsentModeState(
        {
          resources: [
            {
              access: "allowed",
              basis: "explicit-consent",
              blockReasons: [],
              resourceId: "allowed-resource",
              serviceId: "metrics",
            },
          ],
        },
        { analyticsStorageResourceIds: resourceIds },
      ),
    ).toEqual({
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "denied",
    });
    expect(lengthReads).toBe(0);
  });

  it("preserves one inherited mapping read while validating the returned array", () => {
    let mappingReads = 0;
    class InheritedMapping {
      get analyticsStorageResourceIds(): readonly string[] {
        mappingReads += 1;
        return ["allowed-resource"];
      }
    }

    expect(
      projectGoogleConsentModeState(
        {
          resources: [
            {
              access: "allowed",
              basis: "explicit-consent",
              blockReasons: [],
              resourceId: "allowed-resource",
              serviceId: "metrics",
            },
          ],
        },
        new InheritedMapping(),
      ),
    ).toEqual({
      adPersonalization: "denied",
      adStorage: "denied",
      adUserData: "denied",
      analyticsStorage: "granted",
    });
    expect(mappingReads).toBe(1);
  });

  it("preserves a valid public mapping above the boundary capture budget", () => {
    expect(
      projectGoogleConsentModeState(
        {
          resources: [
            {
              access: "allowed",
              basis: "explicit-consent",
              blockReasons: [],
              resourceId: "allowed-resource",
              serviceId: "metrics",
            },
          ],
        },
        {
          analyticsStorageResourceIds: Array.from(
            { length: 10_001 },
            () => "allowed-resource",
          ),
        },
      ),
    ).toMatchObject({ analyticsStorage: "granted" });
  });

  it("TEST-CONSENT-MODE-ORDER sends denied defaults before the effective update", () => {
    const log = commandLog();
    const broadcaster = createGoogleConsentModeBroadcaster({
      command: log.command,
    });

    expect(broadcaster.mode).toBe("basic");
    expect(broadcaster.establishDeniedDefaults()).toEqual({ status: "sent" });
    expect(
      broadcaster.update({
        adPersonalization: "denied",
        adStorage: "granted",
        adUserData: "denied",
        analyticsStorage: "granted",
      }),
    ).toEqual({ status: "sent" });

    expect(log.calls).toEqual([
      [
        "consent",
        "default",
        {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "denied",
        },
      ],
      [
        "consent",
        "update",
        {
          ad_storage: "granted",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "granted",
        },
      ],
    ]);
  });

  it("refuses an update before defaults and emits defaults only once", () => {
    const log = commandLog();
    const broadcaster = createGoogleConsentModeBroadcaster({
      command: log.command,
      mode: "advanced",
      waitForUpdateMs: 500,
    });

    expect(
      broadcaster.update({
        adPersonalization: "granted",
        adStorage: "granted",
        adUserData: "granted",
        analyticsStorage: "granted",
      }),
    ).toEqual({ status: "defaults-not-established" });
    expect(broadcaster.establishDeniedDefaults()).toEqual({ status: "sent" });
    expect(broadcaster.establishDeniedDefaults()).toEqual({
      status: "already-sent",
    });
    expect(log.calls).toEqual([
      [
        "consent",
        "default",
        {
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          analytics_storage: "denied",
          wait_for_update: 500,
        },
      ],
    ]);
  });

  it("reports command failures without falsely advancing broadcaster state", () => {
    let attempts = 0;
    const broadcaster = createGoogleConsentModeBroadcaster({
      command: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("data layer unavailable");
      },
    });

    expect(broadcaster.establishDeniedDefaults()).toEqual({
      status: "command-failed",
    });
    expect(broadcaster.establishDeniedDefaults()).toEqual({ status: "sent" });
  });
});
