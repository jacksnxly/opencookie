/** One store an optional resource declares it writes. */
export interface DeclaredStore {
  readonly kind: "cookie" | "local" | "session";
  readonly name: string;
  /** A trailing `*` in the declaration: every name that starts with `name`. */
  readonly prefix: boolean;
  /**
   * The purpose whose tags write it, for a resource that serves several:
   * turning that purpose off deletes it while the resource stays allowed.
   */
  readonly purposeId?: string;
}

const STORE_TOKEN = /^(?:([^=\s]+)=)?(cookie|local|session):([^*\s]+)(\*?)$/u;

/**
 * Reads a `data-oc-stores` declaration: whitespace-separated `kind:name`
 * tokens, where a trailing `*` matches every name with that prefix and a
 * leading `purpose=` scopes the token to one purpose.
 */
export function parseDeclaredStores(value: string): readonly DeclaredStore[] {
  return value
    .split(/\s+/u)
    .filter((token) => token !== "")
    .map((token) => {
      const match = STORE_TOKEN.exec(token);
      if (match === null) {
        throw new TypeError(
          `data-oc-stores cannot declare "${token}": use cookie:, local: or session: and a name, which may end in *, optionally after a purpose and =.`,
        );
      }
      return {
        kind: match[2] as DeclaredStore["kind"],
        name: match[3] as string,
        prefix: match[4] === "*",
        ...(match[1] === undefined ? {} : { purposeId: match[1] }),
      };
    });
}

const matches = (store: DeclaredStore, name: string): boolean =>
  store.prefix ? name.startsWith(store.name) : name === store.name;

const cookieNames = (document: Document): readonly string[] =>
  document.cookie
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim() ?? "")
    .filter((name) => name !== "");

// A cookie is deleted by rewriting its exact identity, name, domain and
// path, with Max-Age=0. Script cannot read a cookie's domain or path, so every
// identity that is visible from this URL is rewritten: host-only and each
// parent domain, crossed with every path prefix of the current path. A
// browser refuses a top-level label and the parts of an IP address as a
// domain (RFC 6265 5.1.3 and 5.3), so those are never written.
function deleteCookie(document: Document, name: string): void {
  const { hostname, pathname, protocol } = document.location;
  const secure = protocol === "https:" ? "; Secure" : "";
  if (name.startsWith("__Host-")) {
    document.cookie = `${name}=; Max-Age=0; Path=/${secure}`;
    return;
  }
  const labels = hostname.split(".");
  // A URL's IPv4 host is always dotted decimal digits.
  const accepted = /^[\d.]+$/u.test(hostname) ? 1 : labels.length - 1 || 1;
  const domains = [
    "",
    ...labels
      .slice(0, accepted)
      .map((_, index) => `; Domain=${labels.slice(index).join(".")}`),
  ];
  const paths = ["/"];
  let path = "";
  for (const segment of pathname.split("/").filter((part) => part !== "")) {
    path += `/${segment}`;
    paths.push(path, `${path}/`);
  }
  for (const domain of domains) {
    for (const cookiePath of paths) {
      document.cookie = `${name}=; Max-Age=0; Path=${cookiePath}${domain}${secure}`;
    }
  }
}

function deleteStorage(
  read: () => Storage | undefined,
  stores: readonly DeclaredStore[],
): void {
  // An undeclared kind is never opened: the decision store resolves its own
  // Web Storage handle once, and this must not add reads to it.
  if (stores.length === 0) return;
  let storage: Storage | undefined;
  try {
    storage = read();
  } catch {
    // Storage the page cannot open holds nothing it could have written.
    return;
  }
  if (storage === undefined) return;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && stores.some((store) => matches(store, key))) {
      keys.push(key);
    }
  }
  for (const key of keys) storage.removeItem(key);
}

/**
 * Deletes the storage that `elements` of one resource declare with
 * `data-oc-stores`, or with `purposeIds`, only what is scoped to one of those
 * purposes. It deletes only what script can reach: not HttpOnly or
 * third-party cookies, and not data already sent. A declared cookie still
 * visible afterwards is reported by throwing.
 */
export function deleteDeclaredStorage(
  document: Document,
  elements: readonly HTMLElement[],
  resourceId: string,
  purposeIds?: readonly string[],
): void {
  const stores = elements
    .flatMap((element) =>
      parseDeclaredStores(element.dataset["ocStores"] ?? ""),
    )
    .filter(
      ({ purposeId }) =>
        purposeIds === undefined ||
        (purposeId !== undefined && purposeIds.includes(purposeId)),
    );
  const ofKind = (kind: DeclaredStore["kind"]) =>
    stores.filter((store) => store.kind === kind);
  const cookies = ofKind("cookie");
  const declaredCookies = (): readonly string[] =>
    cookies.length === 0
      ? []
      : cookieNames(document).filter((name) =>
          cookies.some((store) => matches(store, name)),
        );
  for (const name of declaredCookies()) deleteCookie(document, name);
  const view = document.defaultView;
  deleteStorage(() => view?.localStorage, ofKind("local"));
  deleteStorage(() => view?.sessionStorage, ofKind("session"));
  const remaining = declaredCookies();
  if (remaining.length > 0) {
    throw new Error(
      `Declared cookies for ${resourceId} could not be deleted: ${remaining.join(", ")}.`,
    );
  }
}
