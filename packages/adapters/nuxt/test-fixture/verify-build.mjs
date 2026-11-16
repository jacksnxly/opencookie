import { readFile } from "node:fs/promises";

const [html, generatedTypes, nuxtTypes] = await Promise.all([
  readFile(new URL("./.output/public/index.html", import.meta.url), "utf8"),
  readFile(new URL("./.nuxt/types/opencookie.d.ts", import.meta.url), "utf8"),
  readFile(new URL("./.nuxt/nuxt.d.ts", import.meta.url), "utf8"),
]);

if (!/<output[^>]*data-oc-readiness[^>]*>uninitialized<\/output>/.test(html)) {
  throw new Error(
    "Generated Nuxt HTML does not contain the deterministic OpenCookie server snapshot.",
  );
}

if (!/<output[^>]*data-oc-injected[^>]*>uninitialized<\/output>/.test(html)) {
  throw new Error(
    "Generated Nuxt HTML does not contain the app-injected OpenCookie snapshot.",
  );
}

if (
  !generatedTypes.includes(
    "readonly $openCookie: InitializableOpenCookieExternalStore<unknown>;",
  ) ||
  !nuxtTypes.includes('reference path="types/opencookie.d.ts"')
) {
  throw new Error(
    "Generated Nuxt types do not expose the OpenCookie app injection.",
  );
}

console.log(
  "Nuxt fixture verification passed: universal SSR snapshot and typed app injection are present.",
);
