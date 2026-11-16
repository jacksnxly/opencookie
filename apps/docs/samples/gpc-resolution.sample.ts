// docs:consumer-path: src/gpc-resolution.ts

// docs:display:start
import {
  resolveGpcRestrictions,
  resolveGpcSignal,
} from "@opencookie-dev/core/domain";

export function restrictionsForNavigation(input: {
  browserValue: boolean | undefined;
  navigationId: string;
  serverHeader: string | undefined;
}) {
  const observedAtMs = Date.now();
  const resolution = resolveGpcSignal({
    navigationId: input.navigationId,
    observations: [
      {
        navigationId: input.navigationId,
        observedAtMs,
        source: "server",
        value: input.serverHeader === "1" ? "enabled" : "absent",
      },
      ...(typeof input.browserValue === "boolean"
        ? [
            {
              navigationId: input.navigationId,
              observedAtMs,
              source: "browser" as const,
              value: input.browserValue
                ? ("enabled" as const)
                : ("absent" as const),
            },
          ]
        : []),
    ],
  });

  return resolveGpcRestrictions({
    resolution,
    whenEnabled: {
      purposeIds: ["sale", "targeted-advertising"],
      resourceIds: ["ad-pixel"],
      serviceIds: ["audience-vendor"],
    },
  });
}
// docs:display:end

export function run(): void {
  const restrictions = restrictionsForNavigation({
    browserValue: false,
    navigationId: "request-42",
    serverHeader: "1",
  });
  if (
    restrictions.source !== "gpc" ||
    !restrictions.purposeIds.includes("sale")
  ) {
    throw new Error(
      "The enabled GPC sample did not restrict the mapped purpose.",
    );
  }
}
