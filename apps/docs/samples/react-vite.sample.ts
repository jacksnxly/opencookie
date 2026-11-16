// docs:consumer-path: src/opencookie.tsx
// docs:display:start
import { OpenCookieProvider } from "@opencookie-dev/react";
import { mountOpenCookie } from "@opencookie-dev/vanilla";
import { useEffect, useState, type ReactNode } from "react";

import { createOpenCookieStore } from "../opencookie.config.js";

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
    throw new Error("The React root boundary was not created.");
  }
}
