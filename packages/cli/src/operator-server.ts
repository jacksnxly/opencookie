import { timingSafeEqual } from "node:crypto";

import type { FileSystemPort } from "./contracts.js";
import {
  type OperatorSession,
  type OperatorSessionStore,
} from "./operator-session.js";
import { runDoctor } from "./doctor.js";
import {
  EXPORT_COPIES_NOTICE,
  runEvidenceCommand,
} from "./evidence-command.js";
import {
  readFindingsInventory,
  runFindingsCommand,
} from "./findings-command.js";
import { FINDING_CLEANUPS } from "./findings.js";
import {
  classifyForm,
  evidencePageBody,
  linesPage,
  notFromThisFormPage,
  nothingHerePage,
  policyPage as renderPolicyPage,
  refusedPage,
  signInPage,
  signInRequiredPage,
  sitesPage,
  unreadableRegistryPage,
} from "./operator-pages.js";
import { runPolicyCommand, STARTER_POLICY_PATH } from "./policy-command.js";
import {
  runSitesCommand,
  selectSite,
  SITE_REGISTRY_PATH,
} from "./sites-command.js";
import { emptySiteRegistry, type SiteRegistry } from "./site-registry.js";

/**
 * Passes one operator-entered value to a command as `--flag=value`.
 *
 * Form values arrive from a browser, and a consent id may begin with "--", so
 * a separate argument could read as another flag.
 */
function flagValue(flag: string, value: string): string {
  return `${flag}=${value}`;
}

/** One request to the operator surface, free of any HTTP library. @public */
export interface OperatorRequest {
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
  /** Whether the connection carrying this request is encrypted. */
  readonly secure?: boolean;
}

/** @public */
export interface OperatorResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

/** What the operator surface needs to serve a request. @public */
export interface OperatorServerPorts {
  readonly fileSystem: FileSystemPort;
  /** The clock the evidence commands read, stated rather than assumed. */
  readonly now: () => number;
  readonly sessions: OperatorSessionStore;
  /** Slows repeated wrong tokens; the console always supplies one. */
  readonly signInLimiter?: OperatorSignInLimiter;
  readonly token: string;
}

/**
 * Slows repeated wrong tokens so one cannot be guessed.
 *
 * @public
 */
export interface OperatorSignInLimiter {
  /** Milliseconds until another attempt is heard, or 0. */
  readonly retryAfterMs: (now: number) => number;
  /** Records a wrong token. */
  readonly failed: (now: number) => void;
  /** Records the right token, which clears the count. */
  readonly succeeded: () => void;
}

/**
 * Lets five wrong tokens through, then makes every further attempt wait,
 * starting at one second and doubling to a minute. The right token resets it.
 *
 * @public
 */
export function createSignInLimiter(): OperatorSignInLimiter {
  let failures = 0;
  let blockedUntil = 0;
  return Object.freeze({
    failed(now: number): void {
      failures += 1;
      if (failures >= 5) {
        blockedUntil = now + Math.min(60_000, 1_000 * 2 ** (failures - 5));
      }
    },
    retryAfterMs: (now: number) => Math.max(0, blockedUntil - now),
    succeeded(): void {
      failures = 0;
      blockedUntil = 0;
    },
  });
}

/**
 * Whether a request comes from a page of another site. Its sign-in attempts
 * are refused before the limiter hears them, so no other page open in the
 * operator's browser can lock the operator out.
 */
function fromAnotherSite(request: OperatorRequest): boolean {
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return true;
  }
  const origin = request.headers["origin"];
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== request.headers["host"];
  } catch {
    return true;
  }
}

function throttled(waitMs: number): OperatorResponse {
  return {
    body: "Too many wrong tokens. Try again shortly.\n",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(Math.ceil(waitMs / 1_000)),
    },
    status: 429,
  };
}

/**
 * What the console will do to consent evidence.
 *
 * Exporting discloses a visitor's record and the other two change it, so each
 * one is named here rather than any word after `evidence/` being run.
 */
const EVIDENCE_ACTIONS = new Set(["delete", "export", "retain"]);

/** The cookie the operator's browser carries once signed in. @public */
export const OPERATOR_SESSION_COOKIE = "opencookie_operator";

