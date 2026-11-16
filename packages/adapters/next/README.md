# @opencookie-dev/next

The Next.js client boundary for OpenCookie. This package adds the `"use client"` entry point that Next.js requires for a hook-based library and re-exports the provider and hooks from `@opencookie-dev/react`. It creates no second context and contains no consent-domain behavior.

It supports Next.js 15 and 16, with both the App Router and the Pages Router. Every `pnpm verify` runs a fresh App Router app on Next.js 15.5.29 and both routers on 16.4.6.

## App Router

Keep the non-serializable external store inside a small Client Component. Do not construct it in module scope or pass it from a Server Component because its methods are functions and therefore are not serializable Client Component props.

```tsx
// app/opencookie-provider.tsx
"use client";

import type { OpenCookie } from "@opencookie-dev/core";
import { OpenCookieProvider } from "@opencookie-dev/next";
import { useEffect, useState, type ReactNode } from "react";

import { createOpenCookieStore } from "@/lib/opencookie";

export function OpenCookieClientProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [store] = useState<OpenCookie>(createOpenCookieStore);

  useEffect(() => {
    void store.initialize();
  }, [store]);

  return <OpenCookieProvider store={store}>{children}</OpenCookieProvider>;
}
```

The root layout stays a Server Component and can pass its rendered children through the client provider:

```tsx
// app/layout.tsx
import type { ReactNode } from "react";

import { OpenCookieClientProvider } from "./opencookie-provider";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OpenCookieClientProvider>{children}</OpenCookieClientProvider>
      </body>
    </html>
  );
}
```

Components that call OpenCookie hooks are Client Components:

```tsx
"use client";

import type { OpenCookieSnapshot } from "@opencookie-dev/core";
import { useOpenCookieSnapshot } from "@opencookie-dev/next";

export function ConsentStatus() {
  const snapshot = useOpenCookieSnapshot<OpenCookieSnapshot>();
  return <output>{snapshot.readiness}</output>;
}
```

## Pages Router

Install the provider once in the custom App so the same mounted store survives client-side page transitions:

```tsx
// pages/_app.tsx
import type { OpenCookie } from "@opencookie-dev/core";
import { OpenCookieProvider } from "@opencookie-dev/next";
import type { AppProps } from "next/app";
import { useEffect, useState } from "react";

import { createOpenCookieStore } from "@/lib/opencookie";

export default function App({ Component, pageProps }: AppProps) {
  const [store] = useState<OpenCookie>(createOpenCookieStore);

  useEffect(() => {
    void store.initialize();
  }, [store]);

  return (
    <OpenCookieProvider store={store}>
      <Component {...pageProps} />
    </OpenCookieProvider>
  );
}
```

## SSR and hydration rules

`createOpenCookieStore` must be safe to call during rendering. Keep construction free of `window`, `document`, `localStorage`, cookies, current-time reads, random identifiers, and other browser-only or nondeterministic work. Load persisted consent after mount through `initialize()`.

The server and the browser's first render must expose equivalent `getServerSnapshot()` values. `@opencookie-dev/react` uses React's `useSyncExternalStore` with `getServerSnapshot`, so SSR does not subscribe or read the client snapshot. Browser state is read after hydration through the normal external-store subscription.

Do not silence hydration warnings or disable SSR for the banner. Fix a differing initial snapshot at its source.

## Official Next.js references

Accessed 2026-08-22:

- [App Router: Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [`use client` directive](https://nextjs.org/docs/app/api-reference/directives/use-client)
- [Hydration mismatch guidance](https://nextjs.org/docs/messages/react-hydration-error)
- [Pages Router overview](https://nextjs.org/docs/pages)
- [Pages Router custom App](https://nextjs.org/docs/pages/building-your-application/routing/custom-app)
- [Pages Router server-side rendering](https://nextjs.org/docs/pages/building-your-application/rendering/server-side-rendering)

OpenCookie is a technical tool, not legal advice.
