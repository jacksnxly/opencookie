import type { StorageLike } from "@opencookie-dev/core";

const CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

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
  const hostname = document.location.hostname.toLowerCase();
  if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
    throw new TypeError(
      `Fixture cookie domain ${domain} does not contain ${hostname}.`,
    );
  }
  const scope = `Domain=${domain}; Path=/; SameSite=Lax`;
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
