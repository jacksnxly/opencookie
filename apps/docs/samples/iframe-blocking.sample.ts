import { Window } from "happy-dom";

// docs:consumer-path: src/iframe-blocking.ts
// docs:display:start
import { createBlockedIframeController } from "@opencookie-dev/vanilla";

export const blockedVideoMarkup = `<template
  data-oc-iframe
  title="Product video"
  data-oc-category="marketing"
  data-oc-resource="product-video"
  data-src="https://video.example.test/embed/42"
></template>`;

export function protectVideo(document: Document) {
  return createBlockedIframeController({
    category: "marketing",
    document,
    resourceId: "product-video",
  });
}
// docs:display:end

export async function run(): Promise<void> {
  const window = new Window();
  window.document.body.innerHTML = blockedVideoMarkup;
  const controller = protectVideo(window.document as unknown as Document);
  if ((await controller.discover()) !== "blocked") {
    throw new Error("The iframe started before consent.");
  }
  await controller.start();
  const iframe = window.document.querySelector(
    'iframe[data-oc-active-resource="product-video"]',
  );
  if (iframe?.getAttribute("src") !== "https://video.example.test/embed/42") {
    throw new Error("The iframe did not activate after consent.");
  }
  window.close();
}
