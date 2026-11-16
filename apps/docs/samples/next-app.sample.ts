// docs:consumer-path: app/opencookie-provider.tsx
// docs:display:start
"use client";

import { OpenCookieProvider } from "@opencookie-dev/next";
import { mountOpenCookie } from "@opencookie-dev/vanilla";
import { useEffect, useState, type ReactNode } from "react";

import { createOpenCookieStore } from "../opencookie.config";

export function OpenCookieRoot({ children }: { children: ReactNode }) {
  const [store] = useState(createOpenCookieStore);
  useEffect(() => {
    const banner = mountOpenCookie({ client: store });
    return banner.destroy;
  }, [store]);
  return OpenCookieProvider({ children, store });
}
// docs:display:end

export function run(): void {
  if (typeof OpenCookieRoot !== "function") {
    throw new Error("The App Router boundary was not created.");
  }
}
