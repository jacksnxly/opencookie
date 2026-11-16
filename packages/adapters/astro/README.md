# `@opencookie-dev/astro`

Thin Astro integration for OpenCookie. It delegates consent behavior to
`@opencookie-dev/core` and delegates browser UI to your chosen OpenCookie adapter.
It does not duplicate policy or decision logic.

## Install and configure

Add the integration to `astro.config.mjs` and point it at a browser module owned
by your application:

```js
import { defineConfig } from "astro/config";
import openCookie from "@opencookie-dev/astro";

export default defineConfig({
  integrations: [
    openCookie({
      entrypoint: "/src/opencookie.client.ts",
    }),
  ],
});
```

The default `page` stage asks Astro to bundle the module and load it on every
page, including pages with no hydrated island. A typical entrypoint imports the
application's client and the vanilla adapter:

```ts
import { mountOpenCookie } from "@opencookie-dev/vanilla";

import { client } from "./opencookie.config.js";

mountOpenCookie({ client });
```

Importing `@opencookie-dev/astro` does not access `window` or `document`. The
integration emits an import for Astro and Vite to resolve. It does not evaluate
the browser entrypoint during a static build or an on-demand server render.

## Framework islands

Use the matching OpenCookie framework package inside your React, Vue, or Svelte
component. Then import that component directly into an `.astro` file and use
Astro's `client:load` directive when immediate interaction is required:

```astro
---
import ConsentControls from "../components/ConsentControls.jsx";
---

<ConsentControls client:load />
```

If the OpenCookie entrypoint must run before framework hydration, configure
`stage: "before-hydration"`. Keep the default `page` stage when pages without a
hydrated island must still run the entrypoint.

## Server render with no hydrated component

`createAstroServerBinding()` reads only the external store's stable server
snapshot. It does not subscribe and does not access browser globals:

```astro
---
import { createAstroServerBinding } from "@opencookie-dev/astro";
import { consentStore } from "../lib/opencookie.server.js";

const { snapshot } = createAstroServerBinding(consentStore);
---

<p data-consent-prompt={snapshot.runtime.consentEvaluation.prompt}>
  Consent preference status
</p>
```

Create request-specific mutable state when rendering on demand. Do not share a
mutable consent client between visitors. Static Astro output receives the same
deterministic server snapshot for every visitor, then the browser entrypoint
loads the visitor's persisted decision.

OpenCookie is a technical tool, not legal advice. Your policy, configuration,
and deployment remain your responsibility.

## Astro references

All references were accessed on 2026-08-22.

- [Working with integrations](https://docs.astro.build/en/guides/integrations/)
- [Astro Integration API and `injectScript`](https://docs.astro.build/en/reference/integrations-reference/)
- [Scripts and event handling](https://docs.astro.build/en/guides/client-side-scripts/)
- [Template directives, including `client:load`](https://docs.astro.build/en/reference/directives-reference/)
- [On-demand rendering and SSR](https://docs.astro.build/en/guides/on-demand-rendering/)

The package is tested against Astro 7.2.4, the stable registry release observed
on 2026-08-22.
