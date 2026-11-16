import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Below 52.5rem the soft and minimal templates widen the links row and the
// choices to the full width of the bar. Each then needs its own row, or the
// links row, which follows the choices in the DOM, is drawn over the buttons.

function narrowBlock(name: string): string {
  const css = readFileSync(
    new URL(`../templates/${name}.css`, import.meta.url),
    "utf8",
  );
  const start = css.indexOf("@media (max-width: 52.5rem)");
  if (start < 0) throw new Error(`${name}.css has no 52.5rem block.`);
  const next = css.indexOf("@media", start + 1);
  return css.slice(start, next < 0 ? undefined : next);
}

describe.each(["soft", "minimal"])("the %s template below 52.5rem", (name) => {
  it("puts the links in their own row below the choices", () => {
    expect(narrowBlock(name)).toMatch(
      /\.oc-root \.oc-bar-links \{\s*grid-row: 3;\s*\}/,
    );
  });
});
