# @opencookie-dev/nuxt

The Nuxt module for OpenCookie's headless external store. It registers one
universal Nuxt plugin, installs the existing `@opencookie-dev/vue` binding, and
constructs the application-owned store once per Nuxt application. Consent and
policy behavior remain in `@opencookie-dev/core`.

It supports Nuxt 4, from `4.5.2`. A packed Nuxt 4.5.2 application builds and
renders with it, and the browser test fixture runs Nuxt 4.5.2. Nuxt 3 reached
end of life on 2026-07-31 and no longer receives upstream security updates, so
it is no longer supported; `0.1.0` is the last release for Nuxt 3.

## Configure the module

Register the module and point it at a module owned by your application:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: [
    [
      "@opencookie-dev/nuxt",
      {
        storeModule: "~/opencookie-store",
      },
    ],
  ],
});
```

The configured module must default-export a factory. Construct a new store for
each Nuxt application. Do not export a mutable module-level singleton because
server requests can share module state:

```ts
// opencookie-store.ts
import type { OpenCookie } from "@opencookie-dev/core";

import { createOpenCookieStore } from "~/opencookie.config";

export default function createStore(): OpenCookie {
  return createOpenCookieStore();
}
```

Store construction must be server-safe and deterministic. It must not read
`window`, `document`, cookies, local storage, the current time, or random IDs.
The runtime plugin calls an available `initialize()` method from Nuxt's
`app:mounted` hook, after hydration. Browser persistence and DOM access belong
inside that initialization path.

## Read state in Vue components

The runtime entry re-exports the same Vue composables, so no second injection
context or subscription is created:

```vue
<script setup lang="ts">
import type { OpenCookieSnapshot } from "@opencookie-dev/core";
import { useOpenCookieSnapshot } from "@opencookie-dev/nuxt/runtime";

const snapshot = useOpenCookieSnapshot<OpenCookieSnapshot>();
</script>

<template>
  <output>{{ snapshot.readiness }}</output>
</template>
```

The module also declares the app-level `$openCookie` injection for
`useNuxtApp()` and Vue component instances. Its snapshot type is `unknown`
because the application owns the store factory; prefer the generic composables
when a component needs the concrete application snapshot type.

`<ClientOnly>` is not required for a server-safe OpenCookie consumer. The
universal plugin installs the provider during both server rendering and client
hydration. `getServerSnapshot()` must return deterministic initial state, and
the browser's first render must agree with that state. Fix differing snapshots
at their source instead of suppressing hydration warnings or moving the whole
banner to a client-only plugin.

## Runtime configuration

Nuxt runtime configuration is serialized. Keep functions, stores, `Map`, and
`Set` values out of `runtimeConfig`; the `storeModule` path is a serializable
module option and the factory itself remains code. An application-owned factory
may call `useRuntimeConfig()` to read JSON-safe public settings. Only values
under `runtimeConfig.public` are exposed to the browser, so never place secrets
there.

## Official Nuxt references

Accessed 2026-08-22:

- [Module anatomy and `defineNuxtModule`](https://nuxt.com/docs/3.x/guide/modules/module-anatomy)
- [Adding module runtime plugins](https://nuxt.com/docs/3.x/guide/modules/recipes-basics)
- [Nuxt Kit plugin registration](https://nuxt.com/docs/3.x/api/kit/plugins)
- [Nuxt Kit type-template registration](https://nuxt.com/docs/3.x/api/kit/templates)
- [Testing Nuxt modules as packed external consumers](https://nuxt.com/docs/3.x/guide/modules/testing)
- [pnpm workspace settings used by the isolated packed fixture](https://pnpm.io/settings#overrides)
- [Universal, client, and server plugins](https://nuxt.com/docs/3.x/directory-structure/plugins)
- [Runtime config serialization and visibility](https://nuxt.com/docs/3.x/guide/going-further/runtime-config)
- [Nuxt application lifecycle and `app:mounted`](https://nuxt.com/docs/3.x/guide/concepts/nuxt-lifecycle)
- [Universal rendering and hydration](https://nuxt.com/docs/3.x/guide/concepts/rendering)
- [Nuxt application context and provided helpers](https://nuxt.com/docs/3.x/guide/going-further/nuxt-app)

OpenCookie is a technical tool, not legal advice.
