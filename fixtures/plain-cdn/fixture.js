/* global document, history */

const routeButton = document.querySelector("#add-resource");
const status = document.querySelector("#fixture-status");
let routeSequence = 0;

routeButton?.addEventListener("click", () => {
  routeSequence += 1;
  history.pushState({}, "", `/spa/${String(routeSequence)}`);
  const script = document.createElement("script");
  script.type = "text/plain";
  script.dataset.ocResource = "analytics-script";
  script.dataset.ocCategory = "analytics";
  script.dataset.src = `http://tracker.plain-cdn.opencookie.test:4400/analytics.js?resource=dynamic-${String(routeSequence)}`;
  document.head.append(script);
  if (status !== null)
    status.textContent = `Dynamic route ${String(routeSequence)}`;
});
