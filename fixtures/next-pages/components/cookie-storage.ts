import type { StorageLike } from "@opencookie-dev/core";

const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
const DNS_NAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function cookieValue(key: string): string | null {
  const prefix = `${encodeURIComponent(key)}=`;
  const serialized = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return serialized === undefined
    ? null
    : decodeURIComponent(serialized.slice(prefix.length));
}

export function createFixtureCookieStorage(domain: string): StorageLike {
  const canonicalDomain = domain.toLowerCase();
  const hostname = document.location.hostname.toLowerCase();
  if (
    domain !== canonicalDomain ||
    !DNS_NAME.test(canonicalDomain) ||
    (hostname !== canonicalDomain && !hostname.endsWith(`.${canonicalDomain}`))
  ) {
    throw new TypeError(
      `Fixture cookie domain ${domain} is not a safe parent of ${hostname}.`,
    );
  }

  const secure = document.location.protocol === "https:" ? "; Secure" : "";
  const scope = `Domain=${canonicalDomain}; Path=/; SameSite=Lax${secure}`;
  return Object.freeze({
    getItem: cookieValue,
    removeItem(key: string): void {
      document.cookie = `${encodeURIComponent(key)}=; ${scope}; Max-Age=0`;
    },
    setItem(key: string, value: string): void {
      document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; ${scope}; Max-Age=${String(CONSENT_MAX_AGE_SECONDS)}`;
    },
  });
}
