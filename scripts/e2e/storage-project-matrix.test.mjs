import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createStoragePlaywrightProjects,
  STORAGE_E2E_ENGINES,
  STORAGE_E2E_VIEWPORT,
} from "./storage-project-matrix.mjs";

describe("storage-resilience Playwright project matrix", () => {
  it("defines only Chromium, Firefox, and WebKit desktop projects", () => {
    assert.deepEqual(STORAGE_E2E_ENGINES, [
      { browserName: "chromium", label: "Chromium" },
      { browserName: "firefox", label: "Firefox" },
      { browserName: "webkit", label: "WebKit" },
    ]);
    assert.deepEqual(STORAGE_E2E_VIEWPORT, {
      hasTouch: false,
      screen: { height: 900, width: 1440 },
      viewport: { height: 900, width: 1440 },
    });

    const projects = createStoragePlaywrightProjects();
    assert.deepEqual(
      projects.map(({ name }) => name),
      ["storage-chromium", "storage-firefox", "storage-webkit"],
    );
    assert.equal(projects.length, 3);
    assert.equal(
      JSON.stringify(projects).toLowerCase().includes("safari"),
      false,
    );
  });

  it("uses the existing loopback proxy without mobile emulation", () => {
    for (const project of createStoragePlaywrightProjects()) {
      assert.deepEqual(project.use.proxy, {
        server: "http://127.0.0.1:4400",
      });
      assert.equal(project.use.hasTouch, false);
      assert.deepEqual(project.use.screen, { height: 900, width: 1440 });
      assert.deepEqual(project.use.viewport, { height: 900, width: 1440 });
      assert.equal("isMobile" in project.use, false);
      assert.equal(project.metadata.viewportKind, "desktop");
    }
  });
});
