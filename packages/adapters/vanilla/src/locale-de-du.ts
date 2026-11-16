import type { VanillaOpenCookieCopy } from "./mount.js";

/**
 * Informal German visitor copy for the banner and preferences surface.
 *
 * Written for this project. It addresses the visitor as "du" only in the
 * description, the failure notice, the restriction note, and the title.
 * Every control that addresses nobody is identical to {@link VANILLA_COPY_DE}.
 *
 * Pass it as `copy` to `mountOpenCookie` or the programmatic bootstrap.
 *
 * @public
 */
export const VANILLA_COPY_DE_DU: VanillaOpenCookieCopy = Object.freeze({
  acceptAll: "Alle akzeptieren",
  close: "Einstellungen schließen",
  description:
    "Wähl aus, welche optionalen Zwecke du zulässt. Du kannst deine Entscheidung jederzeit ändern.",
  dismiss: "Schließen",
  eyebrow: "Datenschutzeinstellungen",
  lang: "de",
  manage: "Einstellungen",
  notControlled: "Nicht über diese Auswahl gesteuert",
  open: "Datenschutzoptionen",
  persistenceFailure:
    "Deine Auswahl konnte nicht gespeichert werden. Es wurden keine weiteren optionalen Dienste aktiviert; was du vorher gespeichert hast, gilt weiter.",
  rejectAll: "Alle ablehnen",
  requires: "Erfordert",
  restricted: "Das blockiert das Datenschutzsignal deines Browsers.",
  retryPersistence: "Erneut speichern",
  save: "Auswahl speichern",
  title: "Deine Wahl, klar und deutlich.",
  withdrawConsent: "Einwilligung widerrufen",
});