/**
 * What every page the console serves is allowed to do.
 *
 * These pages load nothing and run nothing: the whole surface is HTML this
 * module wrote. Saying so means a string that escaped its escaping still has
 * nothing to fetch, nowhere to post and no frame to sit in. `frame-ancestors`
 * keeps the console out of another page's frame, where an operator could be
 * made to click something they cannot see.
 */
const HTML = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/**
 * Compares two credentials in time that does not depend on how much of them
 * matches, so the surface does not leak one a character at a time.
 */
function sameSecret(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookies(header: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    values.set(
      part.slice(0, separator).trim(),
      part.slice(separator + 1).trim(),
    );
  }
  return values;
}

function formValues(body: string): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  for (const [key, value] of new URLSearchParams(body)) {
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}

/**
 * Who is making this request.
 *
 * A machine presents the token on every request and holds no session, so it
 * cannot be made to act by another site. A browser presents a cookie, which
 * travels whether or not the operator meant to send it.
 */
type Caller =
  | { readonly kind: "bearer" }
  | { readonly kind: "none" }
  | {
      readonly id: string;
      readonly kind: "session";
      readonly session: OperatorSession;
    };

function identify(
  request: OperatorRequest,
  ports: OperatorServerPorts,
): Caller {
  const header = request.headers["authorization"] ?? "";
  if (
    header.startsWith("Bearer ") &&
    sameSecret(header.slice("Bearer ".length), ports.token)
  ) {
    return { kind: "bearer" };
  }
  const id = cookies(request.headers["cookie"] ?? "").get(
    OPERATOR_SESSION_COOKIE,
  );
  if (id !== undefined) {
    const session = ports.sessions.read(id);
    if (session !== undefined) return { id, kind: "session", session };
  }
  return { kind: "none" };
}

