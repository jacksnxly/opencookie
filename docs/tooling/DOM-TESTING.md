# DOM unit-test environment

OpenCookie uses Happy DOM `20.11.6` only as a root development dependency for fast, deterministic DOM unit tests. Tests construct an isolated `Window` directly and inject its `Document` into the vanilla adapter. Product bundles do not depend on Happy DOM, and tests do not load untrusted remote pages or use its fetch implementation.

The Playwright suite in `tests/e2e` covers behavior in real Chromium, Firefox, and WebKit. A simulated DOM cannot prove cookie-jar behavior, layout shift, CSP enforcement, focus rendering, accessibility-tree output, or browser-specific lifecycle behavior.

Sources accessed 2026-08-22:

- [Happy DOM package and current release](https://www.npmjs.com/package/happy-dom)
- [Official Window-class getting started guide](https://github.com/capricorn86/happy-dom/wiki/Getting-started)
- [Official test-environment guidance](https://github.com/capricorn86/happy-dom/wiki/Setup-as-Test-Environment)
