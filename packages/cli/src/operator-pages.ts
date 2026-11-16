import { escapeHtml } from "./operator-escape.js";
import type { SiteRegistry } from "./site-registry.js";

/**
 * The console's pages.
 *
 * This module decides nothing: it is handed what a page should say and returns
 * the markup for it, the way a command is handed lines to print. Which page an
 * operator is allowed to reach, and what a refusal means, belong to the server
 * next to it.
 */

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </body>
</html>
`;
}

function hiddenFormToken(formToken: string | undefined): string {
  return formToken === undefined
    ? ""
    : `<input type="hidden" name="formToken" value="${escapeHtml(formToken)}">`;
}

/** The one page a caller with no credential is allowed to see. */
export function signInPage(options: {
  readonly encrypted: boolean;
  readonly message?: string;
}): string {
  const warning = options.encrypted
    ? ""
    : `<p>This connection is not encrypted, so a token typed here can be read in transit. Use HTTPS, or reach this surface only from the machine it runs on.</p>`;
  return page(
    "Sign in",
    `${options.message === undefined ? "" : `<p>${escapeHtml(options.message)}</p>`}
    ${warning}
    <form method="post" action="/login">
      <label>Operator token <input name="token" type="password" required></label>
      <button type="submit">Sign in</button>
    </form>`,
  );
}

/** Says what is missing, and offers the way to supply it. */
export function signInRequiredPage(): string {
  return page(
    "Sign in required",
    `<p>This surface needs an operator token.</p><p><a href="/login">Sign in</a></p>`,
  );
}

export function notFromThisFormPage(): string {
  return page(
    "Not accepted",
    "<p>That request did not come from this surface's own form, so nothing was changed. Reload the page and try again.</p>",
  );
}

export function nothingHerePage(): string {
  return page("Not found", "<p>Nothing is served here.</p>");
}

/** Reports a refusal in the words the domain used. */
export function refusedPage(title: string, message: string): string {
  return page(title, `<p>${escapeHtml(message)}</p>`);
}

export function unreadableRegistryPage(path: string): string {
  return page(
    "Sites",
    `<p>${escapeHtml(path)} failed validation, so nothing was read. Restore it from a backup rather than deleting it.</p>`,
  );
}

export function sitesPage(
  registry: SiteRegistry,
  formToken: string | undefined,
): string {
  const rows =
    registry.sites.length === 0
      ? "<p>No sites yet. Create the first one.</p>"
      : `<ul>${registry.sites
          .map((site) => {
            const to = encodeURIComponent(site.name);
            return `<li><strong>${escapeHtml(site.name)}</strong> ${escapeHtml(site.domains.join(", "))} <a href="/sites/${to}/findings">findings</a> <a href="/sites/${to}/policy">policy</a> <a href="/sites/${to}/evidence">evidence</a> <a href="/sites/${to}/doctor">doctor</a></li>`;
          })
          .join("")}</ul>`;
  const hidden = hiddenFormToken(formToken);
  const signOut =
    formToken === undefined
      ? ""
      : `<form method="post" action="/logout">${hidden}<button type="submit">Sign out</button></form>`;
  return page(
    "Sites",
    `${rows}
    <form method="post" action="/sites">
      ${hidden}
      <label>Name <input name="name" required></label>
      <label>Domain <input name="domain" required></label>
      <button type="submit">Create site</button>
    </form>
    ${signOut}`,
  );
}

/**
 * The form that records one decision about one finding.
 *
 * Every field the domain requires is asked for by name, so an operator is
 * never told afterwards that something was missing which the page never
 * offered.
 */
export function classifyForm(options: {
  readonly cleanups: readonly string[];
  readonly formToken: string | undefined;
  readonly kind: string;
  readonly name: string;
  readonly site: string;
}): string {
  const field = (label: string, input: string): string =>
    `<label>${escapeHtml(label)} ${input}</label>`;
  return `<form method="post" action="/sites/${encodeURIComponent(options.site)}/findings/classify">
      ${hiddenFormToken(options.formToken)}
      <input type="hidden" name="name" value="${escapeHtml(options.name)}">
      <input type="hidden" name="kind" value="${escapeHtml(options.kind)}">
      ${field("Purpose", '<input name="purpose" required>')}
      ${field("Vendor", '<input name="vendor" required>')}
      ${field("Service", '<input name="service" required>')}
      ${field("Data category", '<input name="category" required>')}
      ${field("Disclosure", '<input name="disclosure" required>')}
      ${field("Retention", '<input name="retention" required>')}
      ${field(
        "On withdrawal",
        `<select name="cleanup">${options.cleanups
          .map(
            (cleanup) =>
              `<option value="${escapeHtml(cleanup)}">${escapeHtml(cleanup)}</option>`,
          )
          .join("")}</select>`,
      )}
      ${field("Strictly necessary", '<input type="checkbox" name="necessary" value="yes">')}
      <button type="submit">Record this decision</button>
    </form>`;
}

/** What a command printed, as a page. Every line is escaped. */
export function linesPage(
  title: string,
  lines: readonly string[],
  note?: string,
  forms = "",
): string {
  return page(
    title,
    `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      ${note === undefined ? "" : `<p>${escapeHtml(note)}</p>`}
      ${forms}
      <p><a href="/">All sites</a></p>`,
  );
}

export function policyPage(options: {
  readonly formToken: string | undefined;
  readonly lines: readonly string[];
  readonly name: string;
  readonly published: boolean;
  readonly starterPath: string;
  readonly starterWritten: boolean;
}): string {
  const to = encodeURIComponent(options.name);
  const hidden = hiddenFormToken(options.formToken);
  const starter = options.starterWritten
    ? `<p>${escapeHtml(options.starterPath)} is ready. Edit its wording, then publish it below.</p>`
    : `<form method="post" action="/sites/${to}/policy/starter">
        ${hidden}
        <button type="submit">Write a starter policy</button>
      </form>`;
  return page(
    `Policy for ${options.name}`,
    `<ul>${options.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      ${starter}
      <form method="post" action="/sites/${to}/policy/publish">
        ${hidden}
        <label>Publication <input name="id" required></label>
        <label>Policy file <input name="policy" value="${escapeHtml(options.starterPath)}" required></label>
        <button type="submit">Publish</button>
      </form>
      ${
        options.published
          ? `<form method="post" action="/sites/${to}/policy/install">
        ${hidden}
        <button type="submit">Install the published policy</button>
      </form>
      <p>Publishing records a decision. Installing is what makes the site enforce it, and until then visitors decide against the policy that is still installed.</p>`
          : ""
      }
      <p>A starter describes what a typical site does, not what yours does, so edit its wording before publishing it.</p>
      <p><a href="/">All sites</a></p>`,
  );
}

/**
 * A site's consent evidence, with the ways an operator may act on it.
 *
 * Erasure and retention change a visitor's record and an export discloses it,
 * so each sits in its own form and carries the session's token. The filters
 * are shown filled in, so what is on screen says which receipts these are.
 */
export function evidencePageBody(options: {
  readonly consentId: string;
  readonly formToken: string | undefined;
  readonly lines: readonly string[];
  readonly name: string;
  readonly since: string;
  readonly until: string;
}): string {
  const to = encodeURIComponent(options.name);
  const hidden = hiddenFormToken(options.formToken);
  const action = (rest: string, fields: string, button: string): string =>
    `<form method="post" action="/sites/${to}/evidence/${rest}">${hidden}${fields}<button type="submit">${escapeHtml(button)}</button></form>`;
  // The export says "these receipts", so it carries the filter the list is
  // under; without it the page would promise one thing and write another.
  const showing = [
    ["consentId", options.consentId],
    ["since", options.since],
    ["until", options.until],
  ]
    .filter(([, value]) => value !== "")
    .map(
      ([field, value]) =>
        `<input type="hidden" name="${escapeHtml(String(field))}" value="${escapeHtml(String(value))}">`,
    )
    .join("");
  return page(
    `Consent evidence for ${options.name}`,
    `<form method="get" action="/sites/${to}/evidence">
      <label>Consent id <input name="consentId" value="${escapeHtml(options.consentId)}"></label>
      <label>Since <input name="since" value="${escapeHtml(options.since)}"></label>
      <label>Until <input name="until" value="${escapeHtml(options.until)}"></label>
      <button type="submit">Show these</button>
    </form>
    <ul>${options.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
    ${action("export", `${showing}<label>Write to <input name="out" value="opencookie/consent-evidence-export.json" required></label>`, "Export these receipts")}
    ${action("retain", '<label>Keep receipts newer than <input name="days" type="number" min="1" required> days</label>', "Apply this retention period")}
    ${action("delete", '<label>Erase everything for <input name="consentId" required></label>', "Erase this visitor's receipts")}
    <p>Erasing and applying a retention period remove receipts for good. An export writes them where you say, inside this site.</p>
    <p><a href="/">All sites</a></p>`,
  );
}
