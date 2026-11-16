<script setup lang="ts">
import { useOpenCookieSnapshot } from "@opencookie-dev/nuxt/runtime";

const snapshot = useOpenCookieSnapshot<{
  readonly readiness: "uninitialized";
}>();
const injectedStore = useNuxtApp().$openCookie;
const injectedSnapshot = injectedStore.getServerSnapshot() as {
  readonly readiness: "uninitialized";
};

// @ts-expect-error The generated injection is a store, not an untyped value.
const invalidInjection: string = injectedStore;
void invalidInjection;
</script>

<template>
  <main>
    <output data-oc-readiness>{{ snapshot.readiness }}</output>
    <output data-oc-injected>{{ injectedSnapshot.readiness }}</output>
  </main>
</template>
