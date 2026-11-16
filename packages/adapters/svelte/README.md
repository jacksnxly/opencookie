# @opencookie-dev/svelte

The Svelte 5 binding for OpenCookie's headless external store. Domain behavior remains in `@opencookie-dev/core`; this package only provides an SSR-safe context and a readonly Svelte store.

Requires Svelte 5.40 or newer because it uses Svelte's type-safe `createContext` API.

## Provider

Call `setOpenCookieContext` during component initialization. Keep the external store identity stable for the lifetime of the provider.

```svelte
<script lang="ts">
  import type { OpenCookieExternalStore } from '@opencookie-dev/core';
  import { setOpenCookieContext } from '@opencookie-dev/svelte';
  import type { Snippet } from 'svelte';

  interface ConsentSnapshot {
    status: 'pending' | 'accepted' | 'rejected';
  }

  interface Props {
    children: Snippet;
    store: OpenCookieExternalStore<ConsentSnapshot>;
  }

  let { children, store }: Props = $props();
  setOpenCookieContext(store);
</script>

{@render children()}
```

## Consumer

Read the closest binding during component initialization. Svelte's `$` store syntax handles subscription and component-level cleanup.

```svelte
<script lang="ts">
  import { getOpenCookieContext } from '@opencookie-dev/svelte';

  interface ConsentSnapshot {
    status: 'pending' | 'accepted' | 'rejected';
  }

  const { snapshot } = getOpenCookieContext<ConsentSnapshot>();
</script>

<p>Consent state: {$snapshot.status}</p>
```

During server rendering, `snapshot` contains `getServerSnapshot()` and no client subscription is created. After the provider mounts, the adapter subscribes before reading `getSnapshot()` so an update cannot be lost between those operations. Unmounting the provider disposes that subscription exactly once.

Context is scoped to the rendered component tree, so server requests do not share adapter state through a module-level singleton. Calling `getOpenCookieContext` without a provider throws a descriptive error.

OpenCookie is a technical tool, not legal advice.
