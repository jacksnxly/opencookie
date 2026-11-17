---
"@opencookie-dev/nuxt": patch
---

Depend on `@nuxt/kit` and `@nuxt/schema` 4.6.4, which fix GHSA-mjrq-cffv-q4qc.

Nuxt below 4.6.4 still installs the affected `@nuxt/schema` itself, so apps on an older Nuxt should update Nuxt to 4.6.4 as well.
