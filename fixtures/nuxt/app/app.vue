<script setup lang="ts">
import type { OpenCookieSnapshot } from "@opencookie-dev/core";
import { useOpenCookieSnapshot } from "@opencookie-dev/nuxt/runtime";

type FixtureSnapshot = Pick<OpenCookieSnapshot, "readiness"> &
  Partial<Pick<OpenCookieSnapshot, "runtime">>;

// Browsers hide a script's nonce once a CSP applies, so Nuxt 4's head manager
// cannot match these server-rendered tags on hydration and would insert each
// a second time. They are rendered on the server only.
if (import.meta.server) {
  useHead({
    script: [
      { defer: true, nonce: "fixture-nonce", src: "/essential.js" },
      {
        "data-oc-category": "analytics",
        "data-oc-resource": "analytics-script",
        "data-src":
          "http://tracker.nuxt.opencookie.test:4400/analytics.js?resource=initial",
        nonce: "fixture-nonce",
        type: "text/plain",
      },
    ],
  });
}

const route = useRoute();
const snapshot = useOpenCookieSnapshot<FixtureSnapshot>();
const routeSequence = computed(() => {
  const match = /^\/spa\/(\d+)$/u.exec(route.path);
  return match === null ? 0 : Number.parseInt(match[1] ?? "0", 10);
});
const nextRoute = computed(() => `/spa/${String(routeSequence.value + 1)}`);

function appendAnalyticsResource(): void {
  const nextSequence = routeSequence.value + 1;
  const script = document.createElement("script");
  script.type = "text/plain";
  script.dataset.ocResource = "analytics-script";
  script.dataset.ocCategory = "analytics";
  script.dataset.src = `http://tracker.nuxt.opencookie.test:4400/analytics.js?resource=dynamic-${String(nextSequence)}`;
  document.head.append(script);
}
</script>

<template>
  <div data-fixture-root="nuxt" data-ssr-fixture="nuxt">
    <header class="site-header">
      <NuxtLink class="brand" to="/">OpenCookie Nuxt fixture</NuxtLink>
      <NuxtLink
        id="route-control"
        data-testid="route-control"
        :to="nextRoute"
        @click="appendAnalyticsResource"
      >
        Open dynamic route
      </NuxtLink>
    </header>
    <main id="content-sentinel" data-testid="content-sentinel">
      <p class="eyebrow">Nuxt SSR production fixture</p>
      <h1>Consent behavior should survive real application navigation.</h1>
      <p>
        This fixture exercises the request-local Nuxt binding on a current
        Nuxt 4 production build.
      </p>
      <dl class="status-grid">
        <div>
          <dt>Route</dt>
          <dd>
            <output id="fixture-status" data-testid="fixture-status">
              {{
                routeSequence === 0
                  ? "Initial route"
                  : `Dynamic route ${String(routeSequence)}`
              }}
            </output>
          </dd>
        </div>
        <div>
          <dt>Consent</dt>
          <dd data-testid="consent-status">
            {{ snapshot.runtime?.consentEvaluation.status ?? "pending" }}
          </dd>
        </div>
      </dl>
      <template
        data-oc-iframe
        title="Optional product video"
        data-oc-resource="product-video"
        data-oc-category="analytics"
        data-src="http://tracker.nuxt.opencookie.test:4400/frame"
      />
      <NuxtPage />
    </main>
  </div>
</template>
