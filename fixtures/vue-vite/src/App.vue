<script setup lang="ts">
import { ref } from "vue";
import { useOpenCookieSnapshot } from "@opencookie-dev/vue";
import type { OpenCookieSnapshot } from "@opencookie-dev/core";

const snapshot = useOpenCookieSnapshot<OpenCookieSnapshot>();
const routeSequence = ref(0);

function appendAnalyticsResource(sequence: number): void {
  const script = document.createElement("script");
  script.type = "text/plain";
  script.dataset["ocResource"] = "analytics-script";
  script.dataset["ocCategory"] = "analytics";
  script.dataset["src"] =
    `http://tracker.vue-vite.opencookie.test:4400/analytics.js?resource=dynamic-${String(sequence)}`;
  document.head.append(script);
}

function openDynamicRoute(): void {
  routeSequence.value += 1;
  history.pushState(
    { fixture: "vue-vite" },
    "",
    `/spa/${String(routeSequence.value)}`,
  );
  appendAnalyticsResource(routeSequence.value);
}
</script>

<template>
  <header class="site-header">
    <a class="brand" href="/">OpenCookie Vue fixture</a>
    <button
      id="route-control"
      data-testid="route-control"
      type="button"
      @click="openDynamicRoute"
    >
      Open dynamic route
    </button>
  </header>
  <main id="content-sentinel" data-testid="content-sentinel">
    <p class="eyebrow">Vue 3 and Vite 8 production fixture</p>
    <h1>Consent behavior should survive real application navigation.</h1>
    <p>
      This page uses the workspace Vue plugin and the same vanilla interface
      that consumers install.
    </p>
    <dl class="status-grid">
      <div>
        <dt>Route</dt>
        <dd>
          <output
            id="fixture-status"
            data-testid="fixture-status"
            aria-live="polite"
          >
            {{
              routeSequence === 0
                ? "Initial route"
                : `Dynamic route ${routeSequence}`
            }}
          </output>
        </dd>
      </div>
      <div>
        <dt>Consent</dt>
        <dd data-testid="consent-status">
          {{ snapshot.runtime.consentEvaluation.status }}
        </dd>
      </div>
    </dl>
  </main>
</template>
