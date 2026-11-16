import { Window } from "happy-dom";

import { scanStorageSnapshot } from "opencookie";

// docs:consumer-path: snapshot-storage.ts
// docs:display:start
export const storageSnapshotSnippet = String.raw`copy(
  JSON.stringify({
    page: location.href,
    recordedAt: new Date().toISOString(),
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }),
);`;
// docs:display:end

export function run(): void {
  // The snippet runs in the operator's browser, so it is executed here against
  // a browser's own storage rather than transcribed. The parser must accept
  // exactly what it produces, or the recipe is broken the day someone uses it.
  const window = new Window({ url: "https://shop.example.test/checkout" });
  const { localStorage, sessionStorage } = window;
  localStorage.setItem("_ga", "GA1.1");
  sessionStorage.setItem("checkout-step", "2");

  const produced = JSON.stringify({
    local: Object.keys(localStorage),
    page: window.location.href,
    recordedAt: new Date(1_790_000_000_000).toISOString(),
    session: Object.keys(sessionStorage),
  });

  const observations = scanStorageSnapshot(produced, "Safari 26.0");
  const names = observations.map((observation) => observation.name).sort();
  if (names.join("|") !== "local:_ga|session:checkout-step") {
    throw new Error(`The snapshot snippet produced ${names.join("|")}.`);
  }
  if (!storageSnapshotSnippet.includes("Object.keys(localStorage)")) {
    throw new Error("The published snippet no longer reads local storage.");
  }
  window.close();
}
