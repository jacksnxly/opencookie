import type { VanillaOpenCookieCopy } from "./mount.js";

/**
 * German visitor copy for the banner and preferences surface.
 *
 * Written for this project rather than adapted from another consent product.
 * It uses the formal "Sie", which German-language sites conventionally use with
 * visitors they do not know, and keeps "Alle akzeptieren" and "Alle ablehnen"
 * equally short and equally direct so neither choice is the easier one to read.
 *
 * Pass it as `copy` to `mountOpenCookie` or the programmatic bootstrap. The
 * drop-in script uses it when its tag carries `data-oc-locale="de"`.
 *
 * @public
 */
export const VANILLA_COPY_DE: VanillaOpenCookieCopy = Object.freeze({
  acceptAll: "Alle akzeptieren",
  close: "Einstellungen schließen",
  description:
    "Wählen Sie, welche optionalen Zwecke Sie zulassen. Sie können Ihre Entscheidung jederzeit ändern.",
  dismiss: "Schließen",
  eyebrow: "Datenschutzeinstellungen",
  lang: "de",
  manage: "Einstellungen",
  notControlled: "Nicht über diese Auswahl gesteuert",
  open: "Datenschutzoptionen",
  persistenceFailure:
    "Ihre Auswahl konnte nicht gespeichert werden. Es wurden keine weiteren optionalen Dienste aktiviert; zuvor gespeicherte Einstellungen gelten weiterhin.",
  rejectAll: "Alle ablehnen",
  requires: "Erfordert",
  restricted: "Durch das Datenschutzsignal Ihres Browsers blockiert.",
  retryPersistence: "Erneut speichern",
  save: "Auswahl speichern",
  title: "Ihre Wahl, klar und deutlich.",
  withdrawConsent: "Einwilligung widerrufen",
});
