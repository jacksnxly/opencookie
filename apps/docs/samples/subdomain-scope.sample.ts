// docs:consumer-path: src/subdomain-scope.ts
// docs:display:start
import { CONSENT_RECORD_SCHEMA_VERSION } from "@opencookie-dev/core";
import {
  createCookieDecisionStore,
  type CookieJarLike,
} from "@opencookie-dev/core/infrastructure";

export function sharedConsentStore(hostname: string, jar: CookieJarLike) {
  return createCookieDecisionStore({
    hostname,
    jar,
    key: "oc_consent",
    schemaVersion: CONSENT_RECORD_SCHEMA_VERSION,
    scope: {
      domain: "example.com",
      kind: "shared",
      registrableDomainResolver: { resolve: () => "example.com" },
    },
    secure: true,
  });
}
// docs:display:end

export async function run(): Promise<void> {
  let cookie = "";
  const store = sharedConsentStore("shop.example.com", {
    read: () => cookie,
    write: (value) => {
      cookie = value;
    },
  });
  if ((await store.read()).status !== "missing") {
    throw new Error("A fresh shared cookie store should be empty.");
  }
}