function sessionCookie(id: string, secure: boolean): string {
  const attributes = [
    `${OPERATOR_SESSION_COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function callerFormToken(caller: Caller): string | undefined {
  return caller.kind === "session" ? caller.session.formToken : undefined;
}

function refusal(): OperatorResponse {
  return { body: signInRequiredPage(), headers: HTML, status: 401 };
}

/**
 * Refuses a write that a cookie alone authorised.
 *
 * Nothing is read or written before this returns, so a request another site
 * provoked cannot change anything.
 */
function forgedWrite(caller: Caller, request: OperatorRequest): boolean {
  if (caller.kind !== "session") return false;
  const presented = formValues(request.body ?? "").get("formToken")?.[0] ?? "";
  return !sameSecret(presented, caller.session.formToken);
}

async function readRegistry(
  fileSystem: FileSystemPort,
): Promise<SiteRegistry | undefined> {
  if (!(await fileSystem.exists(SITE_REGISTRY_PATH))) {
    return emptySiteRegistry();
  }
  try {
    const parsed = JSON.parse(
      await fileSystem.readFile(SITE_REGISTRY_PATH),
    ) as {
      sites?: SiteRegistry["sites"];
    };
    return Array.isArray(parsed.sites) ? { sites: parsed.sites } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serves one request to the operator surface.
 *
 * Every path but the sign-in page is behind a credential, including the ones
 * that only read: a site's policy and its visitors' evidence are not public.
 * The surface owns no rules of its own; it calls the same commands the
 * terminal does, so the two cannot disagree about what is allowed.
 *
 * @public
 */
export async function handleOperatorRequest(
  request: OperatorRequest,
  ports: OperatorServerPorts,
): Promise<OperatorResponse> {
  // The request target is a path and, when the operator has narrowed a list,
  // a query. Routing is decided by the path half alone.
  const separator = request.path.indexOf("?");
  const path =
    separator === -1 ? request.path : request.path.slice(0, separator);
  const query = new URLSearchParams(
    separator === -1 ? "" : request.path.slice(separator + 1),
  );
  if (path === "/login") {
    if (request.method !== "POST") {
      return {
        body: signInPage({ encrypted: request.secure === true }),
        headers: HTML,
        status: 200,
      };
    }
    if (fromAnotherSite(request)) {
      return {
        body: "Sign in from the console's own page.\n",
        headers: { "content-type": "text/plain; charset=utf-8" },
        status: 403,
      };
    }
    const wait = ports.signInLimiter?.retryAfterMs(ports.now()) ?? 0;
    if (wait > 0) return throttled(wait);
    const presented = formValues(request.body ?? "").get("token")?.[0] ?? "";
    if (!sameSecret(presented, ports.token)) {
      ports.signInLimiter?.failed(ports.now());
      return {
        body: signInPage({
          encrypted: request.secure === true,
          message: "That token was not accepted.",
        }),
        headers: HTML,
        status: 401,
      };
    }
    ports.signInLimiter?.succeeded();
    const session = ports.sessions.create();
    return {
      body: "",
      headers: {
        location: "/",
        "set-cookie": sessionCookie(session.id, request.secure === true),
      },
      status: 303,
    };
  }

  const bearer = (request.headers["authorization"] ?? "").startsWith("Bearer ");
  const wait = bearer
    ? (ports.signInLimiter?.retryAfterMs(ports.now()) ?? 0)
    : 0;
  if (wait > 0) return throttled(wait);
  const caller = identify(request, ports);
  if (caller.kind === "none") {
    if (bearer) ports.signInLimiter?.failed(ports.now());
    return refusal();
  }
  if (caller.kind === "bearer") ports.signInLimiter?.succeeded();

  if (request.method === "POST" && path === "/logout") {
    if (forgedWrite(caller, request)) return forgedWriteResponse();
    if (caller.kind === "session") ports.sessions.destroy(caller.id);
    return {
      body: "",
      headers: {
        location: "/login",
        "set-cookie": `${OPERATOR_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      },
      status: 303,
    };
  }

  if (request.method === "GET" && path === "/") {
    const registry = await readRegistry(ports.fileSystem);
    if (registry === undefined) {
      return {
        body: unreadableRegistryPage(SITE_REGISTRY_PATH),
        headers: HTML,
        status: 500,
      };
    }
    return {
      body: sitesPage(registry, callerFormToken(caller)),
      headers: HTML,
      status: 200,
    };
  }

  const route = siteRoute(path);
  if (route !== undefined) {
    if (request.method === "GET" && route.rest === "findings") {
      return await findingsPage(route.name, ports, caller);
    }
    if (request.method === "GET" && route.rest === "doctor") {
      return await doctorPage(route.name, ports);
    }
    if (request.method === "GET" && route.rest === "evidence") {
      return await evidencePage(route.name, ports, caller, query);
    }
    if (request.method === "GET" && route.rest === "policy") {
      return await policyPage(route.name, ports, caller);
    }
    if (
      request.method === "POST" &&
      route.rest.startsWith("evidence/") &&
      EVIDENCE_ACTIONS.has(route.rest.slice("evidence/".length))
    ) {
      if (forgedWrite(caller, request)) return forgedWriteResponse();
      return await evidenceAction(
        route.name,
        ports,
        route.rest.slice("evidence/".length),
        formValues(request.body ?? ""),
      );
    }
    if (request.method === "POST" && route.rest === "findings/classify") {
      if (forgedWrite(caller, request)) return forgedWriteResponse();
      return await classifyAction(route.name, ports, request);
    }
    if (request.method === "POST" && route.rest === "policy/starter") {
      if (forgedWrite(caller, request)) return forgedWriteResponse();
      return await policyAction(route.name, ports, ["starter"]);
    }
    if (request.method === "POST" && route.rest === "policy/install") {
      if (forgedWrite(caller, request)) return forgedWriteResponse();
      return await policyAction(route.name, ports, ["install"]);
    }
    if (request.method === "POST" && route.rest === "policy/publish") {
      if (forgedWrite(caller, request)) return forgedWriteResponse();
      const values = formValues(request.body ?? "");
      return await policyAction(route.name, ports, [
        "publish",
        flagValue("--id", values.get("id")?.[0] ?? ""),
        flagValue("--policy", values.get("policy")?.[0] ?? ""),
      ]);
    }
  }

  if (request.method === "POST" && path === "/sites") {
    if (forgedWrite(caller, request)) return forgedWriteResponse();
    const values = formValues(request.body ?? "");
    const name = values.get("name")?.[0] ?? "";
    const domains = values.get("domain") ?? [];
    const lines: string[] = [];
    const result = await runSitesCommand(
      {
        fileSystem: ports.fileSystem,
        writeLine: (line) => lines.push(line),
      },
      [
        "add",
        flagValue("--name", name),
        ...domains.map((domain) => flagValue("--domain", domain)),
      ],
    );
    if (!result.ok) {
      return {
        body: refusedPage("Site not created", result.message ?? ""),
        headers: HTML,
        status: 400,
      };
    }
    return { body: "", headers: { location: "/" }, status: 303 };
  }

  return {
    body: nothingHerePage(),
    headers: HTML,
    status: 404,
  };
}

