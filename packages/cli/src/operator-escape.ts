/**
 * Makes a value safe to put in a page.
 *
 * Everything the console renders came from somewhere else: a site name an
 * operator typed, a finding a page loaded, a consent identifier a visitor's
 * browser sent. All five characters matter, not only the angle brackets: a
 * value is rendered inside an attribute as well as between tags, and a
 * surviving quote ends the attribute and begins another one.
 *
 * @public
 */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        '"': "&quot;",
        "&": "&amp;",
        "'": "&#39;",
        "<": "&lt;",
        ">": "&gt;",
      })[character] ?? character,
  );
}
