# @opencookie-dev/react

The React binding for OpenCookie's headless external store. Consent behavior remains in `@opencookie-dev/core`; this package only supplies a provider and hooks.

## Install

```sh
pnpm add @opencookie-dev/core @opencookie-dev/react
```

```tsx
import type { OpenCookieSnapshot } from "@opencookie-dev/core";
import {
  OpenCookieProvider,
  useOpenCookieSnapshot,
} from "@opencookie-dev/react";

export function ConsentStatus() {
  const snapshot = useOpenCookieSnapshot<OpenCookieSnapshot>();
  return <output>{snapshot.readiness}</output>;
}

export function ConsentRoot({ children }) {
  return <OpenCookieProvider store={store}>{children}</OpenCookieProvider>;
}
```

The hooks use React's `useSyncExternalStore` and the core store's deterministic server snapshot. Construct the store without browser access, then call `initialize()` after mount.

For Next.js, use `@opencookie-dev/next`, which adds the required client boundary.

OpenCookie is a technical tool, not legal advice.