function forgedWriteResponse(): OperatorResponse {
  return {
    body: notFromThisFormPage(),
    headers: HTML,
    status: 403,
  };
}

/**
 * Shows one site's findings.
 *
 * The lines are the ones `opencookie findings list` writes, so the console
 * reports what the command reports rather than describing the inventory a
 * second time and drifting from it. A finding's name is whatever the site
 * loaded, so every line is escaped before it reaches the page.
 */
async function findingsPage(
  name: string,
  ports: OperatorServerPorts,
  caller: Caller,
): Promise<OperatorResponse> {
  const opened = await onSite(name, ports, (fileSystem, lines) =>
    runFindingsCommand({ fileSystem, writeLine: (line) => lines.push(line) }, [
      "list",
    ]),
  );
  if (isResponse(opened)) return opened;
  if (!opened.result.ok) {
    return {
      body: refusedPage("Findings unavailable", opened.result.message ?? ""),
      headers: HTML,
      status: 500,
    };
  }
  const inventory = await readFindingsInventory(opened.fileSystem);
  const undecided = (inventory?.findings ?? []).filter(
    (finding) => finding.classification !== "classified",
  );
  return {
    body: linesPage(
      `Findings for ${name}`,
      opened.lines,
      undefined,
      undecided
        .map((finding) =>
          classifyForm({
            cleanups: FINDING_CLEANUPS,
            formToken: callerFormToken(caller),
            kind: finding.kind,
            name: finding.name,
            site: name,
          }),
        )
        .join(""),
    ),
    headers: HTML,
    status: 200,
  };
}

/**
 * One request aimed at a named site.
 *
 * A path the browser sent is not guaranteed to decode, and a name that cannot
 * be read is no site, so it is treated as one that does not exist rather than
 * as the console breaking.
 */
interface SiteRoute {
  readonly name: string;
  readonly rest: string;
}

function siteRoute(path: string): SiteRoute | undefined {
  const match = /^\/sites\/([^/]+)\/(.+)$/u.exec(path);
  if (match === null) return undefined;
  try {
    return { name: decodeURIComponent(match[1] ?? ""), rest: match[2] ?? "" };
  } catch {
    return undefined;
  }
}

/** What every operator command reports back. */
interface CommandOutcome {
  readonly message?: string;
  readonly ok: boolean;
}

/** One site's command run, or the registry's own refusal to open it. */
type OnSite =
  | {
      readonly fileSystem: FileSystemPort;
      readonly lines: string[];
      readonly ok: true;
      readonly result: CommandOutcome;
    }
  | OperatorResponse;

/** Opens one site, or reports the registry's own refusal. */
async function onSite(
  name: string,
  ports: OperatorServerPorts,
  run: (fileSystem: FileSystemPort, lines: string[]) => Promise<CommandOutcome>,
): Promise<OnSite> {
  const selected = await selectSite(ports.fileSystem, [
    flagValue("--site", name),
  ]);
  if (!selected.ok) {
    return {
      body: refusedPage("No such site", selected.message),
      headers: HTML,
      status: 404,
    };
  }
  const lines: string[] = [];
  return {
    fileSystem: selected.fileSystem,
    lines,
    ok: true,
    result: await run(selected.fileSystem, lines),
  };
}

function isResponse(value: OnSite): value is OperatorResponse {
  return "status" in value;
}

