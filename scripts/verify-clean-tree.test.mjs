import assert from "node:assert/strict";
import test from "node:test";

import { assertCleanRepositoryStatus } from "./verify-clean-tree-lib.mjs";

test("the clean-tree gate accepts an empty porcelain status", () => {
  assert.doesNotThrow(() => assertCleanRepositoryStatus(""));
  assert.doesNotThrow(() => assertCleanRepositoryStatus("\n"));
});

test("the clean-tree gate reports tracked, staged, and untracked changes", () => {
  assert.throws(
    () =>
      assertCleanRepositoryStatus(
        " M packages/core/src/index.ts\nA  docs/new.md\n?? unexpected.txt\n",
      ),
    /packages\/core\/src\/index\.ts.*docs\/new\.md.*unexpected\.txt/su,
  );
});
