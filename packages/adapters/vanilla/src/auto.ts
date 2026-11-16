import { startAutoBootstrapInTurns } from "./auto-bootstrap.js";

// The drop-in IIFE is side-effect-only. The global exists so integrators and
// integrity probes can confirm the script loaded, but it exposes no
// programmatic surface: use the @opencookie-dev/vanilla ESM or CommonJS entry
// for the programmatic bootstrap.
(globalThis as { OpenCookie?: object }).OpenCookie = Object.freeze({});

const resolvedDocument =
  typeof globalThis.document === "undefined" ? undefined : globalThis.document;
const resolvedScript = resolvedDocument?.currentScript;

if (
  resolvedDocument !== undefined &&
  resolvedScript !== null &&
  resolvedScript !== undefined &&
  "dataset" in resolvedScript
) {
  const failed = (error: unknown): void => {
    console.error("OpenCookie auto-bootstrap failed.", error);
  };
  // Started from <head>, it still sends the Consent Mode default now and
  // mounts once the body exists.
  try {
    void startAutoBootstrapInTurns(
      resolvedDocument,
      resolvedScript as HTMLScriptElement,
    )
      .then((mounted) => mounted.ready)
      .catch(failed);
  } catch (error) {
    failed(error);
  }
}
