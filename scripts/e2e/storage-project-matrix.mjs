/** Browser engines exercised by the standalone storage-resilience suite. */
export const STORAGE_E2E_ENGINES = Object.freeze([
  Object.freeze({ browserName: "chromium", label: "Chromium" }),
  Object.freeze({ browserName: "firefox", label: "Firefox" }),
  Object.freeze({ browserName: "webkit", label: "WebKit" }),
]);

/** Desktop test viewport. It does not claim to represent a physical device. */
export const STORAGE_E2E_VIEWPORT = Object.freeze({
  hasTouch: false,
  screen: Object.freeze({ height: 900, width: 1440 }),
  viewport: Object.freeze({ height: 900, width: 1440 }),
});

const PROXY_SERVER = "http://127.0.0.1:4400";

/** Produces the exact three-project storage-resilience browser matrix. */
export function createStoragePlaywrightProjects() {
  return Object.freeze(
    STORAGE_E2E_ENGINES.map(({ browserName, label }) =>
      Object.freeze({
        metadata: Object.freeze({
          browserLabel: label,
          viewportKind: "desktop",
        }),
        name: `storage-${browserName}`,
        use: Object.freeze({
          browserName,
          hasTouch: STORAGE_E2E_VIEWPORT.hasTouch,
          proxy: Object.freeze({ server: PROXY_SERVER }),
          screen: STORAGE_E2E_VIEWPORT.screen,
          viewport: STORAGE_E2E_VIEWPORT.viewport,
        }),
      }),
    ),
  );
}