/** Shows what `opencookie policy status` reports, and what can be done next. */
async function policyPage(
  name: string,
  ports: OperatorServerPorts,
  caller: Caller,
): Promise<OperatorResponse> {
  const opened = await onSite(name, ports, (fileSystem, lines) =>
    runPolicyCommand(
      { fileSystem, site: name, writeLine: (line) => lines.push(line) },
      ["status"],
    ),
  );
  if (isResponse(opened)) return opened;
  if (!opened.result.ok) {
    return {
      body: refusedPage("Policy unavailable", opened.result.message ?? ""),
      headers: HTML,
      status: 500,
    };
  }
  const starterWritten = await opened.fileSystem.exists(STARTER_POLICY_PATH);
  // Installing is only offered once there is a publication to install, so the
  // page never offers a button the policy domain would refuse.
  const published = opened.lines.some((line) =>
    line.startsWith("Current publication:"),
  );
  return {
    body: renderPolicyPage({
      formToken: callerFormToken(caller),
      lines: opened.lines,
      name,
      published,
      starterPath: STARTER_POLICY_PATH,
      starterWritten,
    }),
    headers: HTML,
    status: 200,
  };
}

/** Runs one policy subcommand on a site and reports what it said. */
async function policyAction(
  name: string,
  ports: OperatorServerPorts,
  args: readonly string[],
): Promise<OperatorResponse> {
  const opened = await onSite(name, ports, (fileSystem, lines) =>
    runPolicyCommand(
      { fileSystem, site: name, writeLine: (line) => lines.push(line) },
      args,
    ),
  );
  if (isResponse(opened)) return opened;
  if (!opened.result.ok) {
    return {
      body: refusedPage("Not done", opened.result.message ?? ""),
      headers: HTML,
      status: 400,
    };
  }
  return {
    body: "",
    headers: { location: `/sites/${encodeURIComponent(name)}/policy` },
    status: 303,
  };
}

/**
 * Shows the receipts a site holds.
 *
 * Consent evidence is a visitor's record rather than public information, so
 * this page sits behind the same credential as every other, and every line it
 * prints is escaped: a consent identifier is whatever was stored, not this
 * operator's text.
 */
async function evidencePage(
  name: string,
  ports: OperatorServerPorts,
  caller: Caller,
  query: URLSearchParams,
): Promise<OperatorResponse> {
  const filter = (field: string, flag: string): readonly string[] => {
    const value = query.get(field);
    return value === null || value === "" ? [] : [flagValue(flag, value)];
  };
  const args = [
    "query",
    ...filter("consentId", "--consent-id"),
    ...filter("since", "--since"),
    ...filter("until", "--until"),
  ];
  const opened = await onSite(name, ports, (fileSystem, lines) =>
    runEvidenceCommand(
      {
        fileSystem,
        now: ports.now,
        writeLine: (line) => lines.push(line),
      },
      args,
    ),
  );
  if (isResponse(opened)) return opened;
  if (!opened.result.ok) {
    return {
      body: refusedPage("Evidence unavailable", opened.result.message ?? ""),
      headers: HTML,
      status: 500,
    };
  }
  return {
    body: evidencePageBody({
      consentId: query.get("consentId") ?? "",
      formToken: callerFormToken(caller),
      lines: opened.lines,
      name,
      since: query.get("since") ?? "",
      until: query.get("until") ?? "",
    }),
    headers: HTML,
    status: 200,
  };
}

/**
 * Whether an export path lies inside the OpenCookie data directory, which the
 * site scope maps into that site's own directory. Receipts are personal data,
 * so the console never writes them to the web root or elsewhere.
 */
function isSiteDataPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments[0] === "opencookie" &&
    segments.length > 1 &&
    segments.every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\"),
    )
  );
}

/**
 * Runs one evidence action on a site.
 *
 * Each one is handed to the same command the terminal runs, so what counts as
 * a usable retention period, or an erasure that names nobody, is decided once.
 */
