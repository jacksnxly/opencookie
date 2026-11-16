import { BINDING_TAG } from "./contract-catalogue.mjs";

/** Stable browser-fixture contract for G6. */
export const E2E_FIXTURES = Object.freeze([
  "plain-cdn",
  "react-vite",
  "vue-vite",
  "next-app",
  "next-pages",
  "nuxt",
  "sveltekit",
  "astro",
]);

/** Playwright engine names supported by the full matrix. */
export const E2E_ENGINES = Object.freeze(["chromium", "firefox", "webkit"]);

/** Cross-engine viewport definitions. These do not claim physical devices. */
export const E2E_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({
    hasTouch: false,
    screen: Object.freeze({ height: 900, width: 1440 }),
    viewport: Object.freeze({ height: 900, width: 1440 }),
  }),
  mobile: Object.freeze({
    hasTouch: true,
    screen: Object.freeze({ height: 844, width: 390 }),
    viewport: Object.freeze({ height: 844, width: 390 }),
  }),
});

const PROXY_SERVER = "http://127.0.0.1:4400";
const FIREFOX_KEYBOARD_FOCUS_LAUNCH_OPTIONS = Object.freeze({
  firefoxUserPrefs: Object.freeze({ "accessibility.tabfocus": 7 }),
});

/**
 * Browser-matrix tiers. The change tier gates every change; the release tier
 * is the full matrix that gates a publish.
 */
export const E2E_TIERS = Object.freeze(["change", "release"]);

/** The fixture that the change tier still runs in every engine and viewport. */
const ALL_ENGINES_FIXTURE = "plain-cdn";
/** The engine that the change tier runs each framework fixture in. */
const BINDING_ENGINE = "chromium";

/** Produces the exact 8 by 3 by 2 Playwright project matrix. */
function createReleaseProjects() {
  const projects = [];
  for (const fixtureId of E2E_FIXTURES) {
    for (const browserName of E2E_ENGINES) {
      for (const [viewportKind, viewportOptions] of Object.entries(
        E2E_VIEWPORTS,
      )) {
        projects.push(
          Object.freeze({
            metadata: Object.freeze({ fixtureId, viewportKind }),
            name: `${fixtureId}-${browserName}-${viewportKind}`,
            use: Object.freeze({
              baseURL: `http://app.${fixtureId}.opencookie.test:4400`,
              browserName,
              hasTouch: viewportOptions.hasTouch,
              ...(browserName === "firefox"
                ? { launchOptions: FIREFOX_KEYBOARD_FOCUS_LAUNCH_OPTIONS }
                : {}),
              proxy: Object.freeze({ server: PROXY_SERVER }),
              screen: viewportOptions.screen,
              viewport: viewportOptions.viewport,
            }),
          }),
        );
      }
    }
  }
  return Object.freeze(projects);
}

/**
 * Produces the Playwright projects of one tier. The release tier is the full
 * matrix. The change tier keeps the plain-cdn projects in every engine and
 * viewport, then runs each framework fixture in Chromium on the tests tagged
 * with BINDING_TAG only; every project keeps its release options.
 */
export function createPlaywrightProjects({ tier = "release" } = {}) {
  if (!E2E_TIERS.includes(tier)) {
    throw new Error(
      `Unknown E2E tier ${JSON.stringify(tier)}; expected one of: ${E2E_TIERS.join(", ")}.`,
    );
  }
  const releaseProjects = createReleaseProjects();
  if (tier === "release") return releaseProjects;
  return Object.freeze([
    ...releaseProjects.filter(
      ({ metadata }) => metadata.fixtureId === ALL_ENGINES_FIXTURE,
    ),
    ...releaseProjects
      .filter(
        ({ metadata, use }) =>
          metadata.fixtureId !== ALL_ENGINES_FIXTURE &&
          use.browserName === BINDING_ENGINE,
      )
      // Playwright resets lastIndex on a project's grep, so it stays unfrozen.
      .map((project) =>
        Object.freeze({ ...project, grep: new RegExp(BINDING_TAG, "u") }),
      ),
  ]);
}
