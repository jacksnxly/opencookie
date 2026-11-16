import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { describe, it } from "node:test";

import { BINDING_TAG } from "./contract-catalogue.mjs";
import {
  createPlaywrightProjects,
  E2E_ENGINES,
  E2E_FIXTURES,
  E2E_TIERS,
  E2E_VIEWPORTS,
} from "./project-matrix.mjs";

const EXPECTED_FIXTURES = [
  "plain-cdn",
  "react-vite",
  "vue-vite",
  "next-app",
  "next-pages",
  "nuxt",
  "sveltekit",
  "astro",
];

function allTierProjects() {
  return E2E_TIERS.flatMap((tier) => createPlaywrightProjects({ tier }));
}

describe("Playwright project matrix", () => {
  it("defines the eight approved fixtures, three engines, two viewports, and two tiers", () => {
    assert.deepEqual(E2E_FIXTURES, EXPECTED_FIXTURES);
    assert.deepEqual(E2E_ENGINES, ["chromium", "firefox", "webkit"]);
    assert.deepEqual(Object.keys(E2E_VIEWPORTS), ["desktop", "mobile"]);
    assert.deepEqual(E2E_TIERS, ["change", "release"]);
  });

  it("generates 48 stable and unique project names", () => {
    const projects = createPlaywrightProjects();
    const names = projects.map(({ name }) => name);

    assert.equal(projects.length, 48);
    assert.equal(new Set(names).size, 48);
    assert.equal(names[0], "plain-cdn-chromium-desktop");
    assert.equal(names.at(-1), "astro-webkit-mobile");
    assert.ok(names.includes("next-pages-firefox-mobile"));
    assert.ok(names.includes("nuxt-webkit-desktop"));
  });

  it("makes the release tier the default: every fixture, engine, and viewport with no grep", () => {
    const release = createPlaywrightProjects({ tier: "release" });

    assert.deepEqual(
      release.map(({ name }) => name),
      EXPECTED_FIXTURES.flatMap((fixture) =>
        ["chromium", "firefox", "webkit"].flatMap((engine) =>
          ["desktop", "mobile"].map(
            (viewport) => `${fixture}-${engine}-${viewport}`,
          ),
        ),
      ),
    );
    assert.equal(
      release.some((project) => "grep" in project),
      false,
    );
    assert.deepEqual(createPlaywrightProjects(), release);
  });

  it("keeps each change-tier project's release options and greps only framework projects", () => {
    const release = new Map(
      createPlaywrightProjects({ tier: "release" }).map((project) => [
        project.name,
        project,
      ]),
    );
    const change = createPlaywrightProjects({ tier: "change" });

    assert.equal(change.length, 20);
    for (const project of change) {
      const { grep, ...options } = project;
      assert.deepEqual(options, release.get(project.name), project.name);
      if (project.metadata.fixtureId === "plain-cdn") {
        assert.equal("grep" in project, false, project.name);
      } else {
        assert.equal(project.use.browserName, "chromium", project.name);
        assert.ok(grep instanceof RegExp, project.name);
        assert.equal(String(grep), "/@binding/u", project.name);
      }
    }
  });

  it("matches the binding grep on the tag, never on a project name or spec path", async () => {
    const specFiles = (
      await readdir(new URL("../../tests/e2e/contracts/", import.meta.url))
    ).filter((file) => file.endsWith(".spec.ts"));
    const grepped = createPlaywrightProjects({ tier: "change" }).filter(
      (project) => project.grep !== undefined,
    );

    assert.equal(grepped.length, 14);
    assert.ok(specFiles.length > 0);
    for (const project of grepped) {
      // Playwright tests a project's grep against the project name, the spec
      // path, the describe and test titles, and the tags, joined by spaces.
      for (const file of specFiles) {
        const base = `${project.name} tests/e2e/contracts/${file} TEST-CONSENT-MODE-ORDER`;
        assert.equal(project.grep.test(base), false, `${project.name} ${file}`);
        assert.equal(project.grep.test(`${base} ${BINDING_TAG}`), true);
      }
    }
  });

  it("rejects an unknown tier by name", () => {
    assert.throws(
      () => createPlaywrightProjects({ tier: "nightly" }),
      /Unknown E2E tier "nightly"/u,
    );
    assert.throws(
      () => createPlaywrightProjects({ tier: "" }),
      /Unknown E2E tier ""/u,
    );
  });

  it("uses real reserved test origins and a loopback forward proxy", () => {
    for (const project of allTierProjects()) {
      const fixtureId = project.metadata.fixtureId;
      assert.equal(
        project.use.baseURL,
        `http://app.${fixtureId}.opencookie.test:4400`,
      );
      assert.deepEqual(project.use.proxy, {
        server: "http://127.0.0.1:4400",
      });
    }
  });

  it("models mobile as a cross-engine touch viewport without isMobile", () => {
    for (const project of allTierProjects()) {
      assert.equal("isMobile" in project.use, false);
      if (project.metadata.viewportKind === "mobile") {
        assert.deepEqual(project.use.viewport, { height: 844, width: 390 });
        assert.deepEqual(project.use.screen, { height: 844, width: 390 });
        assert.equal(project.use.hasTouch, true);
      } else {
        assert.deepEqual(project.use.viewport, { height: 900, width: 1440 });
        assert.equal(project.use.hasTouch, false);
      }
    }
  });

  it("normalizes Firefox keyboard focus independently of the macOS host", () => {
    for (const project of allTierProjects()) {
      if (project.use.browserName === "firefox") {
        assert.deepEqual(project.use.launchOptions, {
          firefoxUserPrefs: { "accessibility.tabfocus": 7 },
        });
      } else {
        assert.equal("launchOptions" in project.use, false);
      }
    }
  });
});
