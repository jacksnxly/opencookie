# @opencookie-dev/vue

The Vue 3 binding for OpenCookie's headless external store. Consent behavior remains in `@opencookie-dev/core`; this package only supplies a plugin and composables.

## Install

```sh
pnpm add @opencookie-dev/core @opencookie-dev/vue
```

```ts
import { createApp } from "vue";
import { createOpenCookiePlugin } from "@opencookie-dev/vue";

createApp(App).use(createOpenCookiePlugin(store)).mount("#app");
```

Read the current snapshot in a component:

```ts
import type { OpenCookieSnapshot } from "@opencookie-dev/core";
import { useOpenCookieSnapshot } from "@opencookie-dev/vue";

const snapshot = useOpenCookieSnapshot<OpenCookieSnapshot>();
```

During server rendering, the composable reads `getServerSnapshot()` and does not subscribe. In the browser it subscribes for the current Vue scope and disposes automatically.

For Nuxt, use `@opencookie-dev/nuxt`.

OpenCookie is a technical tool, not legal advice.
