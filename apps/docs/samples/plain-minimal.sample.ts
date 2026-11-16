import { Window } from "happy-dom";

// docs:consumer-path: fresh/index.html
// docs:display:start
export const minimalPage = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenCookie example</title>
  </head>
  <body>
    <main><h1>OpenCookie example</h1></main>
  </body>
</html>`;
// docs:display:end

export function run(): void {
  const window = new Window();
  window.document.write(minimalPage);
  if (
    window.document.documentElement.lang !== "en" ||
    window.document.querySelector("main > h1")?.textContent !==
      "OpenCookie example"
  ) {
    throw new Error("The minimal plain HTML scaffold is incomplete.");
  }
  window.close();
}
