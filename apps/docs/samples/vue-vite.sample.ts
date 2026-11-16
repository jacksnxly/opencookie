// docs:consumer-path: src/opencookie.ts
// docs:display:start
import { createOpenCookiePlugin } from "@opencookie-dev/vue";
import { createApp } from "vue";

import { createOpenCookieStore } from "../opencookie.config.js";

const openCookieStore = createOpenCookieStore();

export function installOpenCookie(app: ReturnType<typeof createApp>) {
  app.use(createOpenCookiePlugin(openCookieStore));
}
// docs:display:end

export function run(): void {
  const app = createApp({ template: "<main />" });
  installOpenCookie(app);
}