async function evidenceAction(
  name: string,
  ports: OperatorServerPorts,
  action: string,
  values: ReadonlyMap<string, readonly string[]>,
): Promise<OperatorResponse> {
  const field = (key: string, flag: string): readonly string[] => {
    const value = values.get(key)?.[0];
    return value === undefined || value === "" ? [] : [flagValue(flag, value)];
  };
  const out = values.get("out")?.[0];
  if (action === "export" && (out === undefined || !isSiteDataPath(out))) {
    return {
      body: refusedPage(
        "Not done",
        "An export is written inside this site's data. Give a path under opencookie/, such as opencookie/consent-evidence-export.json.",
      ),
      headers: HTML,
      status: 400,
    };
  }
  // An export writes the receipts the page was showing, so it carries the same
  // filter the list was under. Erasure and retention name their own subject.
  const filter =
    action === "export"
      ? [
          ...field("consentId", "--consent-id"),
          ...field("since", "--since"),
          ...field("until", "--until"),
        ]
      : [];
  const args = [
    action,
    ...(action === "delete" ? field("consentId", "--consent-id") : []),
    ...(action === "retain" ? field("days", "--days") : []),
    ...(action === "export" ? field("out", "--out") : []),
    ...filter,
  ];
  const opened = await onSite(name, ports, (fileSystem, lines) =>
    runEvidenceCommand(
      { fileSystem, now: ports.now, writeLine: (line) => lines.push(line) },
      args,
    ),
  );
  if (isResponse(opened)) return opened;
  if (!opened.result.ok) {
    return {
      body: refusedPage("Not done", opened.result.message ?? ""),
      headers: HTML,
      status: 400,
    };
  }
  // An erasure that left copies behind is shown, not passed over by a redirect.
  if (opened.lines.some((line) => line.startsWith(EXPORT_COPIES_NOTICE))) {
    return {
      body: linesPage("Erased from the store, but copies remain", opened.lines),
      headers: HTML,
      status: 200,
    };
  }
  // Back to the list the operator was looking at, not to an unfiltered one,
  // except that an erased visitor's id is not put into history or logs.
  const showing = new URLSearchParams();
  for (const key of action === "delete"
    ? ["since", "until"]
    : ["consentId", "since", "until"]) {
    const value = values.get(key)?.[0];
    if (value !== undefined && value !== "") showing.set(key, value);
  }
  const query = showing.toString();
  return {
    body: "",
    headers: {
      location: `/sites/${encodeURIComponent(name)}/evidence${query === "" ? "" : `?${query}`}`,
    },
    status: 303,
  };
}

/**
 * Records one decision about one finding.
 *
 * Every field the form collects is handed to the same command the terminal
 * runs, so what makes a decision complete is decided in one place.
 */
async function classifyAction(
  name: string,
  ports: OperatorServerPorts,
  request: OperatorRequest,
): Promise<OperatorResponse> {
  const values = formValues(request.body ?? "");
  const only = (field: string): readonly string[] => {
    const value = values.get(field)?.[0];
    return value === undefined ? [] : [`--${field}`, value];
  };
  const args = [
    "classify",
    ...only("name"),
    ...only("kind"),
    ...only("purpose"),
    ...only("vendor"),
    ...only("service"),
    ...only("category"),
    ...only("disclosure"),
    ...only("retention"),
    ...only("cleanup"),
    ...(values.has("necessary") ? ["--necessary"] : []),
  ];
  const opened = await onSite(name, ports, (fileSystem, lines) =>
    runFindingsCommand(
      { fileSystem, now: ports.now, writeLine: (line) => lines.push(line) },
      args,
    ),
  );
  if (isResponse(opened)) return opened;
  if (!opened.result.ok) {
    return {
      body: refusedPage("Not recorded", opened.result.message ?? ""),
      headers: HTML,
      status: 400,
    };
  }
  return {
    body: "",
    headers: { location: `/sites/${encodeURIComponent(name)}/findings` },
    status: 303,
  };
}

/**
 * Shows what `opencookie doctor` reports for one site.
 *
 * It only reads: the page reports what is wrong and leaves fixing it to the
 * command that owns each fix, so nothing here can change a site while an
 * operator is looking at it.
 */
async function doctorPage(
  name: string,
  ports: OperatorServerPorts,
): Promise<OperatorResponse> {
  const opened = await onSite(name, ports, async (fileSystem, lines) => ({
    ok: (
      await runDoctor({
        fileSystem,
        site: name,
        writeLine: (line) => lines.push(line),
      })
    ).ok,
  }));
  if (isResponse(opened)) return opened;
  return {
    body: linesPage(
      `What ${name} enforces`,
      opened.lines,
      opened.result.ok
        ? undefined
        : "A problem here means the site is not enforcing what it published. Each line names the command that fixes it.",
    ),
    headers: HTML,
    status: 200,
  };
}
